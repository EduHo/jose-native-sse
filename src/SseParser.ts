/**
 * SSE stream parser — WHATWG spec compliant with V2 hardening.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * V2 additions over V1:
 *  • maxLineLength guard: lines exceeding the limit call onOverflow() and are
 *    dropped, preventing unbounded memory growth on malformed streams.
 *  • bytesProcessed counter for JS-side metrics (approximated from string length;
 *    exact byte counts come from the native layer via NativeMessageEvent.byteLength).
 *  • onParseError callback for structured error reporting.
 *  • flush() method for final partial-line handling on stream close.
 */

export interface ParsedEvent {
  type: string;
  data: string;
  id: string | null;
  retry: number | null;
}

export interface SseParserOptions {
  /**
   * Maximum byte length of a single SSE line (including the field name and colon).
   * Lines exceeding this limit call onParseError and are dropped.
   * Default: 1 048 576 (1 MB).
   */
  maxLineLength?: number;
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
  private readonly onEventCb: (event: ParsedEvent, byteLength: number) => void;
  private readonly onParseError: (reason: string) => void;
  private readonly onRetry: (ms: number) => void;

  // Line accumulation buffer (never grows beyond maxLineLength + separator).
  private lineBuffer = '';
  private lineOverflow = false;

  // SSE event field accumulators.
  private eventType = '';
  private dataLines: string[] = [];
  private lastEventId = '';
  private _lastRetry: number | null = null;

  // Running byte total (JS-side approximation using UTF-16 code unit count).
  private _bytesProcessed = 0;

  constructor(options: SseParserOptions = {}) {
    this.maxLineLength    = options.maxLineLength    ?? 1_048_576;
    this.onEventCb        = options.onEvent          ?? (() => {});
    this.onParseError     = options.onParseError     ?? (() => {});
    this.onRetry          = options.onRetry          ?? (() => {});
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Feed a raw text chunk. May be called with arbitrarily sized chunks,
   * including partial lines — buffering is handled internally.
   */
  feed(chunk: string): void {
    this._bytesProcessed += chunk.length;
    this.lineBuffer += chunk;

    // Walk through the buffer splitting on \r\n, \r, \n.
    // We keep pointers rather than splitting to avoid O(n) array allocations.
    let start = 0;
    const buf = this.lineBuffer;

    while (start < buf.length) {
      const crIdx = buf.indexOf('\r', start);
      const lfIdx = buf.indexOf('\n', start);

      // Find the next terminator.
      let termStart: number;
      let termLen: number;

      if (crIdx === -1 && lfIdx === -1) {
        // No terminator yet — check for overflow in the pending fragment.
        const pending = buf.length - start;
        if (pending > this.maxLineLength) {
          this.onParseError(
            `Line buffer overflow: pending fragment exceeds ${this.maxLineLength} bytes`,
          );
          this.lineOverflow = true;
          // Drop everything and restart.
          this.lineBuffer = '';
          this.lineOverflow = false;
          return;
        }
        break; // Wait for more data.
      } else if (crIdx !== -1 && (lfIdx === -1 || crIdx <= lfIdx)) {
        termStart = crIdx;
        // \r\n pair?
        termLen = crIdx + 1 < buf.length && buf[crIdx + 1] === '\n' ? 2 : 1;
      } else {
        termStart = lfIdx;
        termLen = 1;
      }

      const lineLen = termStart - start;
      if (lineLen > this.maxLineLength) {
        this.onParseError(
          `Line exceeds max length (${lineLen} > ${this.maxLineLength})`,
        );
        // Skip the oversized line.
        start = termStart + termLen;
        this.lineOverflow = false;
        continue;
      }

      if (!this.lineOverflow) {
        const line = buf.slice(start, termStart);
        this.processLine(line);
      }
      this.lineOverflow = false;
      start = termStart + termLen;
    }

    this.lineBuffer = start < buf.length ? buf.slice(start) : '';
  }

  /**
   * Flush any buffered partial line as a complete line.
   * Call on stream close to handle servers that omit a trailing newline.
   */
  flush(): void {
    if (this.lineBuffer.length > 0 && !this.lineOverflow) {
      this.processLine(this.lineBuffer);
      this.lineBuffer = '';
    }
    this.lineOverflow = false;
  }

  /**
   * Reset all parser state for reconnect.
   * Per spec, lastEventId is intentionally preserved across resets (§9.2.6 step 15).
   */
  reset(): void {
    this.lineBuffer  = '';
    this.lineOverflow = false;
    this.eventType   = '';
    this.dataLines   = [];
    this._lastRetry  = null;
    // lastEventId: NOT reset.
  }

  /** Returns the last received event ID (persists through reset()). */
  getLastEventId(): string { return this.lastEventId; }

  /** Running byte total (JS-side approximation). */
  get bytesProcessed(): number { return this._bytesProcessed; }

  resetBytesCounter(): void { this._bytesProcessed = 0; }

  // ─── Private ─────────────────────────────────────────────────────────────────

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
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          const ms = parseInt(value, 10);
          this._lastRetry = ms;
          this.onRetry(ms);
        }
        break;
      default:
        break;
    }
  }

  private dispatchEvent(): void {
    if (this.dataLines.length === 0) {
      this.eventType = '';
      return;
    }

    const data = this.dataLines.join('\n');
    const event: ParsedEvent = {
      type:  this.eventType === '' ? 'message' : this.eventType,
      data,
      id:    this.lastEventId === '' ? null : this.lastEventId,
      retry: this._lastRetry,
    };

    const byteLength = data.length; // JS-side approximation

    this.eventType  = '';
    this.dataLines  = [];
    this._lastRetry = null;

    this.onEventCb(event, byteLength);
  }
}
