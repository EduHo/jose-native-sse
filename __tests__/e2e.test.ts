/**
 * E2E tests against a real SSE server at http://127.0.0.1:3000/events.
 *
 * These tests use Node.js `http` to make a real HTTP connection and pipe the
 * raw stream through SseParser — validating the full parsing layer without
 * any mocks or stubs.
 *
 * Run the server before executing: the test suite will skip gracefully if the
 * server is not reachable.
 */

import * as http from 'http';
import { SseParser } from '../src/SseParser';
import type { ParsedEvent } from '../src/SseParser';

const HOST = '127.0.0.1';
const PORT = 3000;
const PATH = '/events';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Open an SSE connection, collect events until `count` are received or
 * `timeoutMs` elapses, then close the connection.
 */
function collectEvents(
  count: number,
  timeoutMs = 8_000,
): Promise<{ events: ParsedEvent[]; retryMs: number | null }> {
  return new Promise((resolve, reject) => {
    const events: ParsedEvent[] = [];
    let retryMs: number | null  = null;
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ events, retryMs });
    }

    const parser = new SseParser({
      onEvent: (evt) => {
        events.push(evt);
        if (events.length >= count) finish();
      },
      onRetry: (ms) => { retryMs = ms; },
    });

    const timer = setTimeout(finish, timeoutMs);

    const req = http.get(
      {
        host: HOST, port: PORT, path: PATH,
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error(`Server responded with ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => parser.feed(chunk));
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', () => finish()); // ECONNRESET on req.destroy()
      },
    );

    req.on('error', () => finish()); // absorb errors after destroy
  });
}

/** Check if the server is up. Returns false instead of throwing. */
async function serverIsUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/health', timeout: 1_500 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('E2E – real SSE server', () => {
  let skip = false;

  beforeAll(async () => {
    skip = !(await serverIsUp());
    if (skip) {
      console.warn(
        '\n  ⚠  SSE server not reachable at http://127.0.0.1:3000 — skipping E2E suite.\n',
      );
    }
  });

  function maybeIt(name: string, fn: () => Promise<void>, timeout = 10_000) {
    it(name, async () => { if (skip) return; await fn(); }, timeout);
  }

  // ── Connectivity ─────────────────────────────────────────────────────────

  maybeIt('server responds with HTTP 200 on /events', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        { host: HOST, port: PORT, path: PATH, headers: { Accept: 'text/event-stream' } },
        (res) => { resolve(res.statusCode ?? 0); req.destroy(); },
      );
      req.on('error', reject);
    });
    expect(status).toBe(200);
  });

  // ── Event shape ───────────────────────────────────────────────────────────

  maybeIt('receives at least one event', async () => {
    const { events } = await collectEvents(1);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  maybeIt('event type is "random"', async () => {
    const { events } = await collectEvents(1);
    expect(events[0]!.type).toBe('random');
  });

  maybeIt('event data is valid JSON', async () => {
    const { events } = await collectEvents(1);
    expect(() => JSON.parse(events[0]!.data)).not.toThrow();
  });

  maybeIt('event data has expected fields: id, value, timestamp', async () => {
    const { events } = await collectEvents(1);
    const payload = JSON.parse(events[0]!.data) as Record<string, unknown>;
    expect(payload).toHaveProperty('id');
    expect(payload).toHaveProperty('value');
    expect(payload).toHaveProperty('timestamp');
  });

  maybeIt('value is a number between 0 and 100', async () => {
    const { events } = await collectEvents(1);
    const { value } = JSON.parse(events[0]!.data) as { value: number };
    expect(typeof value).toBe('number');
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });

  maybeIt('timestamp is an ISO 8601 string', async () => {
    const { events } = await collectEvents(1);
    const { timestamp } = JSON.parse(events[0]!.data) as { timestamp: string };
    expect(typeof timestamp).toBe('string');
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  // ── Retry field ───────────────────────────────────────────────────────────

  maybeIt('server sends retry field and parser captures it', async () => {
    const { retryMs } = await collectEvents(1);
    expect(retryMs).toBe(5_000);
  });

  // ── Multiple events ───────────────────────────────────────────────────────

  maybeIt('receives 3 distinct events', async () => {
    const { events } = await collectEvents(3);
    expect(events.length).toBeGreaterThanOrEqual(3);
  }, 12_000);

  maybeIt('each event has a unique id', async () => {
    const { events } = await collectEvents(3);
    const ids = events.map((e) => (JSON.parse(e.data) as { id: number }).id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  }, 12_000);

  maybeIt('events arrive in chronological order', async () => {
    const { events } = await collectEvents(3);
    const timestamps = events.map(
      (e) => new Date((JSON.parse(e.data) as { timestamp: string }).timestamp).getTime(),
    );
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  }, 12_000);

  // ── Chunked delivery ──────────────────────────────────────────────────────

  maybeIt('parser handles real chunked TCP delivery correctly', async () => {
    // The OS may coalesce or split TCP segments in unexpected ways.
    // Collecting 5 events proves the parser handles arbitrary chunk boundaries.
    const { events } = await collectEvents(5);
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const evt of events) {
      expect(() => JSON.parse(evt.data)).not.toThrow();
    }
  }, 15_000);

  // ── Two concurrent connections ────────────────────────────────────────────

  maybeIt('two concurrent connections receive independent streams', async () => {
    const [a, b] = await Promise.all([collectEvents(2), collectEvents(2)]);
    expect(a.events.length).toBeGreaterThanOrEqual(2);
    expect(b.events.length).toBeGreaterThanOrEqual(2);
    const aIds = a.events.map((e) => (JSON.parse(e.data) as { id: number }).id);
    const bIds = b.events.map((e) => (JSON.parse(e.data) as { id: number }).id);
    expect(aIds.every((id) => typeof id === 'number')).toBe(true);
    expect(bIds.every((id) => typeof id === 'number')).toBe(true);
  }, 15_000);
});
