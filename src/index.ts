// ─── Core classes ─────────────────────────────────────────────────────────────
export { NativeSSE } from './EventSource';
export { SseStreamManager } from './StreamManager';
export { SseParser } from './SseParser';
export { StateMachine } from './StateMachine';
export { AppLifecycleManager } from './AppLifecycleManager';
export { NetworkMonitor } from './NetworkMonitor';
export { AsyncStorageAdapter, InMemoryStorageAdapter } from './storage';

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
  NetworkObserver,
  StorageAdapter,
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
