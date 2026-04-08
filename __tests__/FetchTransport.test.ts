/**
 * Unit tests for the Fetch API fallback transport (transport: 'fetch').
 *
 * All tests force `transport: 'fetch'` so the native module mock is bypassed
 * and global.fetch is used instead.
 */

import { __reset, NativeModules } from '../__mocks__/react-native';
import { NativeSSE } from '../src/EventSource';
import { SSE_STATE } from '../src/types';

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

const mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
(global as typeof globalThis & { fetch: typeof mockFetch }).fetch = mockFetch;

const mockNativeConnect    = NativeModules.NativeNativeSse.connect    as jest.Mock;
const mockNativeDisconnect = NativeModules.NativeNativeSse.disconnect as jest.Mock;

const URL = 'http://127.0.0.1:3000/events';

/** Build a streaming body that yields chunks one by one, then ends. */
function makeStreamBody(chunks: string[]) {
  let idx = 0;
  const encoder = new TextEncoder();
  return {
    getReader() {
      return {
        read: jest.fn().mockImplementation(async () => {
          if (idx >= chunks.length) return { done: true as const, value: undefined };
          return { done: false as const, value: encoder.encode(chunks[idx++]!) };
        }),
        releaseLock: jest.fn(),
      };
    },
  };
}

/** Build a mock Response with a streaming body. */
function makeResponse(status: number, chunks: string[]) {
  return Promise.resolve({
    status,
    headers: { get: jest.fn() },
    body: makeStreamBody(chunks),
  } as unknown as Response);
}

/** Build a mock Response whose body has no getReader (degraded env). */
function makeTextResponse(status: number, text: string) {
  return Promise.resolve({
    status,
    headers: { get: jest.fn() },
    body: null,
    text: jest.fn().mockResolvedValue(text),
  } as unknown as Response);
}

beforeEach(() => {
  jest.useFakeTimers();
  __reset();
  mockFetch.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

// ─── Transport selection ──────────────────────────────────────────────────────

describe('transport option – routing', () => {
  it('transport: "fetch" never calls NativeNativeSse.connect', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // pending forever
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    expect(mockNativeConnect).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    sse.close();
  });

  it('transport: "xhr" never calls fetch', () => {
    // XHR is used — fetch should not be called even when native is present.
    global.XMLHttpRequest = jest.fn().mockImplementation(() => ({
      open: jest.fn(), setRequestHeader: jest.fn(), send: jest.fn(),
      abort: jest.fn(), onreadystatechange: null, onprogress: null,
      onerror: null, ontimeout: null, onload: null,
    })) as unknown as typeof XMLHttpRequest;
    const sse = new NativeSSE(URL, { transport: 'xhr' });
    expect(mockNativeConnect).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    sse.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).XMLHttpRequest;
  });

  it('usingFallback is true for transport: "fetch"', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    expect(sse.usingFallback).toBe(true);
    sse.close();
  });
});

// ─── Connection open ──────────────────────────────────────────────────────────

describe('Fetch transport – open', () => {
  it('fires onopen on HTTP 200', async () => {
    mockFetch.mockReturnValue(makeResponse(200, []));
    const onopen = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.onopen = onopen;
    await Promise.resolve(); // let the microtask queue drain
    expect(onopen).toHaveBeenCalledWith(expect.objectContaining({ type: 'open' }));
    sse.close();
  });

  it('sends Accept: text/event-stream header', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    const [, init] = mockFetch.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)['Accept']).toBe('text/event-stream');
    sse.close();
  });

  it('merges custom headers', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const sse = new NativeSSE(URL, { transport: 'fetch', headers: { Authorization: 'Bearer tok' } });
    const [, init] = mockFetch.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    sse.close();
  });

  it('sends Last-Event-ID on reconnect', async () => {
    // First connection: receive a message with id, then stream ends.
    mockFetch.mockReturnValueOnce(
      makeResponse(200, ['id: 77\ndata: hello\n\n']),
    );
    // Second connection: pending
    mockFetch.mockReturnValue(new Promise(() => {}));

    const sse = new NativeSSE(URL, {
      transport: 'fetch',
      reconnectPolicy: { type: 'fixed', intervalMs: 100 },
    });

    // Drain microtasks so the first stream reads its chunks and closes.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    const [, secondInit] = mockFetch.mock.calls[1]!;
    expect((secondInit!.headers as Record<string, string>)['Last-Event-ID']).toBe('77');
    sse.close();
  });
});

// ─── Event delivery ───────────────────────────────────────────────────────────

