/**
 * Tests for stale-connection detection and network-awareness reconnect.
 */

import { __emit, __reset, NativeModules } from '../__mocks__/react-native';
import { NativeSSE } from '../src/EventSource';
import { SSE_STATE } from '../src/types';

const mockConnect    = NativeModules.NativeNativeSse.connect    as jest.Mock;
const mockDisconnect = NativeModules.NativeNativeSse.disconnect as jest.Mock;

const URL = 'http://example.com/events';

function lastStreamId(): string {
  const calls = mockConnect.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}

function emitOpen() {
  __emit('sse_open', { streamId: lastStreamId(), statusCode: 200, headers: {} });
}

function emitMessage(data = 'hello') {
  const text = `data: ${data}\n\n`;
  __emit('sse_chunk', { streamId: lastStreamId(), chunk: text, byteLength: text.length });
}

beforeEach(() => { jest.useFakeTimers(); __reset(); });
afterEach(()  => { jest.useRealTimers(); });

// ─── Stale detection ──────────────────────────────────────────────────────────

describe('NativeSSE – stale detection', () => {
  it('triggers reconnect when no data received within staleTimeoutMs', () => {
    const sse = new NativeSSE(URL, { staleTimeoutMs: 5_000 });
    emitOpen();
    expect(sse.state).toBe(SSE_STATE.OPEN);

    jest.advanceTimersByTime(5_000);

    // Should have disconnected and be in RECONNECTING state.
    expect(mockDisconnect).toHaveBeenCalled();
    expect(sse.state).toBe(SSE_STATE.RECONNECTING);
    sse.close();
  });

  it('resets the stale timer on each received message', () => {
    const sse = new NativeSSE(URL, { staleTimeoutMs: 5_000 });
    emitOpen();

    // Advance to just before the timeout fires, then send a message.
    jest.advanceTimersByTime(4_000);
    emitMessage('ping');
    expect(sse.state).toBe(SSE_STATE.OPEN); // not stale yet

    // Advance another 4 s — timer was reset, so total since last message = 4 s < 5 s.
    jest.advanceTimersByTime(4_000);
    expect(sse.state).toBe(SSE_STATE.OPEN);

    // Now let the full 5 s elapse from the last message.
    jest.advanceTimersByTime(1_001);
    expect(sse.state).toBe(SSE_STATE.RECONNECTING);
    sse.close();
  });

  it('resets the stale timer on open event', () => {
    const sse = new NativeSSE(URL, { staleTimeoutMs: 3_000 });
    emitOpen(); // timer starts here

    jest.advanceTimersByTime(2_900);
    expect(sse.state).toBe(SSE_STATE.OPEN);
    jest.advanceTimersByTime(200); // crosses the 3 s threshold
    expect(sse.state).toBe(SSE_STATE.RECONNECTING);
    sse.close();
  });

  it('calls onerror with TIMEOUT_ERROR when stale', () => {
    const sse = new NativeSSE(URL, { staleTimeoutMs: 2_000 });
    const onerror = jest.fn();
    sse.onerror = onerror;
    emitOpen();

    jest.advanceTimersByTime(2_000);

    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TIMEOUT_ERROR', retryable: true }),
    );
    sse.close();
  });

  it('does not trigger stale reconnect after close()', () => {
    const sse = new NativeSSE(URL, { staleTimeoutMs: 2_000 });
    emitOpen();
    sse.close();

    jest.advanceTimersByTime(5_000);

    // Only 1 connect call (from constructor auto-connect). No reconnect.
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.CLOSED);
  });

  it('does not trigger stale reconnect while paused', () => {
    const sse = new NativeSSE(URL, { staleTimeoutMs: 2_000 });
    emitOpen();
    sse.pause();

    jest.advanceTimersByTime(5_000);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    sse.close();
  });

  it('does not fire stale timer when staleTimeoutMs is not set', () => {
    const sse = new NativeSSE(URL); // no staleTimeoutMs
    emitOpen();

    jest.advanceTimersByTime(60_000);

    // Still open — no stale detection running.
    expect(sse.state).toBe(SSE_STATE.OPEN);
    sse.close();
  });
});

// ─── Network awareness ────────────────────────────────────────────────────────

describe('NativeSSE – network awareness', () => {
  function makeNetworkObserver() {
    let _handler: ((isConnected: boolean) => void) | null = null;
    const unsub = jest.fn();

    const observer = {
      subscribe: jest.fn((cb: (isConnected: boolean) => void) => {
        _handler = cb;
        return unsub;
      }),
      // Test helper: simulate network going up/down.
      simulateChange(isConnected: boolean) {
        _handler?.(isConnected);
      },
    };
    return { observer, unsub };
  }

  it('calls subscribe on construction', () => {
    const { observer } = makeNetworkObserver();
    const sse = new NativeSSE(URL, { networkObserver: observer });
    expect(observer.subscribe).toHaveBeenCalledTimes(1);
    sse.close();
  });

  it('unsubscribes on close()', () => {
    const { observer, unsub } = makeNetworkObserver();
    const sse = new NativeSSE(URL, { networkObserver: observer });
    sse.close();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('reconnects immediately when network restores during RECONNECTING', () => {
    const { observer } = makeNetworkObserver();
    const sse = new NativeSSE(URL, {
      networkObserver: observer,
      reconnectPolicy: { type: 'fixed', intervalMs: 30_000 },
    });
    emitOpen();

    // Simulate connection drop → stream enters RECONNECTING with 30 s timer.
    __emit('sse_error', {
      streamId: lastStreamId(), message: 'drop', isFatal: false, errorCode: 'NETWORK_ERROR',
    });
    expect(sse.state).toBe(SSE_STATE.RECONNECTING);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Network comes back → should reconnect immediately without waiting 30 s.
    observer.simulateChange(true);
    expect(sse.state).toBe(SSE_STATE.CONNECTING);
    expect(mockConnect).toHaveBeenCalledTimes(2);

    sse.close();
  });

  it('does nothing when network drops (isConnected: false)', () => {
    const { observer } = makeNetworkObserver();
    const sse = new NativeSSE(URL, { networkObserver: observer });
    emitOpen();
    expect(sse.state).toBe(SSE_STATE.OPEN);

    observer.simulateChange(false);
    expect(sse.state).toBe(SSE_STATE.OPEN); // no state change from offline event
    sse.close();
  });

  it('network restore is a no-op when already OPEN', () => {
    const { observer } = makeNetworkObserver();
    const sse = new NativeSSE(URL, { networkObserver: observer });
    emitOpen();

    observer.simulateChange(true);
    expect(mockConnect).toHaveBeenCalledTimes(1); // no extra connect
    sse.close();
  });

  it('network restore is a no-op when CLOSED', () => {
    const { observer } = makeNetworkObserver();
    const sse = new NativeSSE(URL, { networkObserver: observer });
    emitOpen();
    sse.close();

    observer.simulateChange(true);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.CLOSED);
  });

  it('network restore is a no-op when PAUSED', () => {
    const { observer } = makeNetworkObserver();
    const sse = new NativeSSE(URL, { networkObserver: observer });
    emitOpen();
    sse.pause();

    observer.simulateChange(true);
    // PAUSED is an explicit user action — network restore should not override it.
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    sse.close();
  });
});
