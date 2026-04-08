# Migration Guide — V1 → V2

## V1 → V2 at a glance

V2 is a **superset** of V1. All existing V1 code compiles and runs unchanged.
Every new capability is opt-in through new options or new methods.

---

## What changed

### 1. Fine-grained connection state

V1 exposed only three ready states (`CONNECTING = 0`, `OPEN = 1`, `CLOSED = 2`).

V2 adds a string `state` property with 8 values:

```
idle → connecting → open → stale → reconnecting → connecting (loop)
                        ↕
                     paused ↔ connecting (resume)

Any state → closed   (explicit close — terminal)
Any state → failed   (max retries exceeded — terminal)
```

```ts
// V1 still works
sse.readyState; // 0 | 1 | 2

// V2 — fine-grained
sse.state; // 'idle' | 'connecting' | 'open' | 'stale' | 'reconnecting' | 'paused' | 'closed' | 'failed'

import { SSE_STATE } from 'jose-native-sse';
if (sse.state === SSE_STATE.RECONNECTING) showReconnectingSpinner();
if (sse.state === SSE_STATE.STALE)        showStaleBadge();
```

### 2. Advanced reconnect policies

V1 only supported a fixed interval via `reconnectInterval`.

V2 adds configurable policies:

```ts
// V1 — still works
const sse = new NativeSSE(url, { reconnectInterval: 3000 });

// V2 — explicit fixed policy (equivalent)
const sse = new NativeSSE(url, {
  reconnectPolicy: { type: 'fixed', intervalMs: 3000 },
});

// V2 — exponential backoff with jitter (recommended for production)
const sse = new NativeSSE(url, {
  reconnectPolicy: {
    type:      'exponential',
    initialMs: 1000,
    maxMs:     30000,
    factor:    2,
    jitter:    true, // default: true — prevents thundering herd
  },
});
```

### 3. Structured errors

V1 error objects: `{ type: 'error', message: string, statusCode?: number }`

V2 error objects add `code`, `timestamp`, and `retryable`:

```ts
// V1 handler still works (extra fields are backward-compatible additions)
sse.onerror = (e) => console.log(e.message, e.statusCode);

// V2 — use the structured code for better error handling
sse.onerror = (e) => {
  switch (e.code) {
    case 'HTTP_ERROR':
      if (e.statusCode === 401) return logout();
      break;
    case 'TIMEOUT_ERROR':
      // Includes stale connection reconnects.
      return showTimeoutMessage();
    case 'MAX_RETRIES_EXCEEDED':
      return showOfflineMode();
    case 'NETWORK_ERROR':
      // e.retryable === true → the library will reconnect automatically.
      break;
  }
};
```

Available codes: `NETWORK_ERROR` | `HTTP_ERROR` | `TIMEOUT_ERROR` | `PARSE_ERROR` | `INVALID_URL` | `MAX_RETRIES_EXCEEDED` | `ABORTED`

### 4. Explicit connect / pause / resume

V1: connection was always started in the constructor.

V2 adds manual lifecycle control:

```ts
// V1 — connects immediately
const sse = new NativeSSE(url, options);

// V2 — deferred connection
const sse = new NativeSSE(url, { autoConnect: false });
// … set up handlers first …
sse.connect();

// Pause without losing state (e.g. user navigates away)
sse.pause();   // state → 'paused'; native stream disconnected

// Resume (reconnects with Last-Event-ID preserved)
sse.resume();  // state → 'connecting'
```

### 5. Automatic lifecycle awareness

```ts
const sse = new NativeSSE(url, {
  pauseOnBackground: true,
  // 'pause' (default): auto-resume when app returns to foreground.
  // 'disconnect': requires manual sse.resume() on foreground.
  backgroundBehavior: 'pause',
});
```

### 6. Stale connection detection

Some proxies and mobile NAT environments silently drop TCP connections,
leaving the client in a zombie state. `staleTimeoutMs` reconnects automatically
if no data is received within the configured window:

```ts
const sse = new NativeSSE(url, {
  staleTimeoutMs: 30_000, // reconnect if no data for 30 s
});

// state transitions: OPEN → STALE → RECONNECTING → CONNECTING
// onerror fires with code: 'TIMEOUT_ERROR', retryable: true
```

