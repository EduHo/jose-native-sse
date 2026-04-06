// ─── Core classes ─────────────────────────────────────────────────────────────
export { NativeSSE } from './EventSource';
export { SseStreamManager } from './StreamManager';
export { SseParser } from './SseParser';

// ─── V1 backward-compatible constants ────────────────────────────────────────
export { CLOSED, CONNECTING, OPEN } from './types';

// ─── V2 state constants ───────────────────────────────────────────────────────
export { SSE_STATE } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  // Options
  SseConnectOptions,
  BatchConfig,
  ReconnectPolicy,
  FixedReconnectPolicy,
  ExponentialReconnectPolicy,
  // States
  SseReadyState,
  SseState,
  // Events
  SseOpenEvent,
  SseMessageEvent,
  SseErrorEvent,
  // Errors
  SseError,
  SseErrorCode,
  // Metrics
  StreamMetrics,
} from './types';

export type { ParsedEvent, SseParserOptions } from './SseParser';

// ─── Reconnect helpers ────────────────────────────────────────────────────────
export { computeDelay, resolvePolicy } from './reconnect';
