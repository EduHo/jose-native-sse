/**
 * Reconnect policy unit tests.
 *
 * Tests both the pure computeDelay() function and the integration with
 * NativeSSE's reconnect loop.
 */

import { __emit, __reset, NativeModules } from '../__mocks__/react-native';
import { NativeSSE } from '../src/EventSource';
import { computeDelay } from '../src/reconnect';
import { SSE_STATE } from '../src/types';

const mockConnect = NativeModules.NativeNativeSse.connect as jest.Mock;
const URL = 'http://example.com/events';

function lastStreamId() {
  const calls = mockConnect.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}
function emitOpen()  { __emit('sse_open',  { streamId: lastStreamId(), statusCode: 200, headers: {} }); }
function emitError(isFatal = false) {
  __emit('sse_error', { streamId: lastStreamId(), message: 'err', isFatal, errorCode: 'NETWORK_ERROR' });
}
function emitClose() { __emit('sse_close', { streamId: lastStreamId() }); }

beforeEach(() => { jest.useFakeTimers(); __reset(); });
afterEach(()  => { jest.useRealTimers(); });

// ─── computeDelay unit tests ──────────────────────────────────────────────────

describe('computeDelay – fixed policy', () => {
  it('returns the configured interval for every attempt', () => {
    const policy = { type: 'fixed' as const, intervalMs: 5_000 };
    expect(computeDelay(policy, 1)).toBe(5_000);
    expect(computeDelay(policy, 5)).toBe(5_000);
    expect(computeDelay(policy, 100)).toBe(5_000);
  });
});

describe('computeDelay – exponential policy', () => {
  const base = { type: 'exponential' as const, initialMs: 1_000, maxMs: 32_000, factor: 2, jitter: false };

  it('doubles the interval each attempt', () => {
    expect(computeDelay(base, 1)).toBe(1_000);
    expect(computeDelay(base, 2)).toBe(2_000);
    expect(computeDelay(base, 3)).toBe(4_000);
    expect(computeDelay(base, 4)).toBe(8_000);
    expect(computeDelay(base, 5)).toBe(16_000);
  });

  it('is capped at maxMs', () => {
    expect(computeDelay(base, 6)).toBe(32_000);
    expect(computeDelay(base, 10)).toBe(32_000);
  });

  it('uses custom factor', () => {
    const p3 = { ...base, factor: 3 };
    expect(computeDelay(p3, 1)).toBe(1_000);
    expect(computeDelay(p3, 2)).toBe(3_000);
    expect(computeDelay(p3, 3)).toBe(9_000);
  });

  it('jitter stays within ±20% of raw value', () => {
    const pJitter = { ...base, jitter: true };
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(pJitter, 2); // raw = 2000
      expect(d).toBeGreaterThanOrEqual(1_600); // 2000 * 0.8
      expect(d).toBeLessThanOrEqual(2_400);    // 2000 * 1.2
    }
  });
});

// ─── NativeSSE fixed-policy integration ──────────────────────────────────────

describe('NativeSSE – fixed reconnect policy', () => {
  it('reconnects after the fixed interval', () => {
    const sse = new NativeSSE(URL, {
      reconnectPolicy: { type: 'fixed', intervalMs: 4_000 },
    });
    emitOpen(); emitError();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3_999);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    sse.close();
  });

  it('V1 reconnectInterval option creates a fixed policy', () => {
    const sse = new NativeSSE(URL, { reconnectInterval: 2_000 });
    emitOpen(); emitError();
    jest.advanceTimersByTime(1_999);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    sse.close();
  });

  it('reconnects after server close', () => {
    const sse = new NativeSSE(URL, {
      reconnectPolicy: { type: 'fixed', intervalMs: 1_000 },
    });
    emitOpen(); emitClose();
    jest.runAllTimers();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    sse.close();
  });
});

// ─── NativeSSE exponential-policy integration ─────────────────────────────────

