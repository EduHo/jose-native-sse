/**
 * Adversarial SSE server for the stress suite.
 *
 * Every endpoint writes Buffers, never strings, so chunk boundaries land on
 * exact byte offsets — that is what makes the UTF-8 boundary cases reproducible
 * instead of accidental.
 *
 *   node stress/server.mjs [port]
 */

import http from 'node:http';

const PORT = Number(process.argv[2] ?? 3000);

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Text with 2-, 3- and 4-byte UTF-8 sequences: the shapes that break decoders. */
const MULTIBYTE = 'Olá coração — 汉字 🚀 ãõç';

// ─── Endpoints ────────────────────────────────────────────────────────────────

const routes = {
  /** Liveness probe used by the existing e2e suite. */
  '/health': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  },

  /** Well-behaved stream. Baseline for the e2e suite. */
  '/events': async (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(Buffer.from('retry: 2000\n\n', 'utf8'));
    for (let i = 1; !res.writableEnded; i++) {
      res.write(Buffer.from(`id: ${i}\nevent: tick\ndata: {"n":${i}}\n\n`, 'utf8'));
      await sleep(40);
      if (i >= 200) break;
    }
    res.end();
  },

  /**
   * C1 — every event is split mid-character.
   *
   * The payload is encoded to bytes, then flushed one byte at a time around
   * each multi-byte sequence, forcing a partial sequence at the tail of a
   * chunk. A correct client reassembles; a per-chunk decoder corrupts or drops.
   */
  '/utf8-split': async (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    for (let i = 1; i <= 50 && !res.writableEnded; i++) {
      const frame = Buffer.from(`id: ${i}\ndata: ${MULTIBYTE}\n\n`, 'utf8');
      // Flush in 7-byte slices: coprime with the 1/2/3/4-byte sequence widths,
      // so boundaries land inside characters rather than between them.
      for (let off = 0; off < frame.length; off += 7) {
        res.write(frame.subarray(off, Math.min(off + 7, frame.length)));
        await sleep(1);
      }
      await sleep(5);
    }
    res.end();
  },

  /** C1 control: identical payload, but flushed as whole frames. */
  '/utf8-whole': async (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    for (let i = 1; i <= 50 && !res.writableEnded; i++) {
      res.write(Buffer.from(`id: ${i}\ndata: ${MULTIBYTE}\n\n`, 'utf8'));
      await sleep(6);
    }
    res.end();
  },

  /** C2 — server pins the reconnect delay to zero, then hangs up. */
  '/retry-zero': (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(Buffer.from('retry: 0\ndata: hello\n\n', 'utf8'));
    res.end();
  },

  /** C2 — retry so large it overflows to Infinity in parseInt. */
  '/retry-huge': (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(Buffer.from(`retry: ${'9'.repeat(400)}\ndata: hello\n\n`, 'utf8'));
    res.end();
  },

  /**
   * C3 — an oversized line with no terminator, then a tail crafted to look
   * like a fresh set of SSE fields once the client drops the buffer.
   *
   * Whatever remains of the giant line below the client's limit stays in its
   * buffer and gets glued to the head of the tail, so the first field of the
   * tail is usually mangled while the rest injects cleanly.
   */
  '/overflow-resync': async (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(Buffer.from('data: ' + 'A'.repeat(200_000), 'utf8'));
    await sleep(50);
    res.write(Buffer.from('event: injected\ndata: forged\n\n', 'utf8'));
    await sleep(50);
    res.end();
  },

  /**
   * C3 — the same attack, but the final pre-tail flush is itself large enough
   * to trip the overflow drop on its own. That leaves the client's buffer empty
   * at a known point, so the tail lands at a true line start and the attacker
   * also controls `event:`.
   */
  '/overflow-resync-aligned': async (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(Buffer.from('data: ' + 'A'.repeat(200_000), 'utf8'));
    await sleep(60);
    // A standalone block well above any plausible maxLineLength: forces a drop
    // and an empty buffer without leaving a sub-limit remainder behind.
    res.write(Buffer.from('B'.repeat(2_000_000), 'utf8'));
    await sleep(120);
    res.write(Buffer.from('event: injected\ndata: forged\n\n', 'utf8'));
    await sleep(60);
    res.end();
  },

  /** C4 — data lines forever, never a blank line, so nothing ever dispatches. */
  '/no-blank-line': async (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    // 64 KB per write: enough to actually stress memory rather than the loop.
    const block = Buffer.from(('data: ' + 'x'.repeat(250) + '\n').repeat(256), 'utf8');
    while (!res.writableEnded) {
      if (!res.write(block)) await new Promise((r) => res.once('drain', r));
    }
  },

  /** Throughput: events as fast as the socket accepts them. */
  '/flood': async (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    let i = 0;
    while (!res.writableEnded && i < 200_000) {
      i++;
      const ok = res.write(Buffer.from(`id: ${i}\ndata: ${MULTIBYTE} #${i}\n\n`, 'utf8'));
      if (!ok) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  },

  /** Opens, then goes silent forever: exercises stale detection. */
  '/silent': (_req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(Buffer.from(':ok\n\n', 'utf8'));
  },

  /** Fatal 4xx: must not be retried. */
  '/forbidden': (_req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
  },
};

// ─── Server ───────────────────────────────────────────────────────────────────

let connections = 0;
const hits = new Map();

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  hits.set(path, (hits.get(path) ?? 0) + 1);
  connections++;

  const handler = routes[path];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  req.on('close', () => { /* client hung up; loops observe writableEnded */ });
  Promise.resolve(handler(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// Never let Node kill a deliberately-idle SSE socket.
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stress-server] http://127.0.0.1:${PORT}`);
  console.log(`[stress-server] routes: ${Object.keys(routes).join(' ')}`);
});

// `/__stats` is intentionally not a route: dump on SIGINT instead.
process.on('SIGINT', () => {
  console.log(`\n[stress-server] total requests: ${connections}`);
  for (const [p, n] of [...hits].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${p}`);
  }
  server.close(() => process.exit(0));
});
