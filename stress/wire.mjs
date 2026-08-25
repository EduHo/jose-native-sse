/**
 * Wire-level stress: real HTTP, real chunk boundaries, three decoders.
 *
 * Pulls raw Buffers off a live socket and runs each byte chunk through the two
 * decode strategies the native layers actually use, plus a correct incremental
 * one. Each decoder's output is fed into the real SseParser from lib/, and the
 * resulting events are compared against what the server sent.
 *
 * This is the difference between "splitting a string mid-character corrupts it"
 * (obvious) and "the shipped native code corrupts real traffic" (the claim).
 *
 *   node stress/server.mjs &
 *   node stress/wire.mjs
 */

import http from 'node:http';
import { SseParser } from '../lib/commonjs/SseParser.js';

const PORT = Number(process.env.STRESS_PORT ?? 3000);
const EXPECTED_DATA = 'Olá coração — 汉字 🚀 ãõç';
const EXPECTED_COUNT = 50;

// ─── Decoders under test ──────────────────────────────────────────────────────

/**
 * Android: `String(buffer, 0, bytesRead, Charsets.UTF_8)`.
 * Java substitutes U+FFFD for malformed input — data survives, mangled.
 */
function makeAndroidDecoder() {
  return (buf) => buf.toString('utf8');
}

/**
 * iOS: `String(data: data, encoding: .utf8)` returns nil for invalid input, and
 * SseConnection.swift has no else branch — so the chunk is dropped entirely.
 */
function makeIosDecoder(stats) {
  const strict = new TextDecoder('utf-8', { fatal: true });
  return (buf) => {
    try {
      return strict.decode(buf);
    } catch {
      stats.droppedChunks++;
      stats.droppedBytes += buf.length;
      return ''; // nil → onChunk never called
    }
  };
}

/** Correct: a streaming decoder that carries partial sequences across chunks. */
function makeIncrementalDecoder() {
  const dec = new TextDecoder('utf-8');
  return (buf) => dec.decode(buf, { stream: true });
}

// ─── Harness ──────────────────────────────────────────────────────────────────

/** Collect raw byte chunks from an SSE endpoint, exactly as the socket yields them. */
function captureChunks(path, { maxChunks = Infinity, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(chunks);
    };

    const timer = setTimeout(finish, timeoutMs);

    const req = http.get(
      { host: '127.0.0.1', port: PORT, path, headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error(`${path} → HTTP ${res.statusCode}`));
          return;
        }
        // No setEncoding: we want Buffers, not pre-decoded strings.
        res.on('data', (buf) => {
          chunks.push(buf);
          if (chunks.length >= maxChunks) finish();
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    req.on('error', finish);
  });
}

/** Run captured byte chunks through a decoder, then through the real parser. */
function replay(chunks, decode) {
  const events = [];
  const parser = new SseParser({ onEvent: (e) => events.push({ ...e }) });
  for (const buf of chunks) {
    const text = decode(buf);
    if (text) parser.feed(text);
  }
  parser.flush();
  return events;
}

function grade(label, events, extra = '') {
  const intact = events.filter((e) => e.data === EXPECTED_DATA).length;
  const corrupt = events.length - intact;
  const missing = EXPECTED_COUNT - events.length;
  const ok = intact === EXPECTED_COUNT && corrupt === 0 && missing === 0;

  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(31)}` +
      `eventos ${String(events.length).padStart(3)}/${EXPECTED_COUNT}` +
      `  íntegros ${String(intact).padStart(3)}` +
      `  corrompidos ${String(corrupt).padStart(3)}` +
      `  perdidos ${String(missing).padStart(3)}` +
      (extra ? `  ${extra}` : ''),
  );

  const sample = events.find((e) => e.data !== EXPECTED_DATA);
  if (sample) console.log(`        exemplo corrompido: ${JSON.stringify(sample.data.slice(0, 60))}`);

  return ok;
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

async function scenario(path, title) {
  const chunks = await captureChunks(path);
  const bytes = chunks.reduce((n, b) => n + b.length, 0);

  console.log(`\n${title}`);
  console.log(`  ${chunks.length} chunks TCP, ${bytes} bytes, ` +
              `mediana ${median(chunks.map((b) => b.length))} B/chunk`);

  const iosStats = { droppedChunks: 0, droppedBytes: 0 };

  const results = {
    android: grade('ANTIGO Android String(bytes)', replay(chunks, makeAndroidDecoder())),
    ios: grade('ANTIGO iOS String(data:enc:)', replay(chunks, makeIosDecoder(iosStats)),
      `chunks nil ${iosStats.droppedChunks} (${iosStats.droppedBytes} B descartados)`),
    correct: grade('ACTUAL decoder incremental', replay(chunks, makeIncrementalDecoder())),
  };
  return results;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const failures = [];

console.log('═══ Stress de fronteira UTF-8 sobre HTTP real ═══');
console.log('As linhas ANTIGO reproduzem as estratégias que o código nativo usava');
console.log('antes da correcção: espera-se que falhem — é o defeito documentado.');
console.log('Só a linha ACTUAL representa o comportamento enviado hoje.');

const split = await scenario(
  '/utf8-split',
  'CENÁRIO A — servidor descarrega em fatias de 7 bytes (corta dentro dos caracteres)',
);
if (!split.correct) failures.push('decoder incremental falhou no cenário A');

const whole = await scenario(
  '/utf8-whole',
  'CENÁRIO B — controlo: mesmo payload, frames inteiros (o SO ainda pode fragmentar)',
);
if (!whole.correct) failures.push('decoder incremental falhou no cenário B');

// ─── Verdict ──────────────────────────────────────────────────────────────────

console.log('\n═══ Veredicto ═══');
const androidBroken = !split.android;
const iosBroken = !split.ios;

console.log(`  Estratégia antiga Android corrompia: ${androidBroken ? 'SIM' : 'não'}`);
console.log(`  Estratégia antiga iOS descartava:    ${iosBroken ? 'SIM' : 'não'}`);
console.log(`  Decoder incremental actual resiste:  ${split.correct && whole.correct ? 'SIM' : 'NAO'}`);

if (!androidBroken && !iosBroken) {
  console.log('\n  Nota: nenhum decoder falhou — o SO entregou os chunks alinhados.');
  console.log('  Sobe a fragmentação no servidor (fatias mais pequenas) e repete.');
}

process.exit(failures.length ? 1 : 0);
