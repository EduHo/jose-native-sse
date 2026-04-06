/**
 * Metrics unit tests — verifies StreamMetrics is accurately tracked.
 */

import { __emit, __reset, NativeModules } from '../__mocks__/react-native';
import { NativeSSE } from '../src/EventSource';

const mockConnect = NativeModules.NativeNativeSse.connect as jest.Mock;
const URL = 'http://example.com/events';

function lastStreamId() {
  return mockConnect.mock.calls[mockConnect.mock.calls.length - 1]?.[0] as string;
}
function emitOpen() {
  __emit('sse_open', { streamId: lastStreamId(), statusCode: 200, headers: {} });
}
function emitMsg(data: string, id = '', byteLength = data.length, eventType = 'message') {
  __emit('sse_message', { streamId: lastStreamId(), eventType, data, id, byteLength });
}
function emitError(isFatal = false, errorCode = 'NETWORK_ERROR') {
  __emit('sse_error', { streamId: lastStreamId(), message: 'err', isFatal, errorCode });
}

beforeEach(() => { jest.useFakeTimers(); __reset(); });
afterEach(()  => { jest.useRealTimers(); });

describe('StreamMetrics', () => {
  it('starts with zero metrics', () => {
    const sse = new NativeSSE(URL, { autoConnect: false });
    const m = sse.getMetrics();
    expect(m.bytesReceived).toBe(0);
    expect(m.eventsReceived).toBe(0);
    expect(m.reconnectCount).toBe(0);
    expect(m.lastEventId).toBe('');
    expect(m.lastEventTimestamp).toBeNull();
    expect(m.lastError).toBeNull();
    expect(m.connectedAt).toBeNull();
    sse.close();
  });

  it('tracks bytesReceived from native byteLength', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitMsg('hello', '', 5);
    emitMsg('world', '', 5);
    expect(sse.getMetrics().bytesReceived).toBe(10);
    sse.close();
  });

  it('accumulates eventsReceived', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitMsg('a'); emitMsg('b'); emitMsg('c');
    expect(sse.getMetrics().eventsReceived).toBe(3);
    sse.close();
  });

  it('tracks lastEventId from incoming events', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitMsg('a', 'evt-1');
    expect(sse.getMetrics().lastEventId).toBe('evt-1');
    emitMsg('b', 'evt-2');
    expect(sse.getMetrics().lastEventId).toBe('evt-2');
    sse.close();
  });

  it('sets lastEventTimestamp on each event', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    const before = Date.now();
    emitMsg('data');
    const after = Date.now();
    const ts = sse.getMetrics().lastEventTimestamp;
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
    sse.close();
  });

  it('sets connectedAt on open', () => {
    const sse = new NativeSSE(URL);
    const before = Date.now();
    emitOpen();
    const after = Date.now();
    const ca = sse.getMetrics().connectedAt;
    expect(ca).not.toBeNull();
    expect(ca!).toBeGreaterThanOrEqual(before);
    expect(ca!).toBeLessThanOrEqual(after);
    sse.close();
  });

  it('increments reconnectCount on each reconnect', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitError(); jest.runAllTimers(); // reconnect 1
    emitOpen();
    emitError(); jest.runAllTimers(); // reconnect 2
    expect(sse.getMetrics().reconnectCount).toBe(2);
    sse.close();
  });

  it('reconnectCount is not reset after successful open', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitError(); jest.runAllTimers();
    emitOpen();
    expect(sse.getMetrics().reconnectCount).toBe(1); // total lifetime count
    sse.close();
  });

  it('tracks lastError on error', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitError(false, 'NETWORK_ERROR');
    const m = sse.getMetrics();
    expect(m.lastError).not.toBeNull();
    expect(m.lastError!.code).toBe('NETWORK_ERROR');
    sse.close();
  });

  it('updates lastError on subsequent errors', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitError(false, 'NETWORK_ERROR');
    jest.runAllTimers();
    emitOpen();
    emitError(true, 'HTTP_ERROR');
    expect(sse.getMetrics().lastError!.code).toBe('HTTP_ERROR');
  });

  it('getMetrics returns a snapshot (not a live ref)', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    const snapshot = sse.getMetrics();
    emitMsg('data');
    // The snapshot captured before the message should not change.
    expect(snapshot.eventsReceived).toBe(0);
    expect(sse.getMetrics().eventsReceived).toBe(1);
    sse.close();
  });
});
