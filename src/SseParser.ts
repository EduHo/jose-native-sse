/**
 * SSE stream parser — WHATWG spec compliant with V2 hardening.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * Hardening beyond the spec, all of it bounded work on attacker-controlled input:
 *  • maxLineLength: an over-long line is dropped, and the parser then discards
 *    input up to the next terminator so the tail of that line can never be
 *    re-read as a fresh set of fields.
 *  • maxEventSize: caps the accumulated `data:` payload, so a stream that never
 *    sends a blank line cannot grow the buffer without bound.
 *  • maxIdLength: caps `id:`, which is echoed back in the Last-Event-ID request
 *    header on the next reconnect.
 *  • retry: only finite values are accepted; the reconnect delay itself is
 *    clamped by the caller.
 *  • Line scanning is linear in the buffer length, not quadratic in line count.
 */

export interface ParsedEvent {
  type: string;
  data: string;
  id: string | null;
  retry: number | null;
}

export interface SseParserOptions {
  /**
   * Maximum length of a single SSE line (including the field name and colon).
   * A longer line is dropped, along with everything up to the next terminator.
   * Default: 1 048 576 (1 MB).
   */
  maxLineLength?: number;
  /**
   * Maximum total size of one event's accumulated `data:` payload. Reaching it
   * discards the event in progress rather than growing the buffer.
   * Default: 4 194 304 (4 MB).
   */
  maxEventSize?: number;
  /**
   * Maximum length of an `id:` value. Longer ids are ignored, because the value
   * travels back to the server in the Last-Event-ID header.
   * Default: 1024.
   */
  maxIdLength?: number;
  /**
   * Called for every successfully dispatched SSE event.
   * Receives the accumulated event data byte length for metrics tracking.
   */
  onEvent?: (event: ParsedEvent, byteLength: number) => void;
  /**
   * Called when a line exceeds maxLineLength or contains invalid content.
   */
  onParseError?: (reason: string) => void;
  /** Called each time a `retry:` field is parsed. */
  onRetry?: (ms: number) => void;
}

export class SseParser {
  private readonly maxLineLength: number;
  private readonly maxEventSize: number;
  private readonly maxIdLength: number;
  private readonly onEventCb: (event: ParsedEvent, byteLength: number) => void;
  private readonly onParseError: (reason: string) => void;
  private readonly onRetry: (ms: number) => void;

  // Line accumulation buffer (never grows beyond maxLineLength + separator).
  private lineBuffer = '';
  /**
   * True while the parser is inside a line it has already given up on. Input is
   * discarded until the next terminator, so a dropped line's tail is never
   * mistaken for the start of a new one.
   */
  private lineOverflow = false;
  // Strip the UTF-8 BOM (U+FEFF) only from the very first bytes of the stream.
  private _bomHandled = false;

  // SSE event field accumulators.
  private eventType = '';
  private dataLines: string[] = [];
  private dataSize = 0;
  /** True when the event in progress exceeded maxEventSize and was discarded. */
  private eventOverflow = false;
  private lastEventId = '';
  private _lastRetry: number | null = null;

  // Running byte total (JS-side approximation using UTF-16 code unit count).
  private _bytesProcessed = 0;