describe('Fetch transport – event delivery', () => {
  it('delivers message events to onmessage', async () => {
    mockFetch.mockReturnValue(makeResponse(200, ['data: hello world\n\n']));
    const onmessage = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.onmessage = onmessage;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(onmessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'hello world' }));
    sse.close();
  });

  it('delivers custom event types via addEventListener', async () => {
    mockFetch.mockReturnValue(makeResponse(200, ['event: ping\ndata: ok\n\n']));
    const handler = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.addEventListener('ping', handler);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'ping', data: 'ok' }));
    sse.close();
  });

  it('handles events split across multiple chunks', async () => {
    mockFetch.mockReturnValue(makeResponse(200, ['data: hel', 'lo\n', '\n']));
    const onmessage = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.onmessage = onmessage;
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(onmessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'hello' }));
    sse.close();
  });

  it('updates metrics on received events', async () => {
    mockFetch.mockReturnValue(makeResponse(200, ['data: test\n\n']));
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(sse.getMetrics().eventsReceived).toBe(1);
    sse.close();
  });
});

// ─── HTTP error handling ──────────────────────────────────────────────────────

describe('Fetch transport – HTTP errors', () => {
  it('4xx is fatal — does not reconnect', async () => {
    mockFetch.mockReturnValue(makeResponse(403, []));
    const onerror = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.onerror = onerror;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.runAllTimers();
    expect(sse.state).toBe(SSE_STATE.FAILED);
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HTTP_ERROR', retryable: false, statusCode: 403 }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('5xx is retryable — reconnects after delay', async () => {
    mockFetch.mockReturnValue(makeResponse(503, []));
    const sse = new NativeSSE(URL, {
      transport: 'fetch',
      reconnectPolicy: { type: 'fixed', intervalMs: 50 },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(50);
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    sse.close();
  });
});

// ─── Network error handling ───────────────────────────────────────────────────

describe('Fetch transport – network errors', () => {
  it('fetch rejection fires onerror and schedules reconnect', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));
    mockFetch.mockReturnValue(new Promise(() => {})); // second attempt pending
    const onerror = jest.fn();
    const sse = new NativeSSE(URL, {
      transport: 'fetch',
      reconnectPolicy: { type: 'fixed', intervalMs: 50 },
    });
    sse.onerror = onerror;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NETWORK_ERROR' }),
    );
    jest.advanceTimersByTime(50);
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    sse.close();
  });

  it('stream read error fires onerror', async () => {
    const encoder = new TextEncoder();
    const failingBody = {
      getReader() {
        return {
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: encoder.encode('data: a\n\n') })
            .mockRejectedValueOnce(new Error('Socket reset')),
          releaseLock: jest.fn(),
        };
      },
    };
    mockFetch.mockResolvedValueOnce({ status: 200, headers: { get: jest.fn() }, body: failingBody } as unknown as Response);
    mockFetch.mockReturnValue(new Promise(() => {}));
    const onerror = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.onerror = onerror;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NETWORK_ERROR', message: 'Socket reset' }),
    );
    sse.close();
  });
});

// ─── Cancellation ─────────────────────────────────────────────────────────────

describe('Fetch transport – cancellation', () => {
  it('close() aborts the fetch (AbortController)', () => {
    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal as AbortSignal;
      return new Promise(() => {});
    });
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    expect(capturedSignal?.aborted).toBe(false);
    sse.close();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('does NOT call NativeNativeSse.disconnect on close()', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.close();
    expect(mockNativeDisconnect).not.toHaveBeenCalled();
  });

  it('stale reconnect aborts the current fetch', async () => {
    let capturedSignal: AbortSignal | undefined;
    // Use a stream whose reader never resolves so the connection stays OPEN.
    mockFetch.mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal as AbortSignal;
      return Promise.resolve({
        status: 200,
        headers: { get: jest.fn() },
        body: {
          getReader() {
            return {
              read: jest.fn().mockReturnValue(new Promise(() => {})), // never ends
              releaseLock: jest.fn(),
            };
          },
        },
      } as unknown as Response);
    });
    const sse = new NativeSSE(URL, { transport: 'fetch', staleTimeoutMs: 1_000 });
    for (let i = 0; i < 5; i++) await Promise.resolve(); // let open happen
    jest.advanceTimersByTime(1_000); // trigger stale timeout
    expect(capturedSignal?.aborted).toBe(true);
    sse.close();
  });
});

// ─── Degraded env (no ReadableStream) ────────────────────────────────────────

describe('Fetch transport – degraded (no ReadableStream)', () => {
  it('falls back to response.text() when body has no getReader', async () => {
    mockFetch.mockReturnValue(makeTextResponse(200, 'data: fallback\n\n'));
    const onmessage = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch' });
    sse.onmessage = onmessage;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(onmessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'fallback' }));
    sse.close();
  });
});

// ─── Timeout ─────────────────────────────────────────────────────────────────

describe('Fetch transport – timeout', () => {
  it('fires TIMEOUT_ERROR when timeout elapses before response', async () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    const onerror = jest.fn();
    const sse = new NativeSSE(URL, { transport: 'fetch', timeout: 3_000 });
    sse.onerror = onerror;
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TIMEOUT_ERROR' }),
    );
    sse.close();
  });
});
