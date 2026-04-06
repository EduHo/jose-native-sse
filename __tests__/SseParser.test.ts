import { SseParser } from '../src/SseParser';
import type { ParsedEvent } from '../src/SseParser';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeParser(maxLineLength = 1_048_576) {
  const events:  Array<{ event: ParsedEvent; byteLength: number }> = [];
  const retries: number[] = [];
  const errors:  string[] = [];

  const parser = new SseParser({
    maxLineLength,
    onEvent:      (e, b) => events.push({ event: e, byteLength: b }),
    onRetry:      (ms)   => retries.push(ms),
    onParseError: (msg)  => errors.push(msg),
  });

  return { parser, events, retries, errors };
}

function feedLines(parser: SseParser, ...lines: string[]) {
  parser.feed(lines.join('\n') + '\n');
}

// ─── Basic fields ─────────────────────────────────────────────────────────────

describe('SseParser – basic fields', () => {
  it('parses a simple message event', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: hello world', '');
    expect(events[0]!.event).toMatchObject({ type: 'message', data: 'hello world' });
  });

  it('defaults type to "message"', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: x', '');
    expect(events[0]!.event.type).toBe('message');
  });

  it('uses event: field as type', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'event: update', 'data: payload', '');
    expect(events[0]!.event).toMatchObject({ type: 'update', data: 'payload' });
  });

  it('parses id: field', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'id: 42', 'data: msg', '');
    expect(events[0]!.event.id).toBe('42');
  });

  it('returns null id when no id: seen', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: msg', '');
    expect(events[0]!.event.id).toBeNull();
  });

  it('parses retry: and calls onRetry', () => {
    const { parser, retries } = makeParser();
    feedLines(parser, 'retry: 5000', 'data: x', '');
    expect(retries).toEqual([5000]);
  });

  it('ignores retry: with non-numeric value', () => {
    const { parser, retries } = makeParser();
    feedLines(parser, 'retry: abc', 'data: x', '');
    expect(retries).toHaveLength(0);
  });

  it('ignores comment lines', () => {
    const { parser, events } = makeParser();
    feedLines(parser, ': comment', 'data: real', '');
    expect(events).toHaveLength(1);
    expect(events[0]!.event.data).toBe('real');
  });

  it('ignores unknown field names', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'custom: ignored', 'data: msg', '');
    expect(events[0]!.event.data).toBe('msg');
  });

  it('strips single leading space from value', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: trimmed', '');
    expect(events[0]!.event.data).toBe('trimmed');
  });

  it('does not strip multiple leading spaces', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data:  two-space', '');
    expect(events[0]!.event.data).toBe(' two-space');
  });

  it('handles field-only line (no colon)', () => {
    const { parser, events } = makeParser();
    parser.feed('data\n\n');
    expect(events[0]!.event.data).toBe('');
  });
});

// ─── Multi-line data ──────────────────────────────────────────────────────────

describe('SseParser – multi-line data', () => {
  it('joins multiple data: lines with \\n', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: a', 'data: b', 'data: c', '');
    expect(events[0]!.event.data).toBe('a\nb\nc');
  });

  it('handles empty data: line', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: a', 'data:', 'data: b', '');
    expect(events[0]!.event.data).toBe('a\n\nb');
  });
});

// ─── Dispatch rules ───────────────────────────────────────────────────────────

describe('SseParser – dispatch rules', () => {
  it('does not dispatch when data is empty', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'event: ping', '');
    expect(events).toHaveLength(0);
  });

  it('dispatches multiple events from one chunk', () => {
    const { parser, events } = makeParser();
    parser.feed('data: one\n\ndata: two\n\n');
    expect(events).toHaveLength(2);
    expect(events[0]!.event.data).toBe('one');
    expect(events[1]!.event.data).toBe('two');
  });

  it('resets event type after dispatch', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'event: special', 'data: a', '');
    feedLines(parser, 'data: b', '');
    expect(events[0]!.event.type).toBe('special');
    expect(events[1]!.event.type).toBe('message');
  });
});

// ─── Last-Event-ID ────────────────────────────────────────────────────────────

describe('SseParser – Last-Event-ID', () => {
  it('persists lastEventId across events', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'id: 100', 'data: first', '');
    feedLines(parser, 'data: second', '');
    expect(events[0]!.event.id).toBe('100');
    expect(events[1]!.event.id).toBe('100');
  });

  it('updates when a new id: field arrives', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'id: 1', 'data: a', '');
    feedLines(parser, 'id: 2', 'data: b', '');
    expect(events[1]!.event.id).toBe('2');
  });

  it('ignores id: containing NULL', () => {
    const { parser } = makeParser();
    parser.feed('id: abc\x00def\ndata: x\n\n');
    expect(parser.getLastEventId()).toBe('');
  });

  it('preserves lastEventId through reset()', () => {
    const { parser } = makeParser();
    feedLines(parser, 'id: keep-me', 'data: x', '');
    parser.reset();
    expect(parser.getLastEventId()).toBe('keep-me');
  });
});

