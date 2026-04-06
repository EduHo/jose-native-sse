/**
 * Lifecycle tests — pause/resume and AppState integration.
 */

import {
  __emit,
  __reset,
  __setAppState,
  NativeModules,
} from '../__mocks__/react-native';
import { NativeSSE } from '../src/EventSource';
import { SSE_STATE } from '../src/types';

const mockConnect    = NativeModules.NativeNativeSse.connect    as jest.Mock;
const mockDisconnect = NativeModules.NativeNativeSse.disconnect as jest.Mock;
const URL = 'http://example.com/events';

function lastStreamId() {
  const calls = mockConnect.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}
function emitOpen() {
  __emit('sse_open', { streamId: lastStreamId(), statusCode: 200, headers: {} });
}

beforeEach(() => { jest.useFakeTimers(); __reset(); });
afterEach(()  => { jest.useRealTimers(); });

// ─── Manual pause / resume ────────────────────────────────────────────────────

describe('NativeSSE – manual pause/resume', () => {
  it('pause() transitions to PAUSED', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.pause();
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    sse.close();
  });

  it('pause() calls native disconnect', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    const sid = lastStreamId();
    sse.pause();
    expect(mockDisconnect).toHaveBeenCalledWith(sid);
    sse.close();
  });

  it('resume() from PAUSED starts a new connection', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.pause();
    sse.resume();
    expect(sse.state).toBe(SSE_STATE.CONNECTING);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    sse.close();
  });

  it('resume() is no-op when not PAUSED', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.resume(); // already OPEN — no-op
    expect(mockConnect).toHaveBeenCalledTimes(1);
    sse.close();
  });

  it('pause() cancels pending reconnect timer', () => {
    const sse = new NativeSSE(URL, { reconnectPolicy: { type: 'fixed', intervalMs: 5_000 } });
    emitOpen();
    __emit('sse_error', {
      streamId: lastStreamId(), message: 'drop', isFatal: false, errorCode: 'NETWORK_ERROR',
    });
    // Now in RECONNECTING with a 5s timer.
    expect(sse.state).toBe(SSE_STATE.RECONNECTING);
    sse.pause();
    // Timer cancelled — advancing past it should NOT trigger connect.
    jest.advanceTimersByTime(10_000);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    sse.close();
  });

  it('close() from PAUSED state is terminal', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.pause();
    sse.close();
    expect(sse.state).toBe(SSE_STATE.CLOSED);
    sse.resume(); // should be no-op
    expect(sse.state).toBe(SSE_STATE.CLOSED);
  });

  it('error while PAUSED does not trigger reconnect', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.pause();
    __emit('sse_error', {
      streamId: lastStreamId(), message: 'late-error', isFatal: false, errorCode: 'NETWORK_ERROR',
    });
    jest.runAllTimers();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    sse.close();
  });
});

// ─── AppState integration ─────────────────────────────────────────────────────

describe('NativeSSE – pauseOnBackground', () => {
  it('pauses when app goes to background', () => {
    const sse = new NativeSSE(URL, { pauseOnBackground: true });
    emitOpen();
    __setAppState('background');
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    sse.close();
  });

  it('pauses on "inactive" state too', () => {
    const sse = new NativeSSE(URL, { pauseOnBackground: true });
    emitOpen();
    __setAppState('inactive');
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    sse.close();
  });

  it('resumes when app returns to active', () => {
    const sse = new NativeSSE(URL, { pauseOnBackground: true });
    emitOpen();
    __setAppState('background');
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    __setAppState('active');
    expect(sse.state).toBe(SSE_STATE.CONNECTING);
    sse.close();
  });

  it('does NOT auto-pause when pauseOnBackground is false (default)', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    __setAppState('background');
    expect(sse.state).toBe(SSE_STATE.OPEN);
    sse.close();
  });

  it('does not resume a permanently closed stream', () => {
    const sse = new NativeSSE(URL, { pauseOnBackground: true });
    emitOpen();
    sse.close();
    __setAppState('active');
    expect(sse.state).toBe(SSE_STATE.CLOSED);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('does not resume a FAILED stream', () => {
    const sse = new NativeSSE(URL, {
      pauseOnBackground: true,
      maxReconnectAttempts: 0,
    });
    emitOpen();
    __setAppState('background');
    sse.close();
    // Simulate: stream was in PAUSED state, explicitly closed, then app goes active.
    __setAppState('active');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.CLOSED);
  });
});

// ─── autoConnect: false ───────────────────────────────────────────────────────

describe('NativeSSE – autoConnect: false', () => {
  it('does not call native connect in constructor', () => {
    const sse = new NativeSSE(URL, { autoConnect: false });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(sse.state).toBe(SSE_STATE.IDLE);
    sse.close();
  });

  it('calls native connect after explicit connect()', () => {
    const sse = new NativeSSE(URL, { autoConnect: false });
    sse.connect();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sse.state).toBe(SSE_STATE.CONNECTING);
    sse.close();
  });
});
