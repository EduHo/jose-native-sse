import { __emit, __reset, NativeModules } from '../__mocks__/react-native';
import { NativeSSE } from '../src/EventSource';
import { CLOSED, CONNECTING, OPEN, SSE_STATE } from '../src/types';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const mockConnect    = NativeModules.NativeNativeSse.connect    as jest.Mock;
const mockDisconnect = NativeModules.NativeNativeSse.disconnect as jest.Mock;

const URL = 'http://example.com/events';

function lastStreamId(): string {
  const calls = mockConnect.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}

function emitOpen(statusCode = 200) {
  __emit('sse_open', { streamId: lastStreamId(), statusCode, headers: {} });
}

function emitChunk(data = 'hello', eventType = 'message', id = '') {
  let text = '';
  if (eventType !== 'message') text += `event: ${eventType}\n`;
  text += `data: ${data}\n`;
  if (id) text += `id: ${id}\n`;
  text += '\n';
  __emit('sse_chunk', { streamId: lastStreamId(), chunk: text, byteLength: text.length });
}

// Alias kept for readability in existing tests
const emitMessage = emitChunk;

function emitError(
  message = 'err',
  isFatal = false,
  errorCode = 'NETWORK_ERROR',
  statusCode?: number,
) {
  const payload: Record<string, unknown> = {
    streamId: lastStreamId(), message, isFatal, errorCode,
  };
  if (statusCode !== undefined) payload.statusCode = statusCode;
  __emit('sse_error', payload);
}

beforeEach(() => { jest.useFakeTimers(); __reset(); });
afterEach(()  => { jest.useRealTimers(); });

// ─── State machine ────────────────────────────────────────────────────────────

describe('NativeSSE – state machine', () => {
  it('starts in CONNECTING state (autoConnect default)', () => {
    const sse = new NativeSSE(URL);
    expect(sse.state).toBe(SSE_STATE.CONNECTING);
    expect(sse.readyState).toBe(CONNECTING);
    sse.close();
  });

  it('starts in IDLE state when autoConnect: false', () => {
    const sse = new NativeSSE(URL, { autoConnect: false });
    expect(sse.state).toBe(SSE_STATE.IDLE);
    sse.close();
  });

  it('transitions IDLE → CONNECTING on connect()', () => {
    const sse = new NativeSSE(URL, { autoConnect: false });
    sse.connect();
    expect(sse.state).toBe(SSE_STATE.CONNECTING);
    sse.close();
  });

  it('transitions to OPEN on sse_open', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    expect(sse.state).toBe(SSE_STATE.OPEN);
    expect(sse.readyState).toBe(OPEN);
    sse.close();
  });

  it('transitions to CLOSED on close()', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.close();
    expect(sse.state).toBe(SSE_STATE.CLOSED);
    expect(sse.readyState).toBe(CLOSED);
  });

  it('transitions to RECONNECTING on non-fatal error', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitError('drop', false);
    expect(sse.state).toBe(SSE_STATE.RECONNECTING);
    sse.close();
  });

  it('transitions to FAILED on fatal error', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitError('HTTP 403', true, 'HTTP_ERROR', 403);
    expect(sse.state).toBe(SSE_STATE.FAILED);
    expect(sse.readyState).toBe(CLOSED);
  });

  it('transitions to PAUSED on pause()', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.pause();
    expect(sse.state).toBe(SSE_STATE.PAUSED);
    sse.close();
  });

  it('transitions PAUSED → CONNECTING on resume()', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.pause();
    sse.resume();
    expect(sse.state).toBe(SSE_STATE.CONNECTING);
    sse.close();
  });

  it('close() is idempotent', () => {
    const sse = new NativeSSE(URL);
    sse.close(); sse.close();
    expect(sse.state).toBe(SSE_STATE.CLOSED);
  });

  it('connect() is no-op when already OPEN', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    sse.connect();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    sse.close();
  });

  it('connect() is no-op after CLOSED', () => {
    const sse = new NativeSSE(URL);
    sse.close();
    sse.connect();
    expect(sse.state).toBe(SSE_STATE.CLOSED);
  });

  it('connect() is no-op after FAILED', () => {
    const sse = new NativeSSE(URL, { maxReconnectAttempts: 0 });
    emitError('drop', false);
    jest.runAllTimers();
    expect(sse.state).toBe(SSE_STATE.FAILED);
    sse.connect();
    expect(sse.state).toBe(SSE_STATE.FAILED);
  });
});

// ─── Native connect arguments ────────────────────────────────────────────────

describe('NativeSSE – connect arguments', () => {
  it('sends Accept: text/event-stream', () => {
    const sse = new NativeSSE(URL);
    expect(mockConnect.mock.calls[0]![2].headers['Accept']).toBe('text/event-stream');
    sse.close();
  });

  it('merges custom headers', () => {
    const sse = new NativeSSE(URL, { headers: { Authorization: 'Bearer t' } });
    expect(mockConnect.mock.calls[0]![2].headers['Authorization']).toBe('Bearer t');
    sse.close();
  });

  it('passes maxLineLength option', () => {
    const sse = new NativeSSE(URL, { maxLineLength: 512 });
    expect(mockConnect.mock.calls[0]![2].maxLineLength).toBe(512);
    sse.close();
  });

  it('defaults method to GET', () => {
    const sse = new NativeSSE(URL);
    expect(mockConnect.mock.calls[0]![2].method).toBe('GET');
    sse.close();
  });

  it('calls native disconnect on close()', () => {
    const sse = new NativeSSE(URL);
    sse.close();
    expect(mockDisconnect).toHaveBeenCalledWith(lastStreamId());
  });
});

