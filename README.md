<div align="center">

# jose-native-sse

**Server-Sent Events for React Native — native, fast, production-ready.**

[![npm version](https://img.shields.io/npm/v/jose-native-sse.svg)](https://www.npmjs.com/package/jose-native-sse)
[![license](https://img.shields.io/npm/l/jose-native-sse.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-126%20passing-brightgreen.svg)](#)
[![New Architecture](https://img.shields.io/badge/New%20Architecture-TurboModules-blueviolet.svg)](#new-architecture)

iOS · Android · TypeScript · TurboModules · New Architecture

</div>

---

## Why this library?

The browser `EventSource` API does not exist in React Native. Common workarounds use WebSockets (different protocol), polyfills backed by `fetch` (no streaming on Android), or community packages that are not maintained for the New Architecture.

`jose-native-sse` implements the full [WHATWG SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html) natively:

| | iOS | Android |
|---|---|---|
| **Transport** | `URLSessionDataTask` (Swift) | `OkHttp` streaming (Kotlin) |
| **Architecture** | TurboModules + Codegen | TurboModules + Codegen |
| **Parser** | Byte-level state machine | `BufferedReader` line-by-line |

**No WebSockets. No polyfills. No fetch hacks.**

---

## Features

- ✅ Full SSE spec — `data`, `event`, `id`, `retry` fields
- ✅ Auto-reconnect with **fixed** or **exponential backoff** policies
- ✅ `Last-Event-ID` header preserved across reconnects
- ✅ POST / custom headers / request body support
- ✅ 7-state machine — `idle → connecting → open → reconnecting → paused → closed → failed`
- ✅ Pause on app background, resume on foreground
- ✅ **Batch mode** for AI / high-frequency token streams
- ✅ Stream metrics — bytes, events, reconnects, timestamps
- ✅ Multi-stream manager
- ✅ Structured typed errors with error codes
- ✅ Buffer overflow protection
- ✅ Full TypeScript typings
- ✅ React Native New Architecture (TurboModules)

---

## Table of Contents

1. [Installation](#installation)
2. [Setup](#setup)
3. [Quick Start](#quick-start)
4. [API Reference](#api-reference)
   - [NativeSSE](#nativesse)
   - [Options](#options)
   - [State Machine](#state-machine)
   - [Events](#events)
   - [Errors](#errors)
   - [Metrics](#metrics)
   - [SseStreamManager](#ssestreammanager)
5. [Recipes](#recipes)
   - [Basic stream](#basic-stream)
   - [POST with auth headers](#post-with-auth-headers)
   - [Exponential backoff](#exponential-backoff)
   - [AI token streaming](#ai-token-streaming)
   - [Pause on background](#pause-on-background)
   - [Multi-stream manager](#multi-stream-manager)
   - [Custom event types](#custom-event-types)
6. [TypeScript](#typescript)
7. [New Architecture](#new-architecture)
8. [Migrating from V1](#migrating-from-v1)
9. [Contributing](#contributing)
10. [License](#license)

---

## Installation

```sh
npm install jose-native-sse
# or
yarn add jose-native-sse
```

### iOS

```sh
cd ios && pod install
```

### Android

No extra steps. The library uses OkHttp, which is already bundled with React Native.

---

## Setup

### iOS — `Info.plist`

If your SSE server uses `http://` (not `https://`), add an App Transport Security exception:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>
```

### Android — `AndroidManifest.xml`

Your app's manifest must declare the `INTERNET` permission:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

### Register the package (legacy architecture only)

If you are **not** using the New Architecture, register the package manually:

```kotlin
// MainApplication.kt
override fun getPackages(): List<ReactPackage> =
  PackageList(this).packages + listOf(NativeSsePackage())
```

With the New Architecture enabled, registration is automatic via Codegen.

---

## Quick Start

```ts
import { NativeSSE } from 'jose-native-sse';

const sse = new NativeSSE('https://api.example.com/events', {
  headers: { Authorization: 'Bearer your-token' },
});

sse.onopen    = ()  => console.log('Connected');
sse.onmessage = (e) => console.log('Message:', e.data);
sse.onerror   = (e) => console.error('Error:', e.code, e.message);

// Later…
sse.close();
```

---

## API Reference

### NativeSSE

```ts
const sse = new NativeSSE(url: string, options?: SseConnectOptions)
```

#### Properties

| Property | Type | Description |
|---|---|---|
| `url` | `string` | The URL passed to the constructor (read-only) |
| `state` | `SseState` | Fine-grained connection state (7 values) |
| `readyState` | `0 \| 1 \| 2` | Browser-compat state (`CONNECTING`, `OPEN`, `CLOSED`) |
| `onopen` | `(e: SseOpenEvent) => void \| null` | Fired when the connection is established |
| `onmessage` | `(e: SseMessageEvent) => void \| null` | Fired for `event: message` events |
| `onerror` | `(e: SseErrorEvent) => void \| null` | Fired on errors |
| `onbatch` | `(events: SseMessageEvent[]) => void \| null` | Fired with batched events (requires `batch.enabled`) |

#### Methods

| Method | Description |
|---|---|
| `connect()` | Start the connection. Required when `autoConnect: false`. No-op if already open. |
| `close()` | Permanently close the stream. Terminal — instance cannot be reused. |
| `pause()` | Disconnect without closing. Stream can be resumed with `resume()`. |
| `resume()` | Reconnect after a `pause()`. No-op if not paused. |
| `addEventListener(type, listener)` | Add an event listener for any event type. |
| `removeEventListener(type, listener)` | Remove a previously added listener. |
| `getMetrics()` | Returns a `StreamMetrics` snapshot. |

#### Static constants

```ts
NativeSSE.CONNECTING // 0
NativeSSE.OPEN       // 1
NativeSSE.CLOSED     // 2
```

---

### Options

```ts
interface SseConnectOptions {
  // ── HTTP ──────────────────────────────────────────────────────────────────
  method?:   'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; // default: 'GET'
  headers?:  Record<string, string>;
  body?:     string;   // only sent for non-GET requests
  timeout?:  number;   // request timeout in ms; 0 = none (default)

  // ── Reconnect ──────────────────────────────────────────────────────────────
  reconnectPolicy?:      ReconnectPolicy; // see below
  reconnectInterval?:    number;          // V1 compat — fixed interval in ms
  maxReconnectAttempts?: number;          // -1 = infinite (default)

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  autoConnect?:       boolean; // default: true
  pauseOnBackground?: boolean; // default: false

  // ── Batching ──────────────────────────────────────────────────────────────
  batch?: {
    enabled:         boolean;
    flushIntervalMs?: number; // default: 16 ms
    maxBatchSize?:    number; // default: 50 — flush immediately when full
  };

  // ── Parser ─────────────────────────────────────────────────────────────────
  maxLineLength?: number; // max bytes per SSE line; default: 1 048 576 (1 MB)

  debug?: boolean; // log reconnect info to console
}
```

#### Reconnect policies

```ts
// Fixed — same delay every time (default: 3 000 ms)
type FixedReconnectPolicy = {
  type: 'fixed';
  intervalMs: number;
};

// Exponential backoff — delay = min(initial × factor^attempt, max)
type ExponentialReconnectPolicy = {
  type:       'exponential';
  initialMs:  number;   // starting delay (e.g. 1 000)
  maxMs:      number;   // cap (e.g. 30 000)
  factor?:    number;   // multiplier per attempt; default: 2
  jitter?:    boolean;  // ±20 % randomisation; default: true
};
```

---

### State Machine

```
              ┌─────────────────────────────────────────────────────┐
              │                                                     │
   new()  ┌───▼──────┐  connect()  ┌────────────┐  sse_open  ┌────▼───┐
 ────────► │   IDLE   ├────────────► CONNECTING  ├────────────►  OPEN  │
          └──────────┘             └─────┬──────┘            └──┬──┬──┘
                                         │ error/close          │  │
                                         ▼                      │  │ pause()
                                  ┌─────────────┐               │  ▼
                                  │ RECONNECTING│ ◄─────────────┘ PAUSED
                                  └──────┬──────┘               │
                                  timer  │         resume()      │
                                  fires  │ ◄─────────────────────┘
                                         │
                              ┌──────────▼──────────────┐
                              │  max retries exceeded?  │
                              └──────────┬──────────────┘
                                   yes   │   no
                                  ┌──────▼──┐  ┌──────────────┐
                                  │ FAILED  │  │  CONNECTING  │
                                  └─────────┘  └──────────────┘

 close() from any state → CLOSED  (terminal)
```

```ts
import { SSE_STATE } from 'jose-native-sse';

SSE_STATE.IDLE         // 'idle'
SSE_STATE.CONNECTING   // 'connecting'
SSE_STATE.OPEN         // 'open'
SSE_STATE.RECONNECTING // 'reconnecting'
SSE_STATE.PAUSED       // 'paused'
SSE_STATE.CLOSED       // 'closed'
SSE_STATE.FAILED       // 'failed'
```

---

### Events

#### `onopen` / `'open'`

```ts
sse.onopen = (e: SseOpenEvent) => {
  // e.type   → 'open'
  // e.origin → the stream URL
};
```

#### `onmessage` / `'message'`

```ts
sse.onmessage = (e: SseMessageEvent) => {
  // e.type        → event type (default: 'message')
  // e.data        → event payload string
  // e.lastEventId → last received id: field
  // e.origin      → stream URL
};
```

`onmessage` is only called for events with `event: message` (or no `event:` field).
For custom event types use `addEventListener`.

#### `onerror` / `'error'`

```ts
sse.onerror = (e: SseErrorEvent) => {
  // e.code      → SseErrorCode (see below)
  // e.message   → human-readable description
  // e.statusCode → HTTP status for HTTP_ERROR
  // e.timestamp → Date.now() at the time of error
  // e.retryable → true if the library will auto-reconnect
};
```

#### `onbatch` — batch mode only

```ts
sse.onbatch = (events: SseMessageEvent[]) => {
  // Receives an array of events flushed in one batch tick.
};
```

#### Custom event types

```ts
sse.addEventListener('update', (e: SseMessageEvent) => {
  console.log('Update:', e.data);
});
```

This listens for `event: update` fields from the server.

---

### Errors

```ts
type SseErrorCode =
  | 'NETWORK_ERROR'        // TCP / DNS failure — retryable
  | 'HTTP_ERROR'           // Non-2xx status — fatal for 4xx, retryable for 5xx
  | 'TIMEOUT_ERROR'        // Request timed out — retryable
  | 'PARSE_ERROR'          // Malformed SSE / buffer overflow — retryable
  | 'INVALID_URL'          // URL could not be parsed — fatal
  | 'MAX_RETRIES_EXCEEDED' // Reconnect limit reached — fatal
  | 'ABORTED';             // Cancelled by pause() / close() — no reconnect
```

```ts
sse.onerror = (e) => {
  if (!e.retryable) {
    // The library will NOT reconnect — handle the failure in your UI.
    switch (e.code) {
      case 'HTTP_ERROR':
        if (e.statusCode === 401) return refreshTokenAndReconnect();
        if (e.statusCode === 403) return showAccessDenied();
        break;
      case 'MAX_RETRIES_EXCEEDED':
        return showOfflineBanner();
      case 'INVALID_URL':
        return showConfigError();
    }
  }
  // e.retryable === true → library is already scheduling the next attempt
};
```

---

### Metrics

```ts
const m = sse.getMetrics();

m.bytesReceived      // number — total UTF-8 bytes received (native count)
m.eventsReceived     // number — total events dispatched
m.reconnectCount     // number — total reconnect attempts (lifetime)
m.lastEventId        // string — last received id: field value
m.lastEventTimestamp // number | null — Date.now() of last event
m.lastError          // SseError | null — last error that occurred
m.connectedAt        // number | null — Date.now() of last successful open
```

`getMetrics()` always returns a **snapshot** — mutating the returned object does not affect the stream.

---

### SseStreamManager

Manages multiple named SSE streams with aggregate lifecycle operations.

```ts
import { SseStreamManager } from 'jose-native-sse';

const manager = new SseStreamManager();
```

#### Methods

| Method | Returns | Description |
|---|---|---|
| `create(id, url, options?)` | `NativeSSE` | Create (or replace) a named stream |
| `get(id)` | `NativeSSE \| undefined` | Look up a stream by ID |
| `has(id)` | `boolean` | Check if a stream exists |
| `remove(id)` | `boolean` | Close and remove a stream |
| `pauseAll()` | `void` | Pause every registered stream |
| `resumeAll()` | `void` | Resume every paused stream |
| `closeAll()` | `void` | Close all streams and clear the registry |
| `getAllMetrics()` | `Map<string, StreamMetrics>` | Metrics per stream |
| `getAggregateMetrics()` | `AggregateMetrics` | Totals across all streams |
| `size` | `number` | Number of registered streams |
| `ids` | `string[]` | All registered stream IDs |

---

## Recipes

### Basic stream

```ts
import { NativeSSE } from 'jose-native-sse';

const sse = new NativeSSE('https://api.example.com/stream');

sse.onopen    = ()  => setConnected(true);
sse.onmessage = (e) => addMessage(e.data);
sse.onerror   = (e) => console.error(e.code, e.message);

// Cleanup on unmount
return () => sse.close();
```

---

### POST with auth headers

```ts
const sse = new NativeSSE('https://api.example.com/stream', {
  method:  'POST',
  headers: {
    Authorization: 'Bearer eyJ...',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ channel: 'updates', filter: 'all' }),
});
```

---

### Exponential backoff

```ts
const sse = new NativeSSE('https://api.example.com/stream', {
  reconnectPolicy: {
    type:      'exponential',
    initialMs: 1_000,   // start with 1 s
    maxMs:     30_000,  // cap at 30 s
    factor:    2,       // double each time
    jitter:    true,    // ±20 % randomisation (default: true)
  },
  maxReconnectAttempts: 20,
});
```

Retry schedule (no jitter): 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...

---

### AI token streaming

For high-frequency streams (e.g. LLM token output), batch mode reduces React
re-renders from one-per-token to one-per-animation-frame:

```ts
const sse = new NativeSSE('https://api.example.com/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer sk-...' },
  body: JSON.stringify({ model: 'gpt-4o', stream: true, messages }),
  batch: {
    enabled:         true,
    flushIntervalMs: 50,  // flush every 50 ms (~20 Hz)
    maxBatchSize:    100, // or immediately when 100 tokens accumulate
  },
});

sse.onbatch = (events) => {
  // One setState for potentially dozens of tokens.
  setOutput(prev => prev + events.map(e => e.data).join(''));
};
```

---

### Pause on background

```ts
const sse = new NativeSSE('https://api.example.com/stream', {
  pauseOnBackground: true,
  // The stream pauses automatically when the app goes to the background
  // and resumes when it comes back to the foreground.
  // Last-Event-ID is preserved, so no events are missed.
});
```

You can also control this manually:

```ts
// Pause (e.g. when user navigates to a different screen)
sse.pause();

// Resume when they come back
sse.resume();
```

---

### Multi-stream manager

```ts
import { SseStreamManager } from 'jose-native-sse';

const manager = new SseStreamManager();

// Create streams
const chat = manager.create('chat', 'https://api.example.com/chat/events', {
  headers: { Authorization: `Bearer ${token}` },
  reconnectPolicy: { type: 'exponential', initialMs: 1000, maxMs: 30000 },
});

const presence = manager.create('presence', 'https://api.example.com/presence');

// Attach handlers
chat.onmessage     = (e) => handleChatMessage(JSON.parse(e.data));
presence.onmessage = (e) => updatePresence(JSON.parse(e.data));

// App goes to background — pause everything
manager.pauseAll();

// App returns — resume everything
manager.resumeAll();

// User logs out — close everything
manager.closeAll();

// Observability
const { totalEventsReceived, totalBytesReceived, totalReconnects } =
  manager.getAggregateMetrics();
```

---

### Custom event types

The SSE protocol supports named event types via the `event:` field.
Use `addEventListener` to handle them:

```ts
// Server sends:
// event: user-joined
// data: {"userId":"abc","name":"Alice"}

sse.addEventListener('user-joined', (e) => {
  const user = JSON.parse(e.data);
  addUser(user);
});

sse.addEventListener('user-left', (e) => {
  const { userId } = JSON.parse(e.data);
  removeUser(userId);
});
```

---

### React hook

```tsx
import { useEffect, useState, useRef } from 'react';
import { NativeSSE } from 'jose-native-sse';
import type { SseConnectOptions, SseState } from 'jose-native-sse';

export function useSSE(url: string, options?: SseConnectOptions) {
  const [state, setState]     = useState<SseState>('idle');
  const [lastData, setData]   = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const sseRef                = useRef<NativeSSE | null>(null);

  useEffect(() => {
    const sse = new NativeSSE(url, options);
    sseRef.current = sse;

    sse.onopen    = ()  => { setState(sse.state); setError(null); };
    sse.onmessage = (e) => { setState(sse.state); setData(e.data); };
    sse.onerror   = (e) => { setState(sse.state); setError(e.message); };

    return () => sse.close();
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  return { state, lastData, error, sse: sseRef.current };
}

// Usage
function MyComponent() {
  const { state, lastData } = useSSE('https://api.example.com/events', {
    reconnectPolicy: { type: 'exponential', initialMs: 1000, maxMs: 30000 },
  });

  return (
    <View>
      <Text>State: {state}</Text>
      <Text>Last event: {lastData}</Text>
    </View>
  );
}
```

---

## TypeScript

All types are exported from the package root:

```ts
import type {
  // Options
  SseConnectOptions,
  ReconnectPolicy,
  FixedReconnectPolicy,
  ExponentialReconnectPolicy,
  BatchConfig,

  // State
  SseState,
  SseReadyState,

  // Events
  SseOpenEvent,
  SseMessageEvent,
  SseErrorEvent,

  // Errors
  SseError,
  SseErrorCode,

  // Metrics
  StreamMetrics,

  // Parser (advanced)
  ParsedEvent,
  SseParserOptions,
} from 'jose-native-sse';
```

---

## New Architecture

The library is built for the React Native New Architecture (TurboModules + Codegen).

**With New Architecture enabled** (React Native 0.71+):

```ruby
# Podfile
use_react_native!(
  :new_arch_enabled => true,
)
```

```gradle
// gradle.properties
newArchEnabled=true
```

The Codegen spec is in `src/NativeNativeSse.ts`. The codegen tool reads it at
build time and generates the C++ / ObjC++ / Kotlin bridge boilerplate.

**Legacy Architecture is also supported** — the same JS module detects which
bridge is available at runtime and uses the appropriate path.

---

## Migrating from V1

V2 is fully backward-compatible. See [MIGRATION.md](./MIGRATION.md) for the
complete guide. Quick summary:

| V1 | V2 equivalent | Notes |
|---|---|---|
| `reconnectInterval: 3000` | `reconnectPolicy: { type: 'fixed', intervalMs: 3000 }` | V1 option still works |
| `sse.readyState` (0/1/2) | `sse.state` (string) | Both work simultaneously |
| `onerror({ message, statusCode })` | `onerror({ code, message, statusCode, timestamp, retryable })` | Superset — existing handlers work |
| No pause support | `sse.pause()` / `sse.resume()` | New |
| No metrics | `sse.getMetrics()` | New |
| No batch mode | `batch: { enabled: true }` + `onbatch` | New |
| Multiple `NativeSSE` instances | `SseStreamManager` | New |

---

## Contributing

Contributions are welcome!

```sh
# Clone and install
git clone https://github.com/your-username/jose-native-sse.git
cd jose-native-sse
npm install

# Run tests
npm test

# Run tests in watch mode
npm test -- --watch

# Type check
npm run typecheck
```

**Before opening a PR:**
- All 126 tests must pass (`npm test`)
- New features need tests
- Follow the existing code style

---

## License

MIT © [Your Name](https://github.com/your-username)

See [LICENSE](./LICENSE) for the full text.

---

<div align="center">

Made with ♥ for the React Native community

</div>
