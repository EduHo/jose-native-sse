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
  /** Value of the most recent `id:` field received. */
  lastEventId: string;
  /** Unix timestamp (ms) of the most recent event, or null. */
  lastEventTimestamp: number | null;
  /** The most recent error, or null if no error has occurred. */
  lastError: SseError | null;
  /** Unix timestamp (ms) of the most recent sse_open, or null. */
  connectedAt: number | null;
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

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /**
   * When false (default), connect() is called automatically in the constructor.
   * Set to true to control connection timing manually.
   */
  autoConnect?: boolean;
  /**
   * Pause the stream when the app goes to the background or becomes inactive,
   * and resume it when the app becomes active again.
   * Default: false.
   */
  pauseOnBackground?: boolean;

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

export interface NativeMessageEvent {
  streamId: string;
  eventType: string;
  data: string;
  id: string;
  /** UTF-8 byte length of data, counted natively. Used to track bytesReceived. */
  byteLength: number;
  retry?: number;
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