  constructor(options: SseParserOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? 1_048_576;
    this.maxEventSize  = options.maxEventSize  ?? 4_194_304;
    this.maxIdLength   = options.maxIdLength   ?? 1024;
    this.onEventCb     = options.onEvent       ?? (() => {});
    this.onParseError  = options.onParseError   ?? (() => {});
    this.onRetry       = options.onRetry        ?? (() => {});
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Feed a raw text chunk. May be called with arbitrarily sized chunks,
   * including partial lines — buffering is handled internally.
   */
  feed(chunk: string): void {
    if (!this._bomHandled && chunk.length > 0) {
      this._bomHandled = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    this._bytesProcessed += chunk.length;
    this.lineBuffer += chunk;

    const buf = this.lineBuffer;
    let start = 0;

    // Terminator positions are cached and only ever advanced. Re-scanning from
    // `start` on every line would make a CR-free stream — the common case —
    // quadratic in the number of lines.
    let crIdx = buf.indexOf('\r');
    let lfIdx = buf.indexOf('\n');

    while (start < buf.length) {
      if (crIdx !== -1 && crIdx < start) crIdx = buf.indexOf('\r', start);
      if (lfIdx !== -1 && lfIdx < start) lfIdx = buf.indexOf('\n', start);

      let termStart: number;
      let termLen: number;

      if (crIdx === -1 && lfIdx === -1) {
        // No terminator yet — hold the fragment unless it is already too long.
        if (this.handlePendingOverflow(buf.length - start)) return;
        break; // Wait for more data.
      } else if (crIdx !== -1 && (lfIdx === -1 || crIdx <= lfIdx)) {
        // A CR at the very end may be the first half of a CRLF pair that is
        // still in flight. Wait rather than emit a phantom empty line.
        if (crIdx === buf.length - 1) {
          if (this.handlePendingOverflow(buf.length - start)) return;
          break;
        }
        termStart = crIdx;
        termLen = buf.charCodeAt(crIdx + 1) === 10 /* \n */ ? 2 : 1;
      } else {
        termStart = lfIdx;
        termLen = 1;
      }

      const lineLen = termStart - start;

      if (this.lineOverflow) {
        // Tail of a line we already dropped: discard it, resynchronised now.
        this.lineOverflow = false;
      } else if (lineLen > this.maxLineLength) {
        this.onParseError(
          `Line exceeds max length (${lineLen} > ${this.maxLineLength})`,
        );
      } else {
        this.processLine(buf.slice(start, termStart));
      }

      start = termStart + termLen;
    }

    this.lineBuffer = start < buf.length ? buf.slice(start) : '';
  }

  /**
   * Flush any buffered partial line as a complete line.
   * Call on stream close to handle servers that omit a trailing newline.
   */
  flush(): void {
    if (this.lineOverflow) {
      // Still inside a dropped line and the stream ended: discard, never parse.
      this.lineBuffer = '';
      this.lineOverflow = false;
      return;
    }

    let rest = this.lineBuffer;
    this.lineBuffer = '';
    if (rest === '') return;

    // feed() defers a trailing CR because it cannot yet tell a bare CR from the
    // first half of a CRLF. No more bytes are coming, so it is a terminator —
    // and dropping it here is what lets a CR-terminated stream dispatch its
    // final event instead of parsing "\r" as a field name.
    if (rest.charCodeAt(rest.length - 1) === 13 /* \r */) {
      rest = rest.slice(0, -1);
    }

    if (rest.length > this.maxLineLength) {
      this.onParseError(
        `Line exceeds max length (${rest.length} > ${this.maxLineLength})`,
      );
      return;
    }
    this.processLine(rest);
  }

  /**
   * Reset all parser state for reconnect.
   * Per spec, lastEventId is intentionally preserved across resets (§9.2.6 step 15).
   */
  reset(): void {
    this.lineBuffer    = '';
    this.lineOverflow  = false;
    this.eventType     = '';
    this.dataLines     = [];
    this.dataSize      = 0;
    this.eventOverflow = false;
    this._lastRetry    = null;
    this._bomHandled   = false;
    // lastEventId: NOT reset (spec §9.2.6 step 15).
  }

  /** Returns the last received event ID (persists through reset()). */
  getLastEventId(): string {
    return this.lastEventId;
  }

  /** Running byte total (JS-side approximation). */
  get bytesProcessed(): number {
    return this._bytesProcessed;
  }

  resetBytesCounter(): void {
    this._bytesProcessed = 0;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  /**
   * Handle a terminator-less fragment. Returns true when the buffer was dropped
   * and the caller should stop processing this chunk.
   */
  private handlePendingOverflow(pending: number): boolean {
    if (pending <= this.maxLineLength) return false;
    this.onParseError(
      `Line buffer overflow: pending fragment exceeds ${this.maxLineLength} bytes`,
    );
    // Stay in overflow until a terminator arrives, so the rest of this line
    // cannot be reinterpreted as fields.
    this.lineOverflow = true;
    this.lineBuffer = '';
    return true;
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatchEvent();
      return;
    }
    if (line.startsWith(':')) return; // comment

    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;

    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      const raw = line.slice(colonIdx + 1);
      value = raw.startsWith(' ') ? raw.slice(1) : raw;
    }

    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data': {
        if (this.eventOverflow) return; // event already abandoned
        // +1 for the newline join() will insert.
        const next = this.dataSize + value.length + (this.dataLines.length ? 1 : 0);
        if (next > this.maxEventSize) {
          this.onParseError(
            `Event exceeds max size (${next} > ${this.maxEventSize}) — discarded`,
          );
          this.eventOverflow = true;
          this.dataLines = [];
          this.dataSize = 0;
          return;
        }
        this.dataLines.push(value);
        this.dataSize = next;
        break;
      }
      case 'id':
        if (value.includes('\u0000')) return; // per spec
        if (value.length > this.maxIdLength) {
          this.onParseError(
            `Event id exceeds max length (${value.length} > ${this.maxIdLength}) — ignored`,
          );
          return;
        }
        this.lastEventId = value;
        break;
      case 'retry': {
        if (!/^\d+$/.test(value)) return;
        const ms = Number(value);
        // A 400-digit value parses to Infinity, and setTimeout(fn, Infinity)
        // collapses to ~1ms — a hot reconnect loop. Reject anything non-finite.
        if (!Number.isFinite(ms)) {
          this.onParseError(`Ignoring non-finite retry value: ${value.slice(0, 32)}…`);
          return;
        }
        this._lastRetry = ms;
        this.onRetry(ms);
        break;
      }
      default:
        break;
    }
  }

  private dispatchEvent(): void {
    // An abandoned event still consumes its terminating blank line.
    if (this.eventOverflow) {
      this.eventOverflow = false;
      this.eventType = '';
      this.dataLines = [];
      this.dataSize = 0;
      return;
    }

    if (this.dataLines.length === 0) {
      this.eventType = '';
      return;
    }

    const data = this.dataLines.join('\n');
    const event: ParsedEvent = {
      type: this.eventType === '' ? 'message' : this.eventType,
      data,
      id: this.lastEventId === '' ? null : this.lastEventId,
      retry: this._lastRetry,
    };

    const byteLength = data.length; // JS-side approximation

    this.eventType = '';
    this.dataLines = [];
    this.dataSize = 0;
    this._lastRetry = null;

    this.onEventCb(event, byteLength);
  }
}
