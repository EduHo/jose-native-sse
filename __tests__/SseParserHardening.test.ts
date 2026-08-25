/**
 * Regression tests for the parser hardening found in the code audit.
 *
 * Each block names the finding it locks down. The stress suite in stress/
 * demonstrates the same defects against a live socket; these are the fast,
 * deterministic versions that run in CI.
 */

import { SseParser } from '../src/SseParser';
import type { ParsedEvent, SseParserOptions } from '../src/SseParser';

function makeParser(options: SseParserOptions = {}) {
  const events: ParsedEvent[] = [];
  const retries: number[] = [];
  const errors: string[] = [];

  const parser = new SseParser({
    onEvent: (e) => events.push(e),
    onRetry: (ms) => retries.push(ms),
    onParseError: (msg) => errors.push(msg),
    ...options,
  });

  return { parser, events, retries, errors };
}

// ─── C3 — line resynchronisation after an overflow ───────────────────────────

describe('C3 — oversized line does not leak fields', () => {
  it('ignores a field glued to the tail of a discarded line', () => {
    const { parser, events, errors } = makeParser({ maxLineLength: 32 });

    // One oversized line with no terminator: the buffer is dropped.
    parser.feed('data: ' + 'A'.repeat(200));
    // The tail of that SAME line arrives next. `event: injected` sits on the
    // discarded line, so it must not take effect — but `data: forged` follows a
    // real terminator and is a genuine line.
    parser.feed('event: injected\ndata: forged\n\n');

    expect(errors.length).toBeGreaterThan(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message');
    expect(events[0]!.type).not.toBe('injected');
  });

  it('discards every field of a multi-chunk oversized line', () => {
    const { parser, events } = makeParser({ maxLineLength: 16 });

    // One logical line spanning three chunks, with no terminator anywhere in it.
    // `id: 999` and `event: spoofed` are part of that line, not lines of their
    // own, so neither may take effect.
    parser.feed('data: ' + 'B'.repeat(100));
    parser.feed('C'.repeat(100));
    parser.feed('id: 999event: spoofed');
    // The first terminator resynchronises; what follows it is genuine input.
    parser.feed('\ndata: real\n\n');

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('real');
    expect(events[0]!.type).toBe('message');
    expect(events[0]!.id).toBeNull();
    expect(parser.getLastEventId()).toBe('');
  });

  it('treats input after the resync terminator as genuine lines', () => {
    const { parser, events } = makeParser({ maxLineLength: 16 });

    parser.feed('data: ' + 'D'.repeat(100)); // dropped
    // `event: real` follows a terminator, so it IS a line the server sent and
    // must be honoured. The invariant is about the discarded line's own fields.
    parser.feed('\nevent: real\ndata: ok\n\n');

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('real');
    expect(events[0]!.data).toBe('ok');
  });

  it('stays in overflow across several terminator-free chunks', () => {
    const { parser, events } = makeParser({ maxLineLength: 8 });

    for (let i = 0; i < 5; i++) parser.feed('X'.repeat(50));
    parser.feed('event: nope\n');
    parser.feed('data: ok\n\n');

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message');
  });

  it('never parses a discarded line on flush()', () => {
    const { parser, events } = makeParser({ maxLineLength: 8 });

    parser.feed('data: ' + 'Z'.repeat(100));
    parser.flush();

    expect(events).toHaveLength(0);
  });
});

// ─── C4 — bounded event accumulation ─────────────────────────────────────────

describe('C4 — event payload is capped', () => {
  it('discards an event whose data exceeds maxEventSize', () => {
    const { parser, events, errors } = makeParser({ maxEventSize: 100 });

    for (let i = 0; i < 50; i++) parser.feed('data: ' + 'x'.repeat(20) + '\n');
    parser.feed('\n');

    expect(errors.some((e) => e.includes('max size'))).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('recovers on the next event after discarding an oversized one', () => {
    const { parser, events } = makeParser({ maxEventSize: 50 });

    parser.feed('data: ' + 'y'.repeat(200) + '\n\n'); // discarded
    parser.feed('data: small\n\n'); // must still work

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('small');
  });

  it('keeps a stream with no blank line from growing without bound', () => {
    const { parser, events, errors } = makeParser({ maxEventSize: 1000 });

    // 100 KB of data lines and never a blank line.
    for (let i = 0; i < 1000; i++) parser.feed('data: ' + 'q'.repeat(100) + '\n');

    expect(events).toHaveLength(0);
    expect(errors.some((e) => e.includes('max size'))).toBe(true);
  });
});

// ─── S3 — id length is capped ────────────────────────────────────────────────

describe('S3 — event id is capped', () => {
  it('ignores an id longer than maxIdLength', () => {
    const { parser, events, errors } = makeParser({ maxIdLength: 16 });

    parser.feed('id: ' + 'a'.repeat(100) + '\ndata: hi\n\n');

    expect(errors.some((e) => e.includes('id exceeds'))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBeNull();
    expect(parser.getLastEventId()).toBe('');
  });

  it('accepts an id at the limit', () => {
    const { parser, events } = makeParser({ maxIdLength: 8 });

    parser.feed('id: 12345678\ndata: hi\n\n');
    expect(events[0]!.id).toBe('12345678');
  });
});

// ─── C2 — retry values the caller can safely schedule ────────────────────────

describe('C2 — retry parsing', () => {
  it('accepts a plain integer', () => {
    const { parser, retries } = makeParser();
    parser.feed('retry: 2500\n\n');
    expect(retries).toEqual([2500]);
  });

  it('rejects a value that overflows to Infinity', () => {
    const { parser, retries, errors } = makeParser();

    // 400 digits parses to Infinity, and setTimeout(fn, Infinity) collapses to
    // roughly 1ms — a hot reconnect loop rather than a long wait.
    parser.feed('retry: ' + '9'.repeat(400) + '\n\n');

    expect(retries).toEqual([]);
    expect(errors.some((e) => e.includes('non-finite'))).toBe(true);
  });

  it('ignores non-numeric values', () => {
    const { parser, retries } = makeParser();
    parser.feed('retry: soon\n\n');
    parser.feed('retry: -100\n\n');
    parser.feed('retry: 1e5\n\n');
    expect(retries).toEqual([]);
  });

  it('reports 0 so the caller can clamp it', () => {
    const { parser, retries } = makeParser();
    parser.feed('retry: 0\n\n');
    expect(retries).toEqual([0]);
  });
});

// ─── L2 — linear line scanning ───────────────────────────────────────────────

describe('L2 — scan cost is linear in line count', () => {
  it('does not rescan the buffer for CR on every line', () => {
    const once = (lines: number): number => {
      const chunk = 'data: x\n\n'.repeat(lines);
      const { parser } = makeParser();
      const t0 = process.hrtime.bigint();
      parser.feed(chunk);
      return Number(process.hrtime.bigint() - t0) / lines;
    };

    // Minimum of several runs: a single sample is dominated by GC and scheduler
    // noise, while the floor is a stable estimate of the real cost.
    const measure = (lines: number): number =>
      Math.min(once(lines), once(lines), once(lines));

    once(2000); // warm the JIT so this is not measuring compilation
    const small = measure(4000);
    const large = measure(32_000);

    // Flat per-line cost means linear. The quadratic version grew it ~8-16x
    // across this range, so the threshold is generous enough not to flake while
    // still catching a regression. stress/parser.mjs reports the full curve.
    expect(large / small).toBeLessThan(5);
  });
});
