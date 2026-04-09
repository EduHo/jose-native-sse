import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { EmitterSubscription } from 'react-native';
import { AppLifecycleManager } from './AppLifecycleManager';
import { NetworkMonitor } from './NetworkMonitor';
import { StateMachine } from './StateMachine';
import { computeDelay, resolvePolicy } from './reconnect';
import { InMemoryStorageAdapter } from './storage';
import { SseParser } from './SseParser';
import { CLOSED, CONNECTING, OPEN, SSE_STATE } from './types';
import type {
  BatchConfig,
  NativeChunkEvent,
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
  SseStateChangeEvent,
  StorageAdapter,
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
 * NativeSSE V2 – production-grade mobile SSE client.
 *
 * **Transport selection (automatic):**
 * - TurboModule / native bridge (URLSession on iOS, OkHttp on Android) when the
 *   native module is available — dev builds, EAS Build, bare workflow.
 * - XHR fallback when the native module is absent (Expo Go) — same API, same
 *   reconnect logic, slightly higher memory usage on long-lived connections.
 *
 * Backward-compatible with V1: all V1 constructor options, event handlers,
 * `readyState` constants, and `addEventListener/removeEventListener/close()`
 * continue to work unchanged.
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
  private readonly _staleTimeoutMs: number;
  /** True when the native module is unavailable (Expo Go, unlinked). */
  private readonly _useFallback: boolean;
  /** Which fallback transport to use when _useFallback is true. */
  private readonly _fallbackType: 'xhr' | 'fetch';

  // ── Connection state ────────────────────────────────────────────────────────
  private readonly _sm: StateMachine;
  private readonly _appLifecycle: AppLifecycleManager | null;
  private readonly _networkMonitor: NetworkMonitor;
  private _streamId: string = '';
  private _lastEventId = '';
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _staleTimer: ReturnType<typeof setTimeout> | null = null;
  private _networkBlocked = false;
  private _subscriptions: EmitterSubscription[] = [];

  // ── Fallback transport state ─────────────────────────────────────────────────
  private _xhr: XMLHttpRequest | null = null;
  private _fetchController: AbortController | null = null;
  private _parser: SseParser | null = null;

  // ── Storage (Last-Event-ID persistence) ─────────────────────────────────────
  private readonly _storageAdapter: StorageAdapter;
  private readonly _storageKey: string;
  private _storageLoaded = false;

  // ── Metrics ─────────────────────────────────────────────────────────────────
  private _metrics: StreamMetrics = {
    bytesReceived:      0,
    eventsReceived:     0,
    reconnectCount:     0,
    staleCount:         0,
    lastEventId:        '',
    lastEventTimestamp: null,
    lastError:          null,
    connectedAt:        null,
  };

  // ── Event handlers ──────────────────────────────────────────────────────────
  onopen:        ((event: SseOpenEvent)        => void) | null = null;
  onmessage:     ((event: SseMessageEvent)     => void) | null = null;
  onerror:       ((error: SseErrorEvent)       => void) | null = null;
  onstatechange: ((event: SseStateChangeEvent) => void) | null = null;
  /** Batch handler: called with an array of events when batch mode is active. */
  onbatch:       BatchHandler | null = null;

  private _handlers: Record<string, AnyHandler[]> = {};

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(url: string, options: SseConnectOptions = {}) {
    const t = options.transport ?? 'auto';
    if (t === 'native') {
      this._useFallback  = false;
      this._fallbackType = 'xhr'; // unused
    } else if (t === 'xhr') {
      this._useFallback  = true;
      this._fallbackType = 'xhr';
    } else if (t === 'fetch') {
      this._useFallback  = true;
      this._fallbackType = 'fetch';
    } else {
      // 'auto': prefer native module, fall back to XHR when absent.
      this._useFallback  = !NativeNativeSse;
      this._fallbackType = 'xhr';
    }

    if (this._useFallback && options.debug) {
      console.warn(
        `[NativeSSE] Native module not available — using ${this._fallbackType.toUpperCase()} fallback transport.\n` +
          'Performance is reduced compared to native. To use the native transport,\n' +
          'run a development build: npx expo run:ios / npx expo run:android.',
      );
    }

    this._url            = url;
    this._opts           = options;
    this._policy         = resolvePolicy(options);
    this._maxAttempts    = options.maxReconnectAttempts ?? -1;
    this._staleTimeoutMs = options.staleTimeoutMs ?? 0;
    this._batcher        = options.batch?.enabled
      ? new EventBatcher(options.batch, (evts) => this._deliverBatch(evts))
      : null;
    this._storageAdapter = options.storageAdapter ?? new InMemoryStorageAdapter();
    this._storageKey     = options.storageKey ?? 'sse:last-event-id';

    this._sm = new StateMachine(SSE_STATE.IDLE);

    this._appLifecycle = options.pauseOnBackground
      ? new AppLifecycleManager(
          () => this.pause(),
          () => { if (options.backgroundBehavior !== 'disconnect') this.resume(); },
        )
      : null;
    this._appLifecycle?.start();

    this._networkMonitor = new NetworkMonitor(this._handleNetworkChange);
    this._networkMonitor.start(options.networkObserver, options.networkAwareness);

    if (options.autoConnect !== false) {
      this.connect();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get url(): string       { return this._url; }
  get state(): SseState   { return this._sm.state; }

  /** True when running with the XHR fallback (native module unavailable). */
  get usingFallback(): boolean { return this._useFallback; }

  /** V1-compatible ready state (0 | 1 | 2). */
  get readyState(): SseReadyState {
    switch (this._sm.state) {
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

  connect(): void {
    const s = this._sm.state;
    if (s === SSE_STATE.CLOSED || s === SSE_STATE.FAILED) return;
    if (s === SSE_STATE.CONNECTING || s === SSE_STATE.OPEN) return;
    this._doConnect();
  }

  close(): void {
    const prev = this._sm.state;
    this._transition(SSE_STATE.CLOSED);
    this._cleanup(/* removeAll */ true);
    if (prev !== SSE_STATE.IDLE && !this._useFallback) {
      NativeNativeSse?.disconnect(this._streamId);
    }
  }

  pause(): void {
    const s = this._sm.state;
    if (
      s === SSE_STATE.CLOSED  ||
      s === SSE_STATE.FAILED  ||
      s === SSE_STATE.PAUSED  ||
      s === SSE_STATE.IDLE
    ) return;

    this._transition(SSE_STATE.PAUSED);
    this._cleanup();
    if (!this._useFallback) NativeNativeSse?.disconnect(this._streamId);
    this._batcher?.clear();
  }

  resume(): void {
    if (this._sm.state !== SSE_STATE.PAUSED) return;
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

  // ── Internal event handlers (shared by native + fallback transports) ─────────

  private _onOpen = (raw: NativeOpenEvent): void => {
    if (raw.streamId !== this._streamId) return;

    this._transition(SSE_STATE.OPEN);
    this._reconnectAttempts = 0;
    this._metrics.connectedAt = Date.now();
    this._resetStaleTimer();

    const evt: SseOpenEvent = { type: 'open', origin: this._url };
    this.onopen?.(evt);
    this._dispatch('open', evt);
  };

  /** Called by SseParser for all transports (native, XHR, Fetch). */
  private _onMessage = (raw: NativeMessageEvent): void => {
    if (raw.streamId !== this._streamId) return;

    if (raw.id) {
      this._lastEventId         = raw.id;
      this._metrics.lastEventId = raw.id;
      if (this._opts.persistLastEventId) {
        this._storageAdapter
          .setItem(this._storageKey, raw.id)
          .catch(() => { /* non-fatal */ });
      }
    }

    this._metrics.eventsReceived    += 1;
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
  };

  /** Called by the native transport for each raw SSE chunk received. */
  private _onChunk = (raw: NativeChunkEvent): void => {
    if (raw.streamId !== this._streamId) return;
    this._metrics.bytesReceived += raw.byteLength;
    this._resetStaleTimer();
    this._parser?.feed(raw.chunk);
  };

  private _onError = (raw: NativeErrorEvent): void => {
    if (raw.streamId !== this._streamId) return;

    const err = this._buildError(raw);
    this._metrics.lastError = err;

    this.onerror?.(err);
    this._dispatch('error', err);

    const s = this._sm.state;
    if (raw.isFatal || s === SSE_STATE.CLOSED) {
      this._transition(SSE_STATE.FAILED);
      this._cleanup(true);
    } else if (s !== SSE_STATE.PAUSED) {
      this._scheduleReconnect();
    }
  };

  private _onClose = (raw: NativeCloseEvent): void => {
    if (raw.streamId !== this._streamId) return;
    const s = this._sm.state;
    if (
      s === SSE_STATE.CLOSED ||
      s === SSE_STATE.FAILED ||
      s === SSE_STATE.PAUSED
    ) return;
    this._scheduleReconnect();
  };

  // ── Native transport listeners ───────────────────────────────────────────────

  private _attachNativeListeners(): void {
    if (!emitter) return;
    this._subscriptions.push(
      emitter.addListener('sse_open',  this._onOpen),
      emitter.addListener('sse_chunk', this._onChunk),
      emitter.addListener('sse_error', this._onError),
      emitter.addListener('sse_close', this._onClose),
    );
  }

  // ── XHR fallback transport ───────────────────────────────────────────────────

  private _doConnectFetch(): void {
    if (this._sm.state !== SSE_STATE.CONNECTING) return;

    const sid = this._streamId;

    const headers: Record<string, string> = {
      Accept:          'text/event-stream',
      'Cache-Control': 'no-cache',
      ...this._opts.headers,
    };
    if (this._lastEventId) headers['Last-Event-ID'] = this._lastEventId;

    // Create a fresh parser for this connection attempt.
    this._parser = new SseParser({
      maxLineLength: this._opts.maxLineLength ?? 1_048_576,
      onEvent: (parsed) => {
        this._onMessage({
          streamId:  sid,
          eventType: parsed.type,
          data:      parsed.data,
          id:        parsed.id ?? '',
        });
      },
      onRetry: (ms) => {
        (this._policy as FixedPatch).intervalMs = ms;
        (this._policy as FixedPatch).type = 'fixed';
      },
      onParseError: (reason) => {
        this._onError({
          streamId:  sid,
          message:   reason,
          errorCode: 'PARSE_ERROR',
          isFatal:   false,
        });
      },
    });

    const xhr = new XMLHttpRequest();
    this._xhr = xhr;
    let prevLength = 0;

    xhr.open(this._opts.method ?? 'GET', this._url, /* async */ true);
    for (const [k, v] of Object.entries(headers)) {
      xhr.setRequestHeader(k, v);
    }
    if (this._opts.timeout) xhr.timeout = this._opts.timeout;

    xhr.onreadystatechange = () => {
      // HEADERS_RECEIVED
      if (xhr.readyState === 2) {
        if (xhr.status >= 200 && xhr.status < 300) {
          this._onOpen({ streamId: sid, statusCode: xhr.status, headers: {} });
        } else {
          const isFatal = xhr.status >= 400 && xhr.status < 500;
          this._onError({
            streamId:  sid,
            message:   `HTTP error ${xhr.status}`,
            statusCode: xhr.status,
            errorCode: 'HTTP_ERROR',
            isFatal,
          });
          xhr.abort();
        }
      }
    };

    xhr.onprogress = () => {
      const chunk = xhr.responseText.slice(prevLength);
      prevLength = xhr.responseText.length;
      if (chunk && sid === this._streamId) {
        this._metrics.bytesReceived += chunk.length;
        this._resetStaleTimer();
        this._parser?.feed(chunk);
      }
    };

    xhr.onerror = () => {
      this._onError({ streamId: sid, message: 'Network request failed', errorCode: 'NETWORK_ERROR', isFatal: false });
    };

    xhr.ontimeout = () => {
      this._onError({ streamId: sid, message: 'Request timed out', errorCode: 'TIMEOUT_ERROR', isFatal: false });
    };

    xhr.onload = () => {
      if (sid !== this._streamId) return;
      this._parser?.flush();
      this._onClose({ streamId: sid });
    };

    xhr.send(this._opts.body ?? null);
  }

  // ── Fetch API fallback transport ─────────────────────────────────────────────

  private _doConnectFetchApi(): void {
    if (this._sm.state !== SSE_STATE.CONNECTING) return;

    const sid = this._streamId;
    const controller = new AbortController();
    this._fetchController = controller;

    const headers: Record<string, string> = {
      Accept:          'text/event-stream',
      'Cache-Control': 'no-cache',
      ...this._opts.headers,
    };
    if (this._lastEventId) headers['Last-Event-ID'] = this._lastEventId;

    this._parser = new SseParser({
      maxLineLength: this._opts.maxLineLength ?? 1_048_576,
      onEvent: (parsed) => {
        this._onMessage({
          streamId:  sid,
          eventType: parsed.type,
          data:      parsed.data,
          id:        parsed.id ?? '',
        });
      },
      onRetry: (ms) => {
        (this._policy as FixedPatch).intervalMs = ms;
        (this._policy as FixedPatch).type = 'fixed';
      },
      onParseError: (reason) => {
        this._onError({
          streamId:  sid,
          message:   reason,
          errorCode: 'PARSE_ERROR',
          isFatal:   false,
        });
      },
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (this._opts.timeout) {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (sid !== this._streamId || controller.signal.aborted) return;
        controller.abort();
        this._onError({
          streamId:  sid,
          message:   'Request timed out',
          errorCode: 'TIMEOUT_ERROR',
          isFatal:   false,
        });
      }, this._opts.timeout);
    }

    const fetchInit: RequestInit = {
      method:  this._opts.method ?? 'GET',
      headers,
      signal:  controller.signal,
    };
    if (this._opts.body) fetchInit.body = this._opts.body;

    fetch(this._url, fetchInit)
      .then(async (response) => {
        if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
        if (sid !== this._streamId || controller.signal.aborted) return;

        if (response.status < 200 || response.status >= 300) {
          const isFatal = response.status >= 400 && response.status < 500;
          this._onError({
            streamId:   sid,
            message:    `HTTP error ${response.status}`,
            statusCode: response.status,
            errorCode:  'HTTP_ERROR',
            isFatal,
          });
          return;
        }

        this._onOpen({ streamId: sid, statusCode: response.status, headers: {} });

        // If ReadableStream is unavailable, degrade to parsing the full text body.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!response.body || typeof (response.body as any).getReader !== 'function') {
          const text = await response.text();
          if (sid !== this._streamId) return;
          this._parser?.feed(text);
          this._parser?.flush();
          this._onClose({ streamId: sid });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (sid !== this._streamId || controller.signal.aborted) break;
            if (done) {
              this._parser?.flush();
              this._onClose({ streamId: sid });
              break;
            }
            this._metrics.bytesReceived += value.byteLength;
            this._resetStaleTimer();
            this._parser?.feed(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          if (sid !== this._streamId || controller.signal.aborted) return;
          this._onError({
            streamId:  sid,
            message:   err instanceof Error ? err.message : 'Stream read error',
            errorCode: 'NETWORK_ERROR',
            isFatal:   false,
          });
        } finally {
          reader.releaseLock();
        }
      })
      .catch((err: Error) => {
        if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
        if (sid !== this._streamId || controller.signal.aborted) return;
        this._onError({
          streamId:  sid,
          message:   err.message ?? 'Network request failed',
          errorCode: 'NETWORK_ERROR',
          isFatal:   false,
        });
      });
  }

  // ── Internal connect / reconnect ────────────────────────────────────────────

  private _doConnect(): void {
    this._streamId = nextStreamId();
    this._transition(SSE_STATE.CONNECTING);

    if (!this._useFallback) {
      // Re-attach native listeners so they filter on the new streamId.
      for (const sub of this._subscriptions) sub.remove();
      this._subscriptions = [];
      this._attachNativeListeners();
    }

    const start = (): void => {
      if (this._sm.state !== SSE_STATE.CONNECTING) return;
      if (!this._useFallback) {
        this._connectNative();
      } else if (this._fallbackType === 'fetch') {
        this._doConnectFetchApi();
      } else {
        this._doConnectFetch();
      }
    };

    if (this._opts.persistLastEventId && !this._storageLoaded) {
      this._storageAdapter
        .getItem(this._storageKey)
        .then((stored) => {
          this._storageLoaded = true;
          if (stored && !this._lastEventId) {
            this._lastEventId         = stored;
            this._metrics.lastEventId = stored;
          }
          start();
        })
        .catch(() => { this._storageLoaded = true; start(); });
    } else {
      start();
    }
  }

  private _connectNative(): void {
    if (this._sm.state !== SSE_STATE.CONNECTING) return;

    const sid = this._streamId;

    const headers: Record<string, string> = {
      Accept:          'text/event-stream',
      'Cache-Control': 'no-cache',
      ...this._opts.headers,
    };
    if (this._lastEventId) headers['Last-Event-ID'] = this._lastEventId;

    // Create a fresh parser for this native connection attempt.
    this._parser = new SseParser({
      maxLineLength: this._opts.maxLineLength ?? 1_048_576,
      onEvent: (parsed) => {
        this._onMessage({
          streamId:  sid,
          eventType: parsed.type,
          data:      parsed.data,
          id:        parsed.id ?? '',
        });
      },
      onRetry: (ms) => {
        (this._policy as FixedPatch).intervalMs = ms;
        (this._policy as FixedPatch).type = 'fixed';
      },
      onParseError: (reason) => {
        this._onError({
          streamId:  sid,
          message:   reason,
          errorCode: 'PARSE_ERROR',
          isFatal:   false,
        });
      },
    });

    NativeNativeSse.connect(this._streamId, this._url, {
      method:        this._opts.method        ?? 'GET',
      headers,
      body:          this._opts.body          ?? '',
      lastEventId:   this._lastEventId,
      timeout:       this._opts.timeout       ?? 0,
      maxLineLength: this._opts.maxLineLength ?? 1_048_576,
    });
  }

  private _scheduleReconnect(): void {
    const s = this._sm.state;
    if (
      s === SSE_STATE.CLOSED ||
      s === SSE_STATE.FAILED ||
      s === SSE_STATE.PAUSED
    ) return;

    if (this._maxAttempts !== -1 && this._reconnectAttempts >= this._maxAttempts) {
      this._transition(SSE_STATE.FAILED);
      this._cleanup(true);
      const err = this._makeError('MAX_RETRIES_EXCEEDED', `Max reconnect attempts (${this._maxAttempts}) reached`, undefined, false);
      this._metrics.lastError = err;
      this.onerror?.(err);
      this._dispatch('error', err);
      return;
    }

    this._reconnectAttempts += 1;
    this._metrics.reconnectCount += 1;
    this._transition(SSE_STATE.RECONNECTING);

    if (this._networkBlocked) {
      if (this._opts.debug) console.log('[NativeSSE] Offline — will reconnect when network returns.');
      return;
    }

    const delay = computeDelay(this._policy, this._reconnectAttempts);

    if (this._opts.debug) {
      console.log(
        `[NativeSSE] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}` +
          (this._maxAttempts !== -1 ? `/${this._maxAttempts}` : '') +
          `) policy=${this._policy.type}`,
      );
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      const cur = this._sm.state;
      if (
        cur !== SSE_STATE.CLOSED &&
        cur !== SSE_STATE.FAILED &&
        cur !== SSE_STATE.PAUSED
      ) {
        this._doConnect();
      }
    }, delay);
  }

  // ── Lifecycle (network) ─────────────────────────────────────────────────────

  private _handleNetworkChange = (isConnected: boolean): void => {
    if (!isConnected) {
      this._networkBlocked = true;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this._opts.debug) console.log('[NativeSSE] Network lost — reconnect suspended.');
      return;
    }

    this._networkBlocked = false;
    if (this._sm.state === SSE_STATE.RECONNECTING) {
      if (this._opts.debug) console.log('[NativeSSE] Network restored — reconnecting immediately.');
      this._doConnect();
    }
  };

  // ── State transition (with stateChange event) ───────────────────────────────

  private _transition(next: SseState): void {
    const from = this._sm.state;
    this._sm.transition(next);
    const evt: SseStateChangeEvent = { from, to: next };
    this.onstatechange?.(evt);
    this._dispatch('stateChange', evt);
  }

  // ── Event delivery ──────────────────────────────────────────────────────────

  private _deliverSingle(evt: SseMessageEvent): void {
    this._dispatch(evt.type, evt);
    if (evt.type === 'message') this.onmessage?.(evt);
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

  private _resetStaleTimer(): void {
    if (!this._staleTimeoutMs) return;
    if (this._staleTimer !== null) clearTimeout(this._staleTimer);
    this._staleTimer = setTimeout(() => {
      this._staleTimer = null;
      const s = this._sm.state;
      if (s !== SSE_STATE.OPEN && s !== SSE_STATE.CONNECTING) return;

      if (this._opts.debug) {
        console.log(`[NativeSSE] Stale connection detected (no data for ${this._staleTimeoutMs}ms) — reconnecting.`);
      }

      this._transition(SSE_STATE.STALE);
      this._metrics.staleCount += 1;

      const err = this._makeError('TIMEOUT_ERROR', `No data received for ${this._staleTimeoutMs}ms (stale connection)`, undefined, true);
      this._metrics.lastError = err;
      this.onerror?.(err);
      this._dispatch('error', err);

      if (this._useFallback) {
        this._xhr?.abort();
        this._xhr = null;
        this._fetchController?.abort();
        this._fetchController = null;
      } else {
        NativeNativeSse?.disconnect(this._streamId);
      }
      this._scheduleReconnect();
    }, this._staleTimeoutMs);
  }

  private _clearStaleTimer(): void {
    if (this._staleTimer !== null) {
      clearTimeout(this._staleTimer);
      this._staleTimer = null;
    }
  }

  private _cleanup(removeAll = false): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._clearStaleTimer();

    // Abort fallback transport connections.
    if (this._xhr !== null) {
      this._xhr.abort();
      this._xhr = null;
    }
    if (this._fetchController !== null) {
      this._fetchController.abort();
      this._fetchController = null;
    }
    this._parser?.reset();

    for (const sub of this._subscriptions) sub.remove();
    this._subscriptions = [];

    // AppState and network subscriptions survive pause/resume; only close() removes them.
    if (removeAll) {
      this._appLifecycle?.stop();
      this._networkMonitor.stop();
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
