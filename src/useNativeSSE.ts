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
}

export interface UseNativeSSEResult {
  /** Current fine-grained connection state. */
  state: SseState;
  /** Browser-compatible ready state (0 | 1 | 2). */
  readyState: SseReadyState;
  /** Most recently received message. Null until the first message arrives. */
  lastMessage: SseMessageEvent | null;
  /** Most recent error. Null if no error has occurred. */
  lastError: SseErrorEvent | null;
  /** Snapshot of stream metrics, updated on each message and state change. */
  metrics: StreamMetrics;
  pause:  () => void;
  resume: () => void;
  close:  () => void;
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

  const [state, setState]             = useState<SseState>(SSE_STATE.IDLE);
  const [lastMessage, setLastMessage] = useState<SseMessageEvent | null>(null);
  const [lastError, setLastError]     = useState<SseErrorEvent | null>(null);
  const [metrics, setMetrics]         = useState<StreamMetrics>(DEFAULT_METRICS);

  const sseRef  = useRef<NativeSSE | null>(null);
  // Keep options in a ref so that re-renders with new option objects don't
  // tear down and re-open the connection.
  const optsRef = useRef<UseNativeSSEOptions | undefined>(options);
  optsRef.current = options;

  useEffect(() => {
    if (!enabled) {
      setState(SSE_STATE.IDLE);
      return;
    }

    const sse = new NativeSSE(url, { ...optsRef.current, autoConnect: false });
    sseRef.current = sse;

    sse.onstatechange = ({ to }) => {
      setState(to);
      setMetrics(sse.getMetrics());
    };
    sse.onmessage = (evt) => {
      setLastMessage(evt);
      setMetrics(sse.getMetrics());
    };
    sse.onerror = (err) => {
      setLastError(err);
      setMetrics(sse.getMetrics());
    };

    sse.connect();

    return () => {
      sse.close();
      sseRef.current = null;
    };
  }, [url, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const pause  = useCallback(() => sseRef.current?.pause(),  []);
  const resume = useCallback(() => sseRef.current?.resume(), []);
  const close  = useCallback(() => sseRef.current?.close(),  []);

  return {
    state,
    readyState: stateToReadyState(state),
    lastMessage,
    lastError,
    metrics,
    pause,
    resume,
    close,
  };
}