describe('NativeSSE – exponential reconnect policy', () => {
  it('uses exponential delays between attempts', () => {
    const sse = new NativeSSE(URL, {
      reconnectPolicy: {
        type: 'exponential',
        initialMs: 1_000, maxMs: 10_000, factor: 2, jitter: false,
      },
    });
    emitOpen();

    // Attempt 1 → 1 000 ms
    emitError();
    jest.advanceTimersByTime(999);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);

    // Attempt 2 → 2 000 ms
    emitError();
    jest.advanceTimersByTime(1_999);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(mockConnect).toHaveBeenCalledTimes(3);

    // Attempt 3 → 4 000 ms
    emitError();
    jest.advanceTimersByTime(3_999);
    expect(mockConnect).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(1);
    expect(mockConnect).toHaveBeenCalledTimes(4);

    sse.close();
  });

  it('is capped at maxMs', () => {
    const sse = new NativeSSE(URL, {
      reconnectPolicy: {
        type: 'exponential',
        initialMs: 1_000, maxMs: 2_000, factor: 10, jitter: false,
      },
    });
    emitOpen();
    emitError();
    jest.runAllTimers();
    emitError();
    // Second attempt delay = min(1000 * 10^1, 2000) = 2000
    jest.advanceTimersByTime(2_001);
    expect(mockConnect).toHaveBeenCalledTimes(3);
    sse.close();
  });
});

// ─── maxReconnectAttempts ─────────────────────────────────────────────────────

describe('NativeSSE – maxReconnectAttempts', () => {
  it('stops reconnecting after the limit', () => {
    const sse = new NativeSSE(URL, { maxReconnectAttempts: 2 });
    emitOpen();
    emitError(); jest.runAllTimers();  // attempt 1
    emitError(); jest.runAllTimers();  // attempt 2
    emitError(); jest.runAllTimers();  // would be 3 but limit reached
    expect(mockConnect).toHaveBeenCalledTimes(3); // initial + 2 reconnects
    expect(sse.state).toBe(SSE_STATE.FAILED);
  });

  it('emits MAX_RETRIES_EXCEEDED error when failing', () => {
    const onerror = jest.fn();
    const sse = new NativeSSE(URL, { maxReconnectAttempts: 1 });
    sse.onerror = onerror;
    emitOpen();
    emitError(); jest.runAllTimers(); // attempt 1
    emitError(); jest.runAllTimers(); // triggers failure
    const lastErr = onerror.mock.calls[onerror.mock.calls.length - 1]![0];
    expect(lastErr.code).toBe('MAX_RETRIES_EXCEEDED');
    expect(lastErr.retryable).toBe(false);
  });

  it('resets attempt counter on successful open', () => {
    const sse = new NativeSSE(URL, { maxReconnectAttempts: 2 });
    emitOpen();
    emitError(); jest.runAllTimers(); // session-1 reconnect attempt 1 → connect (2)
    emitError(); jest.runAllTimers(); // session-1 reconnect attempt 2 → connect (3)
    emitOpen();                        // success → counter resets to 0
    emitError(); jest.runAllTimers(); // session-2 reconnect attempt 1 → connect (4)
    emitError(); jest.runAllTimers(); // session-2 reconnect attempt 2 → connect (5)
    emitError(); jest.runAllTimers(); // attempt 3 > max → FAILED; no more connects
    // 1 initial + 2 session-1 reconnects + 2 session-2 reconnects = 5
    expect(mockConnect).toHaveBeenCalledTimes(5);
    expect(sse.state).toBe(SSE_STATE.FAILED);
  });

  it('does not reconnect after fatal error', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    __emit('sse_error', {
      streamId: lastStreamId(), message: 'HTTP 404', isFatal: true, errorCode: 'HTTP_ERROR',
    });
    jest.runAllTimers();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.FAILED);
  });

  it('server retry: field updates reconnect interval', () => {
    const sse = new NativeSSE(URL, {
      reconnectPolicy: { type: 'fixed', intervalMs: 3_000 },
    });
    emitOpen();
    // Server sends retry: 8000
    __emit('sse_chunk', {
      streamId: lastStreamId(), chunk: 'retry: 8000\n\n', byteLength: 13,
    });
    emitError();

    // Should NOT reconnect at 3 000 ms (original interval).
    jest.advanceTimersByTime(7_999);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Should reconnect at 8 000 ms.
    jest.advanceTimersByTime(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    sse.close();
  });
});