// ─── Event handlers ───────────────────────────────────────────────────────────

describe('NativeSSE – event handlers', () => {
  it('onopen fires on open', () => {
    const sse = new NativeSSE(URL);
    const onopen = jest.fn();
    sse.onopen = onopen;
    emitOpen();
    expect(onopen).toHaveBeenCalledWith(expect.objectContaining({ type: 'open' }));
    sse.close();
  });

  it('onmessage fires for message-type events', () => {
    const sse = new NativeSSE(URL);
    const onmessage = jest.fn();
    sse.onmessage = onmessage;
    emitOpen(); emitMessage('hello');
    expect(onmessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'hello' }));
    sse.close();
  });

  it('onmessage does NOT fire for custom event types', () => {
    const sse = new NativeSSE(URL);
    const onmessage = jest.fn();
    sse.onmessage = onmessage;
    emitOpen(); emitMessage('payload', 'update');
    expect(onmessage).not.toHaveBeenCalled();
    sse.close();
  });

  it('addEventListener receives custom types', () => {
    const sse = new NativeSSE(URL);
    const handler = jest.fn();
    sse.addEventListener('update', handler);
    emitOpen(); emitMessage('data', 'update');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'update' }));
    sse.close();
  });

  it('removeEventListener stops handler', () => {
    const sse = new NativeSSE(URL);
    const handler = jest.fn();
    sse.addEventListener('message', handler);
    sse.removeEventListener('message', handler);
    emitOpen(); emitMessage();
    expect(handler).not.toHaveBeenCalled();
    sse.close();
  });

  it('does not add duplicate listeners', () => {
    const sse = new NativeSSE(URL);
    const handler = jest.fn();
    sse.addEventListener('message', handler);
    sse.addEventListener('message', handler);
    emitOpen(); emitMessage();
    expect(handler).toHaveBeenCalledTimes(1);
    sse.close();
  });
});

// ─── Structured errors ────────────────────────────────────────────────────────

describe('NativeSSE – structured errors', () => {
  it('onerror receives SseError with code field', () => {
    const sse = new NativeSSE(URL);
    const onerror = jest.fn();
    sse.onerror = onerror;
    emitError('network dropped', false, 'NETWORK_ERROR');
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NETWORK_ERROR', retryable: true }),
    );
    sse.close();
  });

  it('fatal HTTP error has retryable: false', () => {
    const sse = new NativeSSE(URL);
    const onerror = jest.fn();
    sse.onerror = onerror;
    emitError('HTTP 403', true, 'HTTP_ERROR', 403);
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HTTP_ERROR', retryable: false, statusCode: 403 }),
    );
  });

  it('error includes timestamp', () => {
    const sse = new NativeSSE(URL);
    const onerror = jest.fn();
    sse.onerror = onerror;
    const before = Date.now();
    emitError('err');
    const after = Date.now();
    const { timestamp } = onerror.mock.calls[0]![0];
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
    sse.close();
  });
});

// ─── Last-Event-ID ────────────────────────────────────────────────────────────

describe('NativeSSE – Last-Event-ID', () => {
  it('includes Last-Event-ID on reconnect', () => {
    const sse = new NativeSSE(URL);
    emitOpen();
    emitMessage('data', 'message', 'evt-99');
    emitError('drop');
    jest.runAllTimers();
    const headers = mockConnect.mock.calls[1]![2].headers;
    expect(headers['Last-Event-ID']).toBe('evt-99');
    sse.close();
  });

  it('no Last-Event-ID on first connect', () => {
    const sse = new NativeSSE(URL);
    const headers = mockConnect.mock.calls[0]![2].headers;
    expect(headers['Last-Event-ID']).toBeUndefined();
    sse.close();
  });
});

// ─── Batching ────────────────────────────────────────────────────────────────

describe('NativeSSE – batching', () => {
  it('onbatch receives an array of events', () => {
    const sse = new NativeSSE(URL, { batch: { enabled: true, flushIntervalMs: 50 } });
    const onbatch = jest.fn();
    sse.onbatch = onbatch;
    emitOpen();
    emitMessage('one');
    emitMessage('two');
    emitMessage('three');
    expect(onbatch).not.toHaveBeenCalled(); // not yet flushed
    jest.advanceTimersByTime(50);
    expect(onbatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ data: 'one' }),
        expect.objectContaining({ data: 'two' }),
        expect.objectContaining({ data: 'three' }),
      ]),
    );
    sse.close();
  });

  it('flushes immediately when maxBatchSize reached', () => {
    const sse = new NativeSSE(URL, {
      batch: { enabled: true, maxBatchSize: 2, flushIntervalMs: 10_000 },
    });
    const onbatch = jest.fn();
    sse.onbatch = onbatch;
    emitOpen();
    emitMessage('a'); emitMessage('b'); // triggers immediate flush
    expect(onbatch).toHaveBeenCalledTimes(1);
    expect(onbatch.mock.calls[0]![0]).toHaveLength(2);
    sse.close();
  });

  it('still delivers to onmessage inside batch', () => {
    const sse = new NativeSSE(URL, { batch: { enabled: true, flushIntervalMs: 10 } });
    const onmessage = jest.fn();
    sse.onmessage = onmessage;
    emitOpen();
    emitMessage('hello');
    jest.advanceTimersByTime(10);
    expect(onmessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'hello' }));
    sse.close();
  });
});

// ─── url accessor ─────────────────────────────────────────────────────────────

describe('NativeSSE – accessors', () => {
  it('url matches constructor argument', () => {
    const sse = new NativeSSE('http://example.com/stream');
    expect(sse.url).toBe('http://example.com/stream');
    sse.close();
  });
});
