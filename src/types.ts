// ─── V1 backward-compatible ready states ─────────────────────────────────────

export const CONNECTING = 0 as const;
export const OPEN       = 1 as const;
export const CLOSED     = 2 as const;

export type SseReadyState = typeof CONNECTING | typeof OPEN | typeof CLOSED;

// ─── V2 fine-grained connection states ───────────────────────────────────────

export const SSE_STATE = {
  /** Instance created; connect() not yet called (autoConnect: false). */
  IDLE:         'idle',
  /** HTTP request is in flight; awaiting server response headers. */
  CONNECTING:   'connecting',
  /** Streaming; receiving events. */
  OPEN:         'open',
  /**
   * No data received within staleTimeoutMs. The native connection is being
   * torn down and a reconnect will be scheduled immediately after.
   */
  STALE:        'stale',
  /** Waiting for the reconnect timer before the next attempt. */
  RECONNECTING: 'reconnecting',
  /** Paused by pause() or app backgrounding. Will resume on resume(). */
  PAUSED:       'paused',
  /** Permanently closed by close(). No further reconnects. */
  CLOSED:       'closed',
  /** All reconnect attempts exhausted. No further reconnects. */
  FAILED:       'failed',
} as const;

export type SseState = typeof SSE_STATE[keyof typeof SSE_STATE];

// ─── Structured error ─────────────────────────────────────────────────────────

export type SseErrorCode =
  | 'NETWORK_ERROR'       // TCP/DNS failure
  | 'HTTP_ERROR'          // Non-2xx HTTP status
  | 'TIMEOUT_ERROR'       // Request / idle timeout
  | 'PARSE_ERROR'         // Malformed SSE or buffer overflow
  | 'INVALID_URL'         // URL could not be parsed
  | 'MAX_RETRIES_EXCEEDED'// Reconnect limit hit
  | 'ABORTED';            // Cancelled programmatically (pause/close)

export interface SseError {
  code: SseErrorCode;
  message: string;
  /** HTTP status for HTTP_ERROR. */
  statusCode?: number;
  /** Unix timestamp (ms) of the error. */
  timestamp: number;
  /** Whether the library will attempt to reconnect. */
  retryable: boolean;
}

// ─── Reconnect policies ───────────────────────────────────────────────────────

export interface FixedReconnectPolicy {
  type: 'fixed';
  /** Delay in ms between every reconnect attempt (default 3000). */
  intervalMs: number;
}

export interface ExponentialReconnectPolicy {
  type: 'exponential';
  /** Initial delay in ms (default 1000). */
  initialMs: number;
  /** Maximum delay cap in ms (default 30000). */
  maxMs: number;
  /** Backoff multiplier (default 2). */
  factor?: number;
  /**
   * Add ±20 % random jitter to each interval.
   * Prevents thundering-herd when many clients reconnect simultaneously.
   * Default: true.
   */
  jitter?: boolean;
}

export type ReconnectPolicy = FixedReconnectPolicy | ExponentialReconnectPolicy;

// ─── Batching ─────────────────────────────────────────────────────────────────

