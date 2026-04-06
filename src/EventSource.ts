import { AppState, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { EmitterSubscription, AppStateStatus } from 'react-native';
import { computeDelay, resolvePolicy } from './reconnect';
import { CLOSED, CONNECTING, OPEN, SSE_STATE } from './types';
import type {
  BatchConfig,
  NativeCloseEvent,
  NativeErrorEvent,
  NativeMessageEvent,
  NativeOpenEvent,
  ReconnectPolicy,
  SseConnectOptions,
  SseError,
  SseErrorCode,
  SseErrorEvent,
  SseMessageEvent,
  SseOpenEvent,
  SseReadyState,
  SseState,
  StreamMetrics,
} from './types';

// ─── Native module resolution ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isTurboModuleEnabled = !!(global as any).__turboModuleProxy;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NativeNativeSse = isTurboModuleEnabled
  ? require('./NativeNativeSse').default
  : NativeModules.NativeNativeSse;

const emitter =
  NativeNativeSse != null ? new NativeEventEmitter(NativeNativeSse) : null;

// ─── Stream ID generator ─────────────────────────────────────────────────────

let _counter = 0;
function nextStreamId(): string {
  return `sse_${Platform.OS}_${Date.now()}_${++_counter}`;
}

// ─── Event Batcher ───────────────────────────────────────────────────────────

class EventBatcher {
  private queue: SseMessageEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly cfg: Required<BatchConfig>;
  private readonly flush: (events: SseMessageEvent[]) => void;

  constructor(cfg: BatchConfig, flush: (events: SseMessageEvent[]) => void) {
    this.cfg = {
      enabled:         cfg.enabled,
      flushIntervalMs: cfg.flushIntervalMs ?? 16,
      maxBatchSize:    cfg.maxBatchSize    ?? 50,
    };
    this.flush = flush;
  }

  push(event: SseMessageEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.cfg.maxBatchSize) {
      this.doFlush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => this.doFlush(), this.cfg.flushIntervalMs);
    }
  }

  doFlush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.queue.length > 0) {
      this.flush(this.queue.splice(0));
    }
  }

  clear(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.queue = [];
  }
}

// ─── Handler types ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (event: any) => void;
type BatchHandler = (events: SseMessageEvent[]) => void;

// ─── NativeSSE ────────────────────────────────────────────────────────────────

/**
 * NativeSSE V2 – production-grade mobile SSE client backed by TurboModules.
 *
 * Backward-compatible with V1: all V1 constructor options, event handlers,
 * `readyState` constants, and `addEventListener/removeEventListener/close()`
 * continue to work unchanged.
 *
 * V2 additions:
 *  • Fine-grained `state` property (7 states).
 *  • Explicit `connect()` / `pause()` / `resume()` lifecycle methods.
 *  • `reconnectPolicy` with fixed and exponential-backoff options.
 *  • `getMetrics()` snapshot for observability.
 *  • `onbatch` handler for AI/high-frequency streaming.
 *  • `pauseOnBackground` for automatic lifecycle handling.
 *  • Structured `SseError` passed to `onerror`.
 */
export class NativeSSE {
  // Static ready-state constants (browser EventSource compat).
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN       = OPEN;
  static readonly CLOSED     = CLOSED;

  readonly CONNECTING = CONNECTING;
  readonly OPEN       = OPEN;
  readonly CLOSED     = CLOSED;

  // ── Configuration ───────────────────────────────────────────────────────────
  private readonly _url: string;
  private readonly _opts: SseConnectOptions;
  private readonly _policy: ReconnectPolicy;
  private readonly _maxAttempts: number;
  private readonly _batcher: EventBatcher | null;

  // ── Connection state ────────────────────────────────────────────────────────
  private _state: SseState = SSE_STATE.IDLE;
  private _streamId: string = '';
  private _lastEventId = '';
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _subscriptions: EmitterSubscription[] = [];
  private _appStateSub: { remove(): void } | null = null;

  // ── Metrics ─────────────────────────────────────────────────────────────────
  private _metrics: StreamMetrics = {
    bytesReceived:     0,
    eventsReceived:    0,
    reconnectCount:    0,
    lastEventId:       '',
    lastEventTimestamp: null,
    lastError:         null,
    connectedAt:       null,
  };

  // ── Event handlers ──────────────────────────────────────────────────────────
  onopen:    ((event: SseOpenEvent)    => void) | null = null;
  onmessage: ((event: SseMessageEvent) => void) | null = null;
  onerror:   ((error: SseErrorEvent)   => void) | null = null;
  /** Batch handler: called with an array of events when batch mode is active. */
  onbatch:   BatchHandler | null = null;

