/**
 * SseStreamManager unit tests.
 */

import { __emit, __reset, NativeModules } from '../__mocks__/react-native';
import { SseStreamManager } from '../src/StreamManager';
import { SSE_STATE } from '../src/types';

const mockConnect    = NativeModules.NativeNativeSse.connect    as jest.Mock;
const mockDisconnect = NativeModules.NativeNativeSse.disconnect as jest.Mock;

// Helper: nth connect call's streamId
function streamIdAt(callIdx: number): string {
  return mockConnect.mock.calls[callIdx]?.[0] as string;
}
function emitOpenFor(streamId: string) {
  __emit('sse_open', { streamId, statusCode: 200, headers: {} });
}
function emitErrorFor(streamId: string, isFatal = false) {
  __emit('sse_error', { streamId, message: 'err', isFatal, errorCode: 'NETWORK_ERROR' });
}

beforeEach(() => { jest.useFakeTimers(); __reset(); });
afterEach(()  => { jest.useRealTimers(); });

// ─── Registry ─────────────────────────────────────────────────────────────────

describe('SseStreamManager – registry', () => {
  it('create() returns a NativeSSE instance', () => {
    const mgr = new SseStreamManager();
    const s = mgr.create('chat', 'http://example.com/chat');
    expect(s).toBeDefined();
    expect(typeof s.close).toBe('function');
    mgr.closeAll();
  });

  it('get() returns the stream by id', () => {
    const mgr = new SseStreamManager();
    const s = mgr.create('s1', 'http://example.com/s1');
    expect(mgr.get('s1')).toBe(s);
    mgr.closeAll();
  });

  it('get() returns undefined for unknown id', () => {
    const mgr = new SseStreamManager();
    expect(mgr.get('nonexistent')).toBeUndefined();
  });

  it('has() returns true for existing streams', () => {
    const mgr = new SseStreamManager();
    mgr.create('x', 'http://example.com/x');
    expect(mgr.has('x')).toBe(true);
    expect(mgr.has('y')).toBe(false);
    mgr.closeAll();
  });

  it('size tracks the number of streams', () => {
    const mgr = new SseStreamManager();
    expect(mgr.size).toBe(0);
    mgr.create('a', 'http://example.com/a');
    mgr.create('b', 'http://example.com/b');
    expect(mgr.size).toBe(2);
    mgr.closeAll();
  });

  it('ids returns all registered stream ids', () => {
    const mgr = new SseStreamManager();
    mgr.create('x', 'http://x.com');
    mgr.create('y', 'http://y.com');
    expect(mgr.ids.sort()).toEqual(['x', 'y']);
    mgr.closeAll();
  });

  it('create() replaces an existing stream with the same id', () => {
    const mgr = new SseStreamManager();
    const first = mgr.create('s1', 'http://example.com/s1');
    const second = mgr.create('s1', 'http://example.com/s1');
    expect(mgr.get('s1')).toBe(second);
    expect(first).not.toBe(second);
    expect(first.state).toBe(SSE_STATE.CLOSED); // first was closed
    mgr.closeAll();
  });

  it('remove() closes and removes a stream', () => {
    const mgr = new SseStreamManager();
    const s = mgr.create('chat', 'http://example.com');
    const removed = mgr.remove('chat');
    expect(removed).toBe(true);
    expect(s.state).toBe(SSE_STATE.CLOSED);
    expect(mgr.has('chat')).toBe(false);
  });

  it('remove() returns false for unknown id', () => {
    const mgr = new SseStreamManager();
    expect(mgr.remove('ghost')).toBe(false);
  });
});

// ─── Stream isolation ─────────────────────────────────────────────────────────