export interface BatchConfig {
  /** Enable event batching (default false). */
  enabled: boolean;
  /**
   * Maximum time in ms before a partial batch is flushed.
   * Default: 16 (one animation frame).
   */
  flushIntervalMs?: number;
  /**
   * Flush immediately when this many events accumulate before the timer fires.
   * Default: 50.
   */
  maxBatchSize?: number;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface StreamMetrics {
  /** Total UTF-8 bytes received (summed from native byteLength fields). */
  bytesReceived: number;
  /** Total number of SSE events dispatched to JS handlers. */
  eventsReceived: number;
  /** Number of reconnect attempts since the stream was created. */
  reconnectCount: number;
  /** Number of times a stale/zombie connection was detected. */
  staleCount: number;
  /** Value of the most recent `id:` field received. */
  lastEventId: string;
  /** Unix timestamp (ms) of the most recent event, or null. */
  lastEventTimestamp: number | null;
  /** The most recent error, or null if no error has occurred. */
  lastError: SseError | null;
  /** Unix timestamp (ms) of the most recent sse_open, or null. */
  connectedAt: number | null;
}

// ─── Storage adapter (for Last-Event-ID persistence) ─────────────────────────

/**
 * Minimal async key-value interface for persisting the last event ID.
 *
 * Built-in implementations: `InMemoryStorageAdapter` (default) and
 * `AsyncStorageAdapter` (requires @react-native-async-storage/async-storage).
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// ─── Network observer (pluggable, no hard dependency) ────────────────────────

/**
 * Minimal interface for network connectivity observation.
 * Implement this to integrate any network library (e.g. @react-native-community/netinfo).
 *
 * @example
 * ```ts
 * import NetInfo from '@react-native-community/netinfo';
 *
 * const sse = new NativeSSE(url, {
 *   networkObserver: {
 *     subscribe: (cb) =>
 *       NetInfo.addEventListener((state) => cb(!!state.isConnected)),
 *   },
 * });
 * ```
 */
export interface NetworkObserver {
  /**
   * Subscribe to connectivity changes.
   * @param onStateChange called with `true` when connected, `false` when not.
   * @returns a cleanup function that removes the subscription.
   */
  subscribe(onStateChange: (isConnected: boolean) => void): () => void;
}

// ─── Connect options (V2 superset of V1) ─────────────────────────────────────

export interface SseConnectOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;

  // ── Reconnect ──────────────────────────────────────────────────────────────
  /**
   * Reconnect policy.
   * V1 compat: if `reconnectInterval` is provided instead, a fixed policy
   * is constructed from it automatically.
   */
  reconnectPolicy?: ReconnectPolicy;
  /** @deprecated V1 compat – use reconnectPolicy instead. */
  reconnectInterval?: number;
  /** Maximum reconnect attempts. -1 = infinite (default). */
  maxReconnectAttempts?: number;

  // ── Transport ──────────────────────────────────────────────────────────────
  /** Request timeout in ms. 0 = no timeout (default). */
  timeout?: number;
  /**
   * Maximum byte length of a single SSE line in the native parser.
   * Lines exceeding this trigger a PARSE_ERROR and the line is dropped.
   * Default: 1 048 576 (1 MB).
   */
  maxLineLength?: number;

  // ── Stale detection ───────────────────────────────────────────────────────
  /**
   * If no event (open or message) is received within this many milliseconds,
   * the connection is considered stale (zombie) and a reconnect is triggered.
   * Resets on every received event. Disabled when 0 or omitted (default).
   *
   * Useful when the server may silently drop a connection without closing it
   * (e.g. NAT/proxy timeouts, iOS background HTTP keep-alive limits).
   *
   * @example 30_000  // reconnect if no data for 30 seconds
   */
  staleTimeoutMs?: number;

  // ── Network awareness ─────────────────────────────────────────────────────
  /**
   * Plug-in network observer.
   * When provided, the client will reconnect immediately (bypassing backoff)
   * when connectivity is restored while in RECONNECTING state.
   *
   * See the `NetworkObserver` interface for the expected contract.
   */
  networkObserver?: NetworkObserver;

  // ── Auto network awareness (netinfo) ─────────────────────────────────────
  /**
   * Automatically integrate with @react-native-community/netinfo (optional
   * peer dependency). When true:
   *  - Pending reconnect timers are cancelled while offline.
   *  - Reconnect happens immediately (bypassing backoff) when connectivity
   *    is restored.
   * Silently disabled if netinfo is not installed.
   * Default: false.
   *
   * Note: If `networkObserver` is also provided, it takes precedence.
   */
  networkAwareness?: boolean;