  private _handlers: Record<string, AnyHandler[]> = {};

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(url: string, options: SseConnectOptions = {}) {
    if (!NativeNativeSse) {
      throw new Error(
        '[NativeSSE] Native module "NativeNativeSse" is not available. ' +
          'Ensure the library is linked and the native project was rebuilt.',
      );
    }

    this._url         = url;
    this._opts        = options;
    this._policy      = resolvePolicy(options);
    this._maxAttempts = options.maxReconnectAttempts ?? -1;
    this._batcher     = options.batch?.enabled
      ? new EventBatcher(options.batch, (evts) => this._deliverBatch(evts))
      : null;

    if (options.pauseOnBackground) {
      this._appStateSub = AppState.addEventListener(
        'change',
        this._handleAppState,
      );
    }

    if (options.autoConnect !== false) {
      this.connect();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get url(): string       { return this._url; }
  get state(): SseState   { return this._state; }

  /** V1-compatible ready state (0 | 1 | 2). */
  get readyState(): SseReadyState {
    switch (this._state) {
      case SSE_STATE.OPEN:               return OPEN;
      case SSE_STATE.CLOSED:
      case SSE_STATE.FAILED:             return CLOSED;
      default:                           return CONNECTING;
    }
  }

  /** Snapshot of current stream metrics. */
  getMetrics(): StreamMetrics {
    return { ...this._metrics };
  }

  /**
   * Explicitly start the connection.
   * Idempotent when called in `connecting` or `open` states.
   * Required when `autoConnect: false`.
   */
  connect(): void {
    if (
      this._state === SSE_STATE.CLOSED ||
      this._state === SSE_STATE.FAILED
    ) return;
    if (
      this._state === SSE_STATE.CONNECTING ||
      this._state === SSE_STATE.OPEN
    ) return;

    this._doConnect();
  }

  /**
   * Permanently close the stream. Terminal state — the instance cannot be reused.
   */
  close(): void {
    const prev = this._state;
    this._setState(SSE_STATE.CLOSED);
    this._cleanup(/* removeAppState */ true);
    if (prev !== SSE_STATE.IDLE) {
      NativeNativeSse?.disconnect(this._streamId);
    }
  }

  /**
   * Pause streaming without permanently closing.
   * The stream can be resumed later with resume().
   * Has no effect if already closed/failed.
   */
  pause(): void {
    if (
      this._state === SSE_STATE.CLOSED ||
      this._state === SSE_STATE.FAILED ||
      this._state === SSE_STATE.PAUSED ||
      this._state === SSE_STATE.IDLE
    ) return;

    this._setState(SSE_STATE.PAUSED);
    this._cleanup();
    NativeNativeSse?.disconnect(this._streamId);
    this._batcher?.clear();
  }

  /**
   * Resume a paused stream. Has no effect if not paused.
   */
  resume(): void {
    if (this._state !== SSE_STATE.PAUSED) return;
    this._doConnect();
  }

  addEventListener(type: string, listener: AnyHandler): void {
    if (!this._handlers[type]) this._handlers[type] = [];
    if (!this._handlers[type]!.includes(listener)) {
      this._handlers[type]!.push(listener);
    }
  }

  removeEventListener(type: string, listener: AnyHandler): void {
    if (!this._handlers[type]) return;
    this._handlers[type] = this._handlers[type]!.filter((l) => l !== listener);
  }

  // ── Native listeners ────────────────────────────────────────────────────────

  private _attachNativeListeners(): void {
    if (!emitter) return;

    this._subscriptions.push(
      emitter.addListener('sse_open', (raw: NativeOpenEvent) => {
        if (raw.streamId !== this._streamId) return;

        this._setState(SSE_STATE.OPEN);
        this._reconnectAttempts = 0;
        this._metrics.connectedAt = Date.now();

        const evt: SseOpenEvent = { type: 'open', origin: this._url };
        this.onopen?.(evt);
        this._dispatch('open', evt);
      }),

      emitter.addListener('sse_message', (raw: NativeMessageEvent) => {
        if (raw.streamId !== this._streamId) return;

        if (raw.id) {
          this._lastEventId = raw.id;
          this._metrics.lastEventId = raw.id;
        }
        if (raw.retry != null) {
          // Server-sent retry overrides the configured policy for the next
          // reconnect. We do this by patching _policy inline.
          (this._policy as FixedPatch).intervalMs = raw.retry;
          (this._policy as FixedPatch).type = 'fixed';
        }

        this._metrics.bytesReceived    += raw.byteLength ?? raw.data.length;
        this._metrics.eventsReceived   += 1;
        this._metrics.lastEventTimestamp = Date.now();

        const evt: SseMessageEvent = {
          type:        raw.eventType || 'message',
          data:        raw.data,
          lastEventId: this._lastEventId,
          origin:      this._url,
        };

        if (this._batcher) {
          this._batcher.push(evt);
        } else {
          this._deliverSingle(evt);
        }
      }),

      emitter.addListener('sse_error', (raw: NativeErrorEvent) => {
        if (raw.streamId !== this._streamId) return;

        const err = this._buildError(raw);
        this._metrics.lastError = err;

        this.onerror?.(err);
        this._dispatch('error', err);

        if (raw.isFatal || this._state === SSE_STATE.CLOSED) {
          this._setState(SSE_STATE.FAILED);
          this._cleanup();
        } else if (this._state !== SSE_STATE.PAUSED) {
          this._scheduleReconnect();
        }
      }),

      emitter.addListener('sse_close', (raw: NativeCloseEvent) => {
        if (raw.streamId !== this._streamId) return;
        if (
          this._state === SSE_STATE.CLOSED ||
          this._state === SSE_STATE.FAILED ||
          this._state === SSE_STATE.PAUSED
        ) return;
        this._scheduleReconnect();
      }),
    );
  }

  // ── Internal connect / reconnect ────────────────────────────────────────────

  private _doConnect(): void {
    // Generate a fresh stream ID per connection attempt. This ensures events
    // from a previous (possibly still in-flight) connection are ignored.
    this._streamId = nextStreamId();
    this._setState(SSE_STATE.CONNECTING);

    // Re-attach native listeners so they filter on the new streamId.
    for (const sub of this._subscriptions) sub.remove();
    this._subscriptions = [];
    this._attachNativeListeners();

    const headers: Record<string, string> = {
      Accept:          'text/event-stream',
      'Cache-Control': 'no-cache',
      ...this._opts.headers,
    };
    if (this._lastEventId) headers['Last-Event-ID'] = this._lastEventId;

    NativeNativeSse.connect(this._streamId, this._url, {
      method:       this._opts.method       ?? 'GET',
      headers,
      body:         this._opts.body         ?? '',
      lastEventId:  this._lastEventId,
      timeout:      this._opts.timeout      ?? 0,
      maxLineLength: this._opts.maxLineLength ?? 1_048_576,
    });
  }

  private _scheduleReconnect(): void {
    if (
      this._state === SSE_STATE.CLOSED ||
      this._state === SSE_STATE.FAILED ||
      this._state === SSE_STATE.PAUSED
    ) return;

    if (this._maxAttempts !== -1 && this._reconnectAttempts >= this._maxAttempts) {
      this._setState(SSE_STATE.FAILED);
      this._cleanup(true);
      const err = this._makeError(
        'MAX_RETRIES_EXCEEDED',
        `Max reconnect attempts (${this._maxAttempts}) reached`,
        undefined,
        false,
      );
      this._metrics.lastError = err;
      this.onerror?.(err);
      this._dispatch('error', err);
      return;
    }

    this._reconnectAttempts += 1;
    this._metrics.reconnectCount += 1;

    const delay = computeDelay(this._policy, this._reconnectAttempts);

    if (this._opts.debug) {
      console.log(
        `[NativeSSE] Reconnecting in ${delay}ms` +
          ` (attempt ${this._reconnectAttempts}` +
          (this._maxAttempts !== -1 ? `/${this._maxAttempts}` : '') + ')' +
          ` policy=${this._policy.type}`,
      );
    }

    this._setState(SSE_STATE.RECONNECTING);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (
        this._state !== SSE_STATE.CLOSED &&
        this._state !== SSE_STATE.FAILED &&
        this._state !== SSE_STATE.PAUSED
      ) {
        this._doConnect();
      }
    }, delay);
  }