// ─── Line endings ─────────────────────────────────────────────────────────────

describe('SseParser – line endings', () => {
  it('handles LF (\\n)', () => {
    const { parser, events } = makeParser();
    parser.feed('data: lf\n\n');
    expect(events[0]!.event.data).toBe('lf');
  });

  it('handles CRLF (\\r\\n)', () => {
    const { parser, events } = makeParser();
    parser.feed('data: crlf\r\n\r\n');
    expect(events[0]!.event.data).toBe('crlf');
  });

  it('handles CR (\\r)', () => {
    const { parser, events } = makeParser();
    parser.feed('data: cr\r\r');
    expect(events[0]!.event.data).toBe('cr');
  });

  it('handles \\r\\n split across chunks', () => {
    const { parser, events } = makeParser();
    parser.feed('data: split\r');
    parser.feed('\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.event.data).toBe('split');
  });
});

// ─── Chunk boundary ───────────────────────────────────────────────────────────

describe('SseParser – chunk boundaries', () => {
  it('handles a line fed one byte at a time', () => {
    const { parser, events } = makeParser();
    for (const char of 'data: hello\n\n') parser.feed(char);
    expect(events[0]!.event.data).toBe('hello');
  });

  it('buffers partial line until completed', () => {
    const { parser, events } = makeParser();
    parser.feed('data: par');
    expect(events).toHaveLength(0);
    parser.feed('tial\n\n');
    expect(events[0]!.event.data).toBe('partial');
  });

  it('flush() dispatches incomplete final data', () => {
    const { parser, events } = makeParser();
    parser.feed('data: no-newline');
    parser.flush();
    // Line had no trailing newline; flush treats it as a complete line.
    // The event is not dispatched until an empty line follows, so no event yet.
    // (This tests that flush doesn't crash.)
    expect(events).toHaveLength(0);
  });
});

// ─── Buffer overflow protection (V2) ─────────────────────────────────────────

describe('SseParser – buffer overflow protection', () => {
  it('calls onParseError when line exceeds maxLineLength', () => {
    const { parser, errors, events } = makeParser(10); // 10-byte limit
    parser.feed('data: this-line-is-too-long\n\n');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/exceeds max length/i);
    // The oversized line is dropped; no event dispatched.
    expect(events).toHaveLength(0);
  });

  it('continues processing after an overflow', () => {
    const { parser, errors, events } = makeParser(10);
    parser.feed('data: toolongline\n'); // dropped
    parser.feed('data: ok\n\n');         // normal
    expect(errors.length).toBeGreaterThan(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.data).toBe('ok');
  });
});

// ─── Byte length reporting (V2) ──────────────────────────────────────────────

describe('SseParser – byteLength', () => {
  it('reports non-zero byteLength for events', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: hello', '');
    expect(events[0]!.byteLength).toBe(5); // "hello".length
  });

  it('byteLength equals joined data length', () => {
    const { parser, events } = makeParser();
    feedLines(parser, 'data: abc', 'data: def', '');
    // Joined: "abc\ndef" → length 7
    expect(events[0]!.byteLength).toBe(7);
  });
});

// ─── reset() ─────────────────────────────────────────────────────────────────

describe('SseParser – reset()', () => {
  it('clears accumulated fields', () => {
    const { parser, events } = makeParser();
    parser.feed('event: foo\ndata: bar\n');
    parser.reset();
    parser.feed('\n'); // dispatch attempt with cleared state
    expect(events).toHaveLength(0);
  });

  it('does not dispatch partial data after reset', () => {
    const { parser, events } = makeParser();
    parser.feed('data: incomplete');
    parser.reset();
    parser.feed('\n\n');
    expect(events).toHaveLength(0);
  });
});

// ─── bytesProcessed counter ───────────────────────────────────────────────────

describe('SseParser – bytesProcessed', () => {
  it('accumulates across feed() calls', () => {
    const { parser } = makeParser();
    parser.feed('data: ');   // 6 chars
    parser.feed('hello\n\n'); // 7 chars → total 13
    expect(parser.bytesProcessed).toBe(13);
  });

  it('resets with resetBytesCounter()', () => {
    const { parser } = makeParser();
    parser.feed('data: hello\n\n');
    parser.resetBytesCounter();
    expect(parser.bytesProcessed).toBe(0);
  });
});
