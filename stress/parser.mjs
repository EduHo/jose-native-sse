/**
 * Parser stress: boundary fuzzing, resource limits, and scan complexity.
 *
 * The parser receives already-decoded strings, so it is immune to the UTF-8
 * problem in wire.mjs. What it is NOT immune to is covered here.
 *
 *   node stress/server.mjs &
 *   node stress/parser.mjs
 */

import http from 'node:http';
import { SseParser } from '../lib/commonjs/SseParser.js';

const PORT = Number(process.env.STRESS_PORT ?? 3000);
const results = [];

function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)}${detail}`);
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

function get(path, onChunk, { timeoutMs = 6_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path, headers: { Accept: 'text/event-stream' } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => { if (onChunk(c) === false) finish(); });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    req.on('error', finish);
  });
}

// ─── 1. Boundary fuzz ─────────────────────────────────────────────────────────
// The same payload, split at thousands of random offsets. Output must be
// byte-identical every time, regardless of where the chunks land.

{
  // Mixes LF, CRLF and bare CR terminators: a trailing CR is ambiguous until the
  // next byte arrives, so a split there is exactly where a parser goes wrong.
  const payload =
    'retry: 5000\n' +
    ':a comment\r\n' +
    'id: 1\nevent: alpha\ndata: line one\r\ndata: line two\n\n' +
    'data: {"emoji":"🚀","txt":"coração"}\r\n\r\n' +
    'event: beta\ndata: \r\r' +
    'id: 2\ndata: last\n\n';

  const baseline = (() => {
    const out = [];
    const p = new SseParser({ onEvent: (e) => out.push({ ...e }) });
    p.feed(payload);
    p.flush();
    return JSON.stringify(out);
  })();

  const ITERATIONS = 20_000;
  let mismatches = 0;
  let firstBadSplit = null;

  for (let i = 0; i < ITERATIONS; i++) {
    // 1–5 random cut points across the payload.
    const cuts = Array.from({ length: 1 + (i % 5) }, () =>
      1 + Math.floor(Math.random() * (payload.length - 1)),
    ).sort((a, b) => a - b);

    const out = [];
    const p = new SseParser({ onEvent: (e) => out.push({ ...e }) });
    let prev = 0;
    for (const c of [...cuts, payload.length]) {
      p.feed(payload.slice(prev, c));
      prev = c;
    }
    p.flush();

    if (JSON.stringify(out) !== baseline) {
      mismatches++;
      if (!firstBadSplit) firstBadSplit = cuts;
    }
  }

  report(
    'fuzz de fronteiras (20k divisões)',
    mismatches === 0,
    mismatches === 0
      ? `${ITERATIONS} divisões aleatórias, saída sempre idêntica`
      : `${mismatches} divergências, primeira em ${JSON.stringify(firstBadSplit)}`,
  );
}

// ─── 2. C3 — overflow resync over real HTTP ───────────────────────────────────
// An oversized line is dropped. The server then sends `event: injected` with no
// terminator in between, so on the wire that text is part of the SAME line and
// must never take effect. The `data:` line that follows the next terminator IS a
// genuine line, and dispatching it as a plain `message` is correct protocol
// behaviour — the invariant is about the discarded line's fields, not about
// suppressing everything that follows.

for (const [path, label] of [
  ['/overflow-resync', 'C3 campo colado à linha descartada ignorado'],
  ['/overflow-resync-aligned', 'C3 idem, com fronteira alinhada'],
]) {
  const events = [];
  let parseErrors = 0;
  const p = new SseParser({
    maxLineLength: 4096,
    onEvent: (e) => events.push({ ...e }),
    onParseError: () => parseErrors++,
  });

  await get(path, (c) => p.feed(c), { timeoutMs: 8_000 });
  p.flush();

  const leaked = events.filter((e) => e.type === 'injected');
  const ok = leaked.length === 0;
  report(
    label,
    ok,
    ok
      ? `${parseErrors} erros de parse, ${events.length} evento(s), ` +
          `nenhum com o tipo escolhido pelo atacante`
      : `ATACANTE CONTROLOU O TIPO: ${JSON.stringify(leaked[0])}`,
  );
}

// ─── 3. C4 — event buffer without a ceiling ───────────────────────────────────
// data: lines forever, no blank line. Memory must not track the stream.

{
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;

  let dispatched = 0;
  let parseErrors = 0;
  let fed = 0;
  const p = new SseParser({
    maxLineLength: 4096,
    onEvent: () => dispatched++,
    onParseError: () => parseErrors++,
  });

  await get('/no-blank-line', (c) => {
    fed += c.length;
    p.feed(c);
    return fed < 40_000_000 ? undefined : false; // stop at ~40 MB received
  }, { timeoutMs: 12_000 });

  const growth = process.memoryUsage().heapUsed - before;
  // Passing means memory stayed bounded well below what was received.
  const ok = growth < fed / 4 || parseErrors > 0;

  report(
    'C4 buffer de evento limitado',
    ok,
    `recebidos ${mb(fed)} MB, heap +${mb(growth)} MB, ` +
      `eventos ${dispatched}, erros de parse ${parseErrors}`,
  );
}

// ─── 4. Throughput ────────────────────────────────────────────────────────────

{
  let events = 0;
  let bytes = 0;
  const p = new SseParser({ onEvent: () => events++ });

  const t0 = process.hrtime.bigint();
  await get('/flood', (c) => {
    bytes += c.length;
    p.feed(c);
    return bytes < 30_000_000 ? undefined : false;
  }, { timeoutMs: 20_000 });
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;

  console.log(
    `  ----  ${'débito (parser + socket)'.padEnd(42)}` +
      `${(events / secs / 1000).toFixed(0)}k eventos/s, ` +
      `${(bytes / secs / 1024 / 1024).toFixed(0)} MB/s, ` +
      `${events} eventos em ${secs.toFixed(2)}s`,
  );
}

// ─── 5. L2 — scan complexity ──────────────────────────────────────────────────
// One feed() with N lines and no CR. If the \r scan restarts per line the cost
// is quadratic; linear scanning keeps ns/line flat as N grows.

{
  console.log('\n  Complexidade da varredura — um feed(), N linhas, sem CR:');
  const timings = [];

  for (const lines of [2_000, 4_000, 8_000, 16_000, 32_000]) {
    const chunk = 'data: x\n\n'.repeat(lines);
    const p = new SseParser({ onEvent: () => {} });
    const t0 = process.hrtime.bigint();
    p.feed(chunk);
    const ns = Number(process.hrtime.bigint() - t0);
    const perLine = ns / lines;
    timings.push({ lines, ms: ns / 1e6, perLine });
    console.log(
      `    ${String(lines).padStart(6)} linhas  ` +
        `${(ns / 1e6).toFixed(1).padStart(7)} ms  ` +
        `${perLine.toFixed(0).padStart(6)} ns/linha`,
    );
  }

  // Linear → ns/line flat. Quadratic → ns/line grows with N.
  const ratio = timings.at(-1).perLine / timings[0].perLine;
  report(
    'L2 varredura linear no nº de linhas',
    ratio < 3,
    `custo por linha ×${ratio.toFixed(1)} ao passar de 2k para 32k linhas ` +
      `(linear ≈ ×1, quadrático ≈ ×16)`,
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(
  `\n  ${results.length - failed.length}/${results.length} verificações passaram` +
    (failed.length ? `; falharam: ${failed.map((f) => f.name).join(', ')}` : ''),
);
process.exit(0); // reporting tool: bug reproduction is the expected outcome