  // ── Lifecycle (AppState) ────────────────────────────────────────────────────

  private _handleAppState = (nextState: AppStateStatus): void => {
    if (nextState === 'background' || nextState === 'inactive') {
      this.pause();
    } else if (nextState === 'active') {
      this.resume();
    }
  };

  // ── Event delivery ──────────────────────────────────────────────────────────

  private _deliverSingle(evt: SseMessageEvent): void {
    this._dispatch(evt.type, evt);
    if (evt.type === 'message') {
      this.onmessage?.(evt);
    }
  }

  private _deliverBatch(evts: SseMessageEvent[]): void {
    this.onbatch?.(evts);
    for (const evt of evts) {
      this._dispatch(evt.type, evt);
      if (evt.type === 'message') this.onmessage?.(evt);
    }
  }

  private _dispatch(type: string, event: unknown): void {
    const handlers = this._handlers[type];
    if (!handlers?.length) return;
    for (const h of handlers) {
      try { h(event); } catch (e) {
        console.error(`[NativeSSE] Uncaught error in "${type}" handler:`, e);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _setState(next: SseState): void {
    this._state = next;
  }

  private _cleanup(removeAppState = false): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const sub of this._subscriptions) sub.remove();
    this._subscriptions = [];
    // The AppState subscription survives pause/resume; only close() removes it.
    if (removeAppState) {
      this._appStateSub?.remove();
      this._appStateSub = null;
    }
    this._batcher?.clear();
  }

  private _buildError(raw: NativeErrorEvent): SseError {
    return this._makeError(
      raw.errorCode ?? (raw.isFatal ? 'HTTP_ERROR' : 'NETWORK_ERROR'),
      raw.message,
      raw.statusCode,
      !raw.isFatal,
    );
  }

  private _makeError(
    code: SseErrorCode,
    message: string,
    statusCode?: number,
    retryable = false,
  ): SseError {
    return { code, message, statusCode, timestamp: Date.now(), retryable };
  }
}

// Internal type alias used for server retry override.
interface FixedPatch { type: string; intervalMs: number }