  // ── Last-Event-ID persistence ─────────────────────────────────────────────
  /**
   * Persist the last received event ID to storage so that reconnects after an
   * app restart resume from where they left off.
   * Default: false (in-memory only, lost on restart).
   */
  persistLastEventId?: boolean;
  /**
   * Storage key used to persist the last event ID.
   * Default: 'sse:last-event-id'.
   */
  storageKey?: string;
  /**
   * Storage adapter for last-event-id persistence.
   * Default: `InMemoryStorageAdapter`.
   * Use `AsyncStorageAdapter` for cross-restart persistence (requires
   * @react-native-async-storage/async-storage).
   */
  storageAdapter?: StorageAdapter;

  // ── Transport selection ──────────────────────────────────────────────────
  /**
   * Which transport to use for the SSE connection.
   *
   * - `'auto'` (default): native TurboModule when available, XHR otherwise.
   * - `'native'`: always use the native TurboModule (throws at runtime if absent).
   * - `'xhr'`: always use XHR — useful for Expo Go or explicit fallback testing.
   * - `'fetch'`: Fetch API + `ReadableStream.getReader()`. No `responseText`
   *   accumulation in memory, ideal for long-lived streams on RN 0.71+ / Hermes.
   *   Falls back to XHR if `response.body` is unavailable.
   */
  transport?: 'auto' | 'native' | 'xhr' | 'fetch';

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /**
   * When false (default), connect() is called automatically in the constructor.
   * Set to true to control connection timing manually.
   */
  autoConnect?: boolean;
  /**
   * Pause the stream when the app goes to the background or becomes inactive.
   * Default: false.
   *
   * @see backgroundBehavior to control what happens when the app returns to
   * the foreground.
   */
  pauseOnBackground?: boolean;
  /**
   * Controls what happens when the app goes to the background (requires
   * `pauseOnBackground: true`).
   *
   * - `'pause'` (default): stream is paused and **automatically resumed**
   *   when the app returns to the foreground.
   * - `'disconnect'`: stream is paused but **not auto-resumed** on foreground.
   *   Call `resume()` manually when ready.
   */
  backgroundBehavior?: 'pause' | 'disconnect';

  // ── Batching ──────────────────────────────────────────────────────────────
  /** Batch configuration for high-frequency streams (e.g. AI token streaming). */
  batch?: BatchConfig;

  /** Log reconnect/debug events to console (default: false). */
  debug?: boolean;
}

// ─── JS-layer event shapes ────────────────────────────────────────────────────

export interface SseOpenEvent {
  type: 'open';
  origin: string;
}

export interface SseStateChangeEvent {
  from: SseState;
  to: SseState;
}

export interface SseMessageEvent {
  type: string;
  data: string;
  lastEventId: string;
  origin: string;
}

/** V2 structured error (superset of V1 shape). */
export interface SseErrorEvent extends SseError {
  // Inherits: code, message, statusCode?, timestamp, retryable
}

// ─── Native bridge event shapes ───────────────────────────────────────────────

export interface NativeOpenEvent {
  streamId: string;
  statusCode: number;
  headers: Record<string, string>;
}

/**
 * Raw network chunk from the native transport.
 * The native layer now sends unprocessed text so all SSE parsing lives in JS.
 */
export interface NativeChunkEvent {
  streamId: string;
  /** Raw SSE text as received from the network (may span multiple lines). */
  chunk: string;
  /** UTF-8 byte length of the chunk (counted natively for accurate metrics). */
  byteLength: number;
}

/**
 * Parsed SSE event passed to JS-layer handlers.
 * Constructed internally from SseParser output; no longer emitted by native.
 */
export interface NativeMessageEvent {
  streamId: string;
  eventType: string;
  data: string;
  id: string;
}

export interface NativeErrorEvent {
  streamId: string;
  message: string;
  statusCode?: number;
  /** Classified error code from the native layer. */
  errorCode: SseErrorCode;
  /** Fatal errors: don't reconnect (e.g. HTTP 4xx, invalid URL). */
  isFatal: boolean;
}

export interface NativeCloseEvent {
  streamId: string;
}