### 7. Network awareness

```ts
// Option A — automatic (requires @react-native-community/netinfo)
const sse = new NativeSSE(url, {
  networkAwareness: true,
});

// Option B — manual observer (integrate any network library)
const sse = new NativeSSE(url, {
  networkObserver: {
    subscribe: (cb) =>
      NetInfo.addEventListener((state) => cb(!!state.isConnected)),
  },
});
```

When the device goes offline, pending reconnect timers are suspended.
When connectivity is restored, reconnect happens immediately (bypassing backoff).

### 8. Last-Event-ID persistence

```ts
import { AsyncStorageAdapter } from 'jose-native-sse';

const sse = new NativeSSE(url, {
  persistLastEventId: true,
  storageAdapter: new AsyncStorageAdapter(), // requires @react-native-async-storage/async-storage
  storageKey: 'my-stream:last-event-id',
});
```

### 9. Transport selection

```ts
const sse = new NativeSSE(url, {
  transport: 'auto',   // default: native when available, XHR otherwise
  // 'native' | 'xhr' | 'fetch'
});
```

### 10. Stream metrics

```ts
const m = sse.getMetrics();
// {
//   bytesReceived:      number;       — raw SSE chunk bytes
//   eventsReceived:     number;
//   reconnectCount:     number;
//   staleCount:         number;       — zombie reconnects detected
//   lastEventId:        string;
//   lastEventTimestamp: number | null;
//   lastError:          SseError | null;
//   connectedAt:        number | null;
// }
```

### 11. Batching (AI / high-frequency streams)

```ts
const sse = new NativeSSE(url, {
  batch: {
    enabled:         true,
    flushIntervalMs: 50,
    maxBatchSize:    100,
  },
});

sse.onbatch = (events) => {
  setOutput(prev => prev + events.map(e => e.data).join(''));
};
```

### 12. Multi-stream manager

```ts
import { SseStreamManager } from 'jose-native-sse';

const manager = new SseStreamManager();
const chat     = manager.create('chat',     'https://api.example.com/chat');
const presence = manager.create('presence', 'https://api.example.com/presence');

manager.pauseAll();
manager.resumeAll();
manager.closeAll();

const { totalEventsReceived, totalBytesReceived } = manager.getAggregateMetrics();
```

### 13. Buffer overflow protection

V1 had no line length limit — a broken server could cause OOM.

V2 defaults to a 1 MB per-line limit. Oversized lines are dropped and reported
via `onerror` with `code: 'PARSE_ERROR'`:

```ts
const sse = new NativeSSE(url, {
  maxLineLength: 65_536, // 64 KB
});
```

### 14. iOS now uses Swift

The iOS native layer was rewritten from Objective-C to Swift (`SseConnection.swift`).
The public JS API is unchanged. No action required.

### 15. Thin transport — single JS parser

The native layers (Swift / Kotlin) no longer parse SSE. They forward raw UTF-8
text chunks to JavaScript. A single `SseParser.ts` handles all parsing for every
transport (native, XHR, Fetch), ensuring identical behaviour across platforms.

---

## Breaking changes

**None.** All V1 constructor arguments, event handler properties, `readyState`
constants, `addEventListener`/`removeEventListener`, and `close()` work
identically in V2.

The only technically observable change is that `onerror` callbacks now receive
an object with additional fields (`code`, `timestamp`, `retryable`). Since these
are additions to a plain object, existing handlers that only read `message` or
`statusCode` are unaffected.

---

## Quick migration checklist

- [ ] Replace `reconnectInterval: N` with `reconnectPolicy: { type: 'exponential', ... }` (optional — improves reliability)
- [ ] Switch to `sse.state` instead of `sse.readyState` for UI state mapping
- [ ] Add `code` handling to `onerror` for better error differentiation
- [ ] Enable `pauseOnBackground: true` for streams that should survive app backgrounding
- [ ] Add `staleTimeoutMs: 30_000` if your server / network may silently drop connections
- [ ] Enable `networkAwareness: true` to suspend reconnects while offline
- [ ] Wrap multiple streams in `SseStreamManager`
- [ ] For AI/token streams, enable `batch` mode and use `onbatch`