describe('SseStreamManager – stream isolation', () => {
  it('events for stream A do not reach stream B handlers', () => {
    const mgr = new SseStreamManager();
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    mgr.create('a', 'http://example.com/a');
    mgr.create('b', 'http://example.com/b');

    mgr.get('a')!.onmessage = handlerA;
    mgr.get('b')!.onmessage = handlerB;

    const sidA = streamIdAt(0);
    const sidB = streamIdAt(1);

    emitOpenFor(sidA);
    emitOpenFor(sidB);

    __emit('sse_message', { streamId: sidA, eventType: 'message', data: 'for-a', id: '', byteLength: 5 });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();

    __emit('sse_message', { streamId: sidB, eventType: 'message', data: 'for-b', id: '', byteLength: 5 });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);

    mgr.closeAll();
  });

  it('independent reconnect counters', () => {
    const mgr = new SseStreamManager();
    mgr.create('a', 'http://example.com/a');
    mgr.create('b', 'http://example.com/b');

    const sidA = streamIdAt(0);
    const sidB = streamIdAt(1);

    emitOpenFor(sidA);
    emitOpenFor(sidB);

    emitErrorFor(sidA);
    jest.runAllTimers();

    expect(mgr.get('a')!.getMetrics().reconnectCount).toBe(1);
    expect(mgr.get('b')!.getMetrics().reconnectCount).toBe(0);

    mgr.closeAll();
  });
});

// ─── Aggregate operations ─────────────────────────────────────────────────────

describe('SseStreamManager – aggregate operations', () => {
  it('pauseAll() pauses every stream', () => {
    const mgr = new SseStreamManager();
    mgr.create('a', 'http://a.com');
    mgr.create('b', 'http://b.com');
    const sidA = streamIdAt(0);
    const sidB = streamIdAt(1);
    emitOpenFor(sidA); emitOpenFor(sidB);

    mgr.pauseAll();
    expect(mgr.get('a')!.state).toBe(SSE_STATE.PAUSED);
    expect(mgr.get('b')!.state).toBe(SSE_STATE.PAUSED);
    mgr.closeAll();
  });

  it('resumeAll() resumes every paused stream', () => {
    const mgr = new SseStreamManager();
    mgr.create('a', 'http://a.com');
    mgr.create('b', 'http://b.com');
    const sidA = streamIdAt(0);
    const sidB = streamIdAt(1);
    emitOpenFor(sidA); emitOpenFor(sidB);

    mgr.pauseAll();
    mgr.resumeAll();
    expect(mgr.get('a')!.state).toBe(SSE_STATE.CONNECTING);
    expect(mgr.get('b')!.state).toBe(SSE_STATE.CONNECTING);
    mgr.closeAll();
  });

  it('closeAll() closes all streams and clears the registry', () => {
    const mgr = new SseStreamManager();
    mgr.create('a', 'http://a.com');
    mgr.create('b', 'http://b.com');
    mgr.closeAll();
    expect(mgr.size).toBe(0);
    // Both streams should be closed via disconnect.
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
  });
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

describe('SseStreamManager – metrics', () => {
  it('getAllMetrics returns one entry per stream', () => {
    const mgr = new SseStreamManager();
    mgr.create('a', 'http://a.com');
    mgr.create('b', 'http://b.com');
    const all = mgr.getAllMetrics();
    expect(all.size).toBe(2);
    expect(all.has('a')).toBe(true);
    expect(all.has('b')).toBe(true);
    mgr.closeAll();
  });

  it('getAggregateMetrics sums across all streams', () => {
    const mgr = new SseStreamManager();
    mgr.create('a', 'http://a.com');
    mgr.create('b', 'http://b.com');
    const sidA = streamIdAt(0);
    const sidB = streamIdAt(1);
    emitOpenFor(sidA); emitOpenFor(sidB);

    __emit('sse_message', { streamId: sidA, eventType: 'message', data: 'hi', id: '', byteLength: 2 });
    __emit('sse_message', { streamId: sidB, eventType: 'message', data: 'hey', id: '', byteLength: 3 });

    const agg = mgr.getAggregateMetrics();
    expect(agg.totalEventsReceived).toBe(2);
    expect(agg.totalBytesReceived).toBe(5);
    expect(agg.streamCount).toBe(2);
    mgr.closeAll();
  });
});
