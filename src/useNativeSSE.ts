import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeSSE } from './EventSource';
import { CLOSED, CONNECTING, OPEN, SSE_STATE } from './types';
import type {
  SseConnectOptions,
  SseErrorEvent,
  SseMessageEvent,
  SseReadyState,
  SseState,
  StreamMetrics,
} from './types';

const DEFAULT_METRICS: StreamMetrics = {
  bytesReceived:      0,
  eventsReceived:     0,
  reconnectCount:     0,
  staleCount:         0,
  lastEventId:        '',
  lastEventTimestamp: null,
  lastError:          null,
  connectedAt:        null,
};

export interface UseNativeSSEOptions extends SseConnectOptions {
  /** When false, the hook will not open a connection. Default: true. */
  enabled?: boolean;
  /**
   * How often to refresh the `metrics` snapshot, in milliseconds.
   *
   * Metrics also refresh on every state change and error. They are deliberately
   * not refreshed per event: that turned every event into a re-render.
   * Default: 1000.
   */
  metricsIntervalMs?: number;
}

export interface UseNativeSSEResult {
  /** Current fine-grained connection state. */
  state: SseState;
  /** Browser-compatible ready state (0 | 1 | 2). */
  readyState: SseReadyState;
  /**
   * Most recently received message. Null until the first message arrives.
   *
   * This is a **preview of the latest event, not a log**. React coalesces state
   * updates, so when several events land in the same tick only the last one is
   * ever rendered. Anything that must see every event — accumulating tokens from
   * an LLM, appending to a list — has to read them from the stream instead:
   *
   * ```tsx
   * const { sse } = useNativeSSE(url);
   * useEffect(() => {
   *   if (!sse) return;
   *   const onMessage = (e: SseMessageEvent) => setText((t) => t + e.data);
   *   sse.addEventListener('message', onMessage);
   *   return () => sse.removeEventListener('message', onMessage);
   * }, [sse]);
   * ```
   *
   * For high-frequency streams also pass `batch: { enabled: true }` and read
   * `lastBatch`, which delivers whole groups instead of one render per event.
   */
  lastMessage: SseMessageEvent | null;
  /**
   * The underlying stream, or null before the first connection is created.
   *
   * Use it for `addEventListener` on custom event types, and for reading every
   * event rather than only the most recent one.
   */
  sse: NativeSSE | null;
  /**
   * Most recently flushed batch of events. Only populated when
   * `batch.enabled: true` is passed in options. Null otherwise.
   */
  lastBatch: SseMessageEvent[] | null;
  /** Most recent error. Null if no error has occurred. */
  lastError: SseErrorEvent | null;
  /** Snapshot of stream metrics, updated on each message and state change. */
  metrics: StreamMetrics;
  pause:     () => void;
  resume:    () => void;
  /**
   * Force an immediate reconnect without backoff. Use after refreshing an auth
   * token or when showing a manual "Retry" button. No-op if closed or failed.
   */
  reconnect: () => void;
  close:     () => void;
}

function stateToReadyState(s: SseState): SseReadyState {
  if (s === SSE_STATE.OPEN)                                  return OPEN;
  if (s === SSE_STATE.CLOSED || s === SSE_STATE.FAILED)      return CLOSED;
  return CONNECTING;
}

/**
 * React hook for consuming an SSE stream.
 *
 * Manages the full NativeSSE lifecycle: opens the connection on mount,
 * closes it on unmount, and reconnects automatically when `url` changes.
 * Options are captured in a ref — changing them does not trigger a reconnect.
 *
 * @example
 * ```tsx
 * const { state, lastMessage } = useNativeSSE('https://api.example.com/events', {
 *   headers: { Authorization: `Bearer ${token}` },
 *   reconnectPolicy: { type: 'exponential', initialMs: 1000, maxMs: 30_000 },
 * });
 * ```
 */
export function useNativeSSE(
  url: string,
  options?: UseNativeSSEOptions,
): UseNativeSSEResult {
  const enabled = options?.enabled !== false;
  const metricsIntervalMs = options?.metricsIntervalMs ?? 1000;

  const [state, setState]             = useState<SseState>(SSE_STATE.IDLE);
  const [lastMessage, setLastMessage] = useState<SseMessageEvent | null>(null);
  const [lastBatch, setLastBatch]     = useState<SseMessageEvent[] | null>(null);
  const [lastError, setLastError]     = useState<SseErrorEvent | null>(null);
  const [metrics, setMetrics]         = useState<StreamMetrics>(DEFAULT_METRICS);

  const sseRef  = useRef<NativeSSE | null>(null);
  const [instance, setInstance] = useState<NativeSSE | null>(null);
  // Keep options in a ref so that re-renders with new option objects don't
  // tear down and re-open the connection.
  const optsRef = useRef<UseNativeSSEOptions | undefined>(options);
  // Written in an effect rather than during render: mutating a ref while
  // rendering is not safe under React 19 concurrent rendering, where a render
  // can be discarded.
  useEffect(() => {
    optsRef.current = options;
  });

  useEffect(() => {
    if (!enabled) {
      setState(SSE_STATE.IDLE);
      return;
    }

    const sse = new NativeSSE(url, { ...optsRef.current, autoConnect: false });
    sseRef.current = sse;
    setInstance(sse);

    // `getMetrics()` returns a fresh object every call, so refreshing it on each
    // event forced a re-render per event even when nothing observable changed —
    // 50–100 renders/second on a token stream. Metrics now refresh on state
    // changes and on a slow interval instead.
    const refreshMetrics = () => setMetrics(sse.getMetrics());

    sse.onstatechange = ({ to }) => {
      setState(to);
      refreshMetrics();
    };
    sse.onmessage = (evt) => setLastMessage(evt);
    sse.onbatch = (evts) => setLastBatch(evts);
    sse.onerror = (err) => {
      setLastError(err);
      refreshMetrics();
    };

    const metricsTimer = setInterval(refreshMetrics, metricsIntervalMs);

    sse.connect();

    return () => {
      clearInterval(metricsTimer);
      sse.close();
      sseRef.current = null;
      setInstance(null);
    };
  }, [url, enabled, metricsIntervalMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const pause     = useCallback(() => sseRef.current?.pause(),     []);
  const resume    = useCallback(() => sseRef.current?.resume(),    []);
  const reconnect = useCallback(() => sseRef.current?.reconnect(), []);
  const close     = useCallback(() => sseRef.current?.close(),     []);

  return {
    state,
    readyState: stateToReadyState(state),
    sse: instance,
    lastMessage,
    lastBatch,
    lastError,
    metrics,
    pause,
    resume,
    reconnect,
    close,
  };
}
