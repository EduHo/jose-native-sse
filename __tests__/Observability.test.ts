import { __emit, __reset, NativeModules } from '../__mocks__/react-native';
import { NativeSSE } from '../src/EventSource';
import { SSE_STATE } from '../src/types';

const mockConnect    = NativeModules.NativeNativeSse.connect    as jest.Mock;
const mockDisconnect = NativeModules.NativeNativeSse.disconnect as jest.Mock;

const URL = 'http://example.com/events';

function lastStreamId(): string {
  return mockConnect.mock.calls.at(-1)?.[0] as string;
}
function emitOpen()  { __emit('sse_open',  { streamId: lastStreamId(), statusCode: 200, headers: {} }); }
function emitError(isFatal = false, errorCode = 'NETWORK_ERROR') {
  __emit('sse_error', { streamId: lastStreamId(), message: 'err', isFatal, errorCode });
}
function emitChunk() {
  const sid = lastStreamId();
  __emit('sse_chunk', { streamId: sid, chunk: 'data: x\n\n', byteLength: 9 });
}

beforeEach(() => { jest.useFakeTimers(); __reset(); });
afterEach(()  => { jest.useRealTimers(); });

// ─── onReconnectAttempt ───────────────────────────────────────────────────────

describe('observability – onReconnectAttempt', () => {
  it('is called with attempt number and delay when reconnect is scheduled', () => {
    const onReconnectAttempt = jest.fn();
    const sse = new NativeSSE(URL, {
      reconnectPolicy: { type: 'fixed', intervalMs: 1000 },
      onReconnectAttempt,
    });

    emitOpen();
    emitError(false);

    expect(onReconnectAttempt).toHaveBeenCalledTimes(1);
    expect(onReconnectAttempt).toHaveBeenCalledWith(1, expect.any(Number));
    sse.close();
  });

  it('increments attempt count on each reconnect', () => {
    const onReconnectAttempt = jest.fn();
    const sse = new NativeSSE(URL, {
      reconnectPolicy: { type: 'fixed', intervalMs: 100 },
      onReconnectAttempt,
    });

    emitOpen();
    emitError(); // attempt 1
    jest.runAllTimers();
    emitError(); // attempt 2
    jest.runAllTimers();
    emitError(); // attempt 3

    expect(onReconnectAttempt).toHaveBeenCalledTimes(3);
    expect(onReconnectAttempt.mock.calls[0]![0]).toBe(1);
    expect(onReconnectAttempt.mock.calls[1]![0]).toBe(2);
    expect(onReconnectAttempt.mock.calls[2]![0]).toBe(3);
    sse.close();
  });

  it('is NOT called when close() is invoked', () => {
    const onReconnectAttempt = jest.fn();
    const sse = new NativeSSE(URL, { onReconnectAttempt });
    emitOpen();
    sse.close();
    expect(onReconnectAttempt).not.toHaveBeenCalled();
  });
});

// ─── onReconnectSuccess ───────────────────────────────────────────────────────

describe('observability – onReconnectSuccess', () => {
  it('is called when a reconnected stream opens successfully', () => {
    const onReconnectSuccess = jest.fn();
    const sse = new NativeSSE(URL, {
      reconnectPolicy: { type: 'fixed', intervalMs: 100 },
      onReconnectSuccess,
    });

    emitOpen();
    emitError(); // triggers reconnect
    jest.runAllTimers();
    emitOpen(); // reconnect succeeds

    expect(onReconnectSuccess).toHaveBeenCalledTimes(1);
    sse.close();
  });

  it('is NOT called on the first (non-reconnect) open', () => {
    const onReconnectSuccess = jest.fn();
    const sse = new NativeSSE(URL, { onReconnectSuccess });
    emitOpen();
    expect(onReconnectSuccess).not.toHaveBeenCalled();
    sse.close();
  });
});

// ─── onStale ─────────────────────────────────────────────────────────────────

describe('observability – onStale', () => {
  it('is called when the stale timer fires', () => {
    const onStale = jest.fn();
    const sse = new NativeSSE(URL, { staleTimeoutMs: 5000, onStale });

    emitOpen();
    emitChunk(); // resets stale timer
    jest.advanceTimersByTime(5001); // trigger stale

    expect(onStale).toHaveBeenCalledTimes(1);
    // After stale fires, the library immediately schedules a reconnect,
    // so state is RECONNECTING by the time we observe it.
    expect(sse.state).toBe(SSE_STATE.RECONNECTING);
    sse.close();
  });

  it('is NOT called before staleTimeoutMs elapses', () => {
    const onStale = jest.fn();
    const sse = new NativeSSE(URL, { staleTimeoutMs: 5000, onStale });

    emitOpen();
    emitChunk();
    jest.advanceTimersByTime(3000); // not yet

    expect(onStale).not.toHaveBeenCalled();
    sse.close();
  });
});

// ─── onFatalError ─────────────────────────────────────────────────────────────

describe('observability – onFatalError', () => {
  it('is called when max reconnect attempts are exhausted', () => {
    const onFatalError = jest.fn();
    // maxReconnectAttempts: 1 means: after the first unsuccessful reconnect
    // attempt, the next failure triggers FAILED.
    // Sequence: open → error (attempt 1 scheduled) → timer → error (1 >= 1 → FAILED)
    const sse = new NativeSSE(URL, {
      reconnectPolicy:      { type: 'fixed', intervalMs: 100 },
      maxReconnectAttempts: 1,
      onFatalError,
    });

    emitOpen();
    emitError();          // schedules reconnect attempt #1
    jest.runAllTimers();  // fires the reconnect timer
    emitError();          // reconnect #1 fails → limit reached → FAILED

    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError.mock.calls[0]![0].code).toBe('MAX_RETRIES_EXCEEDED');
    expect(sse.state).toBe(SSE_STATE.FAILED);
    sse.close();
  });

  it('is called on a fatal HTTP 4xx error', () => {
    const onFatalError = jest.fn();
    const sse = new NativeSSE(URL, { onFatalError });

    __emit('sse_error', {
      streamId:  lastStreamId(),
      message:   'HTTP error 401',
      statusCode: 401,
      errorCode:  'HTTP_ERROR',
      isFatal:    true,
    });

    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError.mock.calls[0]![0].code).toBe('HTTP_ERROR');
    sse.close();
  });

  it('is NOT called for retryable errors', () => {
    const onFatalError = jest.fn();
    const sse = new NativeSSE(URL, { onFatalError });

    emitOpen();
    emitError(false, 'NETWORK_ERROR'); // retryable

    expect(onFatalError).not.toHaveBeenCalled();
    sse.close();
  });
});

// ─── disconnect mock (suppress RN warnings in teardown) ───────────────────────
afterAll(() => {
  mockDisconnect.mockReset();
});
