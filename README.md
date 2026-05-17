<div align="center">

# jose-native-sse

**Server-Sent Events for React Native — native, fast, production-ready.**

[![npm version](https://img.shields.io/npm/v/jose-native-sse.svg)](https://www.npmjs.com/package/jose-native-sse)
[![CI](https://github.com/EduHo/jose-native-sse/actions/workflows/ci.yml/badge.svg)](https://github.com/EduHo/jose-native-sse/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/jose-native-sse.svg)](./LICENSE)
[![New Architecture](https://img.shields.io/badge/New%20Architecture-TurboModules-blueviolet.svg)](#new-architecture)

iOS · Android · TypeScript · TurboModules · New Architecture

</div>

---

## Overview

The browser `EventSource` API does not exist in React Native. Common workarounds use WebSockets (different protocol), polyfills backed by `fetch` (no streaming on Android), or packages that are unmaintained for the New Architecture.

`jose-native-sse` implements the full [WHATWG SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html) with a **thin-transport architecture**: the native layer (Swift on iOS, Kotlin on Android) only handles the HTTP connection and forwards raw UTF-8 chunks to JavaScript. All SSE protocol parsing lives in a single `SseParser.ts` shared by every transport — native, XHR, and Fetch — ensuring identical behaviour across platforms.

| | iOS | Android |
|---|---|---|
| **Transport** | `URLSessionDataTask` (Swift) | `OkHttp` streaming (Kotlin) |
| **Architecture** | TurboModules + Codegen | TurboModules + Codegen |

---

## Features

- Full SSE spec — `data`, `event`, `id`, `retry` fields
- Auto-reconnect with **fixed** or **exponential backoff** policies
- `Last-Event-ID` preserved across reconnects (optionally persisted to storage)
- POST / custom headers / request body support
- 8-state machine — `idle → connecting → open → stale → reconnecting → paused → closed → failed`
- `stateChange` event — fires on every state transition with `{ from, to }`
- Stale / zombie connection detection with automatic reconnect
- Network-awareness — reconnect immediately when connectivity is restored
- Pause on app background, resume on foreground
- Batch mode for AI / high-frequency token streams
- Stream metrics — bytes, events, reconnects, stale counts, timestamps
- Multi-stream manager
- Structured typed errors with error codes
- Buffer overflow protection (configurable `maxLineLength`)
- Transport selection — native, XHR, Fetch (automatic fallback for Expo Go)
- Full TypeScript typings
- React Native New Architecture (TurboModules)

---

## Table of Contents

1. [Installation](#installation)
2. [Setup](#setup)
   - [Expo](#expo)
   - [Bare React Native](#bare-react-native)
3. [Quick Start](#quick-start)
4. [API Reference](#api-reference)
   - [NativeSSE](#nativesse)
   - [useNativeSSE hook](#usenativesse-hook)
   - [Options](#options)
   - [State Machine](#state-machine)
   - [Events](#events)
   - [Errors](#errors)
   - [Metrics](#metrics)
   - [SseStreamManager](#ssestreammanager)
5. [Recipes](#recipes)
6. [TypeScript](#typescript)
7. [New Architecture](#new-architecture)
8. [Contributing](#contributing)
9. [License](#license)

---

## Installation

```sh
npm install jose-native-sse
# or
yarn add jose-native-sse
```

---

## Setup

### Expo

The library ships a built-in **Expo config plugin** that handles native configuration automatically during `expo prebuild`.

#### 1. Add the plugin to `app.json` / `app.config.js`

```json
{
  "expo": {
    "plugins": ["jose-native-sse"]
  }
}
```

The plugin always adds the `android.permission.INTERNET` permission to `AndroidManifest.xml`.

If your SSE server uses plain `http://` (not `https://`), pass `allowCleartext: true`:

```json
{
  "expo": {
    "plugins": [["jose-native-sse", { "allowCleartext": true }]]
  }
}
```

With `allowCleartext: true` the plugin additionally sets:
- iOS: `NSAllowsArbitraryLoads: true` in `Info.plist`
- Android: `android:usesCleartextTraffic="true"` on the `<application>` element

#### 2. Run prebuild and build

```sh
npx expo prebuild
npx expo run:ios
npx expo run:android
# or
eas build --profile development
```

#### Expo Go

The native TurboModule is not available in Expo Go. The library detects this automatically and falls back to an **XHR transport** — same JS API, same reconnect logic, same event callbacks. No code changes needed.

```ts
const sse = new NativeSSE(url, { debug: true });
// Console: "[NativeSSE] Native module not available — using XHR fallback transport."

if (sse.usingFallback) {
  // Running in Expo Go or with native module absent
}
```

To force a specific transport for testing:

```ts
new NativeSSE(url, { transport: 'xhr' });    // always XHR
new NativeSSE(url, { transport: 'fetch' });  // always Fetch API
new NativeSSE(url, { transport: 'native' }); // always native (throws in Expo Go)
```

### Bare React Native

```sh
cd ios && pod install
```

No extra Android steps — OkHttp is already bundled with React Native.

If your SSE server uses `http://`, add the App Transport Security exception to `Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>
```

Ensure your `AndroidManifest.xml` declares the `INTERNET` permission:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

With the New Architecture enabled, the package registers automatically via Codegen. If you are on the legacy architecture, register it manually:

```kotlin
// MainApplication.kt
override fun getPackages(): List<ReactPackage> =
  PackageList(this).packages + listOf(NativeSsePackage())
```

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
| `state` | `SseState` | Fine-grained connection state (8 values) |
| `readyState` | `0 \| 1 \| 2` | Browser-compat state (`CONNECTING`, `OPEN`, `CLOSED`) |
| `usingFallback` | `boolean` | `true` when running on XHR/Fetch instead of the native module |
| `onopen` | `(e: SseOpenEvent) => void \| null` | Fired when the connection is established |
| `onmessage` | `(e: SseMessageEvent) => void \| null` | Fired for `event: message` events |
| `onerror` | `(e: SseErrorEvent) => void \| null` | Fired on errors |
| `onstatechange` | `(e: SseStateChangeEvent) => void \| null` | Fired on every state transition |
| `onbatch` | `(events: SseMessageEvent[]) => void \| null` | Fired with batched events (requires `batch.enabled`) |

#### Methods

| Method | Description |
|---|---|
| `connect()` | Start the connection. Required when `autoConnect: false`. No-op if already connecting or open. |
| `reconnect()` | Force an **immediate** reconnect from any non-terminal state, bypassing the reconnect policy (no backoff delay). Resets the attempt counter. Use after refreshing an auth token or for a manual "Retry" button. No-op if `closed` or `failed`. |
| `close()` | Permanently close the stream. Terminal — instance cannot be reused. |
| `pause()` | Disconnect without closing. Resumable with `resume()`. |
| `resume()` | Reconnect after a `pause()`. No-op if not paused. |
| `addEventListener(type, listener)` | Add a listener for any event type. |
| `removeEventListener(type, listener)` | Remove a previously added listener. |
| `getMetrics()` | Returns a `StreamMetrics` snapshot. |

#### Static constants

```ts
NativeSSE.CONNECTING // 0
NativeSSE.OPEN       // 1
NativeSSE.CLOSED     // 2
```

---

### useNativeSSE hook

```ts
import { useNativeSSE } from 'jose-native-sse';

const result = useNativeSSE(url: string, options?: UseNativeSSEOptions)
```

`UseNativeSSEOptions` extends `SseConnectOptions` with one extra field:

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Set to `false` to skip connecting (useful for auth-gated streams). |

`UseNativeSSEResult`:

| Field | Type | Description |
|---|---|---|
| `state` | `SseState` | Current fine-grained connection state. |
| `readyState` | `0 \| 1 \| 2` | Browser-compatible ready state. |
| `lastMessage` | `SseMessageEvent \| null` | Most recently received message. |
| `lastBatch` | `SseMessageEvent[] \| null` | Most recently flushed batch. Only populated when `batch.enabled: true`. |
| `lastError` | `SseErrorEvent \| null` | Most recent error. |
| `metrics` | `StreamMetrics` | Snapshot updated on each message and state change. |
| `pause()` | `() => void` | Pause the stream. |
| `resume()` | `() => void` | Resume a paused stream. |
| `reconnect()` | `() => void` | Force an immediate reconnect without backoff. No-op if `closed` or `failed`. |
| `close()` | `() => void` | Permanently close the stream. |

The connection is opened on mount, closed on unmount, and reconnected when `url` or `enabled` changes.

---

### Options

```ts
interface SseConnectOptions {
  // ── HTTP ──────────────────────────────────────────────────────────────────
  method?:   'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; // default: 'GET'
  headers?:  Record<string, string>;
  body?:     string;   // only sent for non-GET requests
  timeout?:  number;   // request timeout in ms; 0 = none (default)

  // ── Reconnect ─────────────────────────────────────────────────────────────
  reconnectPolicy?: ReconnectPolicy;    // see below
  maxReconnectAttempts?: number;        // -1 = infinite (default)

  // ── Stale detection ───────────────────────────────────────────────────────
  staleTimeoutMs?: number;
  // Reconnect if no data is received within this many ms.
  // Resets on every chunk. 0 = disabled (default).

  // ── Network awareness ─────────────────────────────────────────────────────
  networkObserver?:  NetworkObserver; // manual observer (takes precedence)
  networkAwareness?: boolean;
  // When true, integrates with @react-native-community/netinfo.
  // Suspends reconnect timers while offline; reconnects immediately on restore.
  // Silently disabled if netinfo is not installed. Default: false.

  // ── Transport ─────────────────────────────────────────────────────────────
  transport?: 'auto' | 'native' | 'xhr' | 'fetch';
  // 'auto'   (default): native TurboModule when available, XHR otherwise.
  // 'native': always native (throws at runtime if the module is absent).
  // 'xhr':    always XHR.
  // 'fetch':  Fetch API + ReadableStream — no responseText memory accumulation.
  maxLineLength?: number; // max bytes per SSE line; default: 1 048 576 (1 MB)

  // ── Last-Event-ID persistence ─────────────────────────────────────────────
  persistLastEventId?: boolean;
  // Persist the last event ID so reconnects after an app restart resume
  // from where they left off. Default: false (in-memory only).
  storageKey?:     string;         // default: 'sse:last-event-id'
  storageAdapter?: StorageAdapter; // default: InMemoryStorageAdapter

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  autoConnect?:        boolean;              // default: true
  pauseOnBackground?:  boolean;             // default: false
  backgroundBehavior?: 'pause' | 'disconnect';
  // 'pause' (default): auto-resume when app returns to foreground.
  // 'disconnect': pause only — resume() must be called manually.

  // ── Batching ──────────────────────────────────────────────────────────────
  batch?: {
    enabled:          boolean;
    flushIntervalMs?: number; // default: 16 ms
    maxBatchSize?:    number; // default: 50
  };

  // ── Observability callbacks ───────────────────────────────────────────────
  onReconnectAttempt?: (attempt: number, delayMs: number) => void;
  // Called each time a reconnect is scheduled.
  // attempt: 1-based index. delayMs: milliseconds until the next connect().
  onReconnectSuccess?: () => void;
  // Called when a reconnect attempt results in a successful open.
  onStale?: () => void;
  // Called when a stale/zombie connection is detected (before reconnecting).
  onFatalError?: (error: SseError) => void;
  // Called when the stream enters the terminal FAILED state
  // (max retries exceeded or a non-retryable HTTP error).

  debug?: boolean; // log reconnect / stale / network events to console
}
```

#### Reconnect policies

```ts
// Fixed — same delay every time
type FixedReconnectPolicy = {
  type: 'fixed';
  intervalMs: number; // default: 3 000 ms
};

// Exponential backoff — delay = min(initial × factor^attempt, max)
type ExponentialReconnectPolicy = {
  type:      'exponential';
  initialMs: number;  // starting delay
  maxMs:     number;  // cap
  factor?:   number;  // multiplier per attempt; default: 2
  jitter?:   boolean; // ±20 % randomisation; default: true
};
```

#### Network observer interface

```ts
interface NetworkObserver {
  subscribe(onStateChange: (isConnected: boolean) => void): () => void;
}
```

#### Storage adapter interface

```ts
interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

---

### State Machine

```
         new()    ┌──────────┐  connect()  ┌─────────────┐
        ────────► │   IDLE   ├────────────►│ CONNECTING  │
                  └──────────┘             └──────┬──────┘
                                                  │ open
                                                  ▼
                                           ┌─────────────┐
                                           │    OPEN     │
                                           └──┬──────┬───┘
                                   no data    │      │ pause()
                                   timeout    ▼      ▼
                                         ┌───────┐ ┌────────┐
                                         │ STALE │ │ PAUSED │
                                         └───┬───┘ └────┬───┘
                                             │          │ resume()
                                     error / │          │
                                     close   ▼          │
                                      ┌─────────────┐   │
                                      │ RECONNECTING│◄──┘
                                      └──────┬──────┘
                                   timer     │
                                   fires     ▼
                                      ┌─────────────┐
                                      │ CONNECTING  │ (loop)
                                      └─────────────┘

  close() from any state → CLOSED  (terminal)
  max retries exceeded   → FAILED  (terminal)
```

```ts
import { SSE_STATE } from 'jose-native-sse';

SSE_STATE.IDLE         // 'idle'         — created, connect() not yet called
SSE_STATE.CONNECTING   // 'connecting'   — HTTP request in flight
SSE_STATE.OPEN         // 'open'         — streaming, receiving events
SSE_STATE.STALE        // 'stale'        — no data within staleTimeoutMs; reconnecting
SSE_STATE.RECONNECTING // 'reconnecting' — waiting for reconnect timer
SSE_STATE.PAUSED       // 'paused'       — manually or by background; resumes on resume()
SSE_STATE.CLOSED       // 'closed'       — permanently closed by close()
SSE_STATE.FAILED       // 'failed'       — max retries exhausted; no further reconnects
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

`onmessage` fires only for events with `event: message` or no `event:` field. Use `addEventListener` for custom event types.

#### `onerror` / `'error'`

```ts
sse.onerror = (e: SseErrorEvent) => {
  // e.code       → SseErrorCode
  // e.message    → human-readable description
  // e.statusCode → HTTP status (HTTP_ERROR only)
  // e.timestamp  → Date.now() at the time of error
  // e.retryable  → true if the library will reconnect automatically
};
```

#### `onstatechange` / `'stateChange'`

Fires on every state transition with both the previous and the new state. Use this to keep UI state always in sync with the connection lifecycle — including transitions to `'stale'` and `'paused'` that are not signalled by any other event.

```ts
sse.onstatechange = (e: SseStateChangeEvent) => {
  // e.from → previous SseState
  // e.to   → new SseState
  setSseState(e.to);
};

// addEventListener variant — supports multiple listeners
sse.addEventListener('stateChange', ({ from, to }) => {
  console.log(`${from} → ${to}`);
});
```

Example transitions:

| Trigger | from | to |
|---|---|---|
| `connect()` called | `idle` | `connecting` |
| Server responds | `connecting` | `open` |
| No data for `staleTimeoutMs` | `open` | `stale` |
| Reconnect scheduled | `stale` | `reconnecting` |
| Timer fires | `reconnecting` | `connecting` |
| Reconnect succeeds | `connecting` | `open` |
| `pause()` called | `open` | `paused` |
| `resume()` called | `paused` | `connecting` |
| `close()` called | any | `closed` |
| Max retries exceeded | `reconnecting` | `failed` |

#### `onbatch` — batch mode only

```ts
sse.onbatch = (events: SseMessageEvent[]) => {
  // Called with an array of events flushed in one batch tick.
};
```

#### Custom event types

```ts
// Server sends:  event: update\ndata: {...}\n\n
sse.addEventListener('update', (e: SseMessageEvent) => {
  console.log('Update:', e.data);
});
```

---

### Errors

```ts
type SseErrorCode =
  | 'NETWORK_ERROR'        // TCP / DNS failure — retryable
  | 'HTTP_ERROR'           // Non-2xx status — fatal for 4xx, retryable for 5xx
  | 'TIMEOUT_ERROR'        // Request timed out or stale connection — retryable
  | 'PARSE_ERROR'          // Malformed SSE / buffer overflow — retryable
  | 'INVALID_URL'          // URL could not be parsed — fatal
  | 'MAX_RETRIES_EXCEEDED' // Reconnect limit reached — fatal
  | 'ABORTED';             // Cancelled by pause() / close() — no reconnect
```

```ts
sse.onerror = (e) => {
  if (!e.retryable) {
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
  // e.retryable === true → library is scheduling the next attempt automatically
};
```

---

### Metrics

```ts
const m = sse.getMetrics();

m.bytesReceived      // number        — raw SSE bytes received (including field names)
m.eventsReceived     // number        — total events dispatched to handlers
m.reconnectCount     // number        — total reconnect attempts
m.staleCount         // number        — number of stale/zombie connections detected
m.lastEventId        // string        — last received id: field value
m.lastEventTimestamp // number | null — Date.now() of last received event
m.lastError          // SseError | null
m.connectedAt        // number | null — Date.now() of last successful open
```

`getMetrics()` returns a snapshot — mutating the returned object has no effect.

---

### SseStreamManager

Manages multiple named SSE streams.

```ts
import { SseStreamManager } from 'jose-native-sse';

const manager = new SseStreamManager();
```

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

return () => sse.close();
```

---

### POST with auth headers

```ts
const sse = new NativeSSE('https://api.example.com/stream', {
  method:  'POST',
  headers: {
    Authorization:  'Bearer eyJ...',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ channel: 'updates' }),
});
```

---

### Exponential backoff

```ts
const sse = new NativeSSE('https://api.example.com/stream', {
  reconnectPolicy: {
    type:      'exponential',
    initialMs: 1_000,
    maxMs:     30_000,
    factor:    2,
    jitter:    true,
  },
  maxReconnectAttempts: 20,
});
```

Schedule (no jitter): 1 s → 2 s → 4 s → 8 s → 16 s → 30 s → 30 s → …

---

### React hook

The library ships a `useNativeSSE` hook that manages the full connection lifecycle automatically.

```tsx
import { useNativeSSE } from 'jose-native-sse';

function Feed() {
  const { state, lastMessage, lastError, pause, resume } = useNativeSSE(
    'https://api.example.com/events',
    {
      headers:          { Authorization: `Bearer ${token}` },
      reconnectPolicy:  { type: 'exponential', initialMs: 1_000, maxMs: 30_000 },
      staleTimeoutMs:   30_000,
      networkAwareness: true,
    },
  );

  return (
    <View>
      <Text>State: {state}</Text>
      <Text>Last event: {lastMessage?.data}</Text>
      {lastError && <Text>Error: {lastError.message}</Text>}
      <Button title="Pause"  onPress={pause} />
      <Button title="Resume" onPress={resume} />
    </View>
  );
}
```

The hook re-opens the connection when `url` changes and cleans up on unmount. Pass `enabled: false` to defer connecting:

```tsx
const { state } = useNativeSSE(url, { enabled: isLoggedIn });
```

---

### Token refresh / forced reconnect

Use `reconnect()` when credentials rotate and you need to pick up new headers without destroying the instance:

```tsx
import { useRef } from 'react';
import { useNativeSSE } from 'jose-native-sse';

function Feed({ getToken }: { getToken: () => Promise<string> }) {
  const tokenRef = useRef('');
  const { state, lastMessage, reconnect } = useNativeSSE(
    'https://api.example.com/events',
    {
      // Headers are re-read from the ref on every (re)connect.
      get headers() {
        return { Authorization: `Bearer ${tokenRef.current}` };
      },
      onerror: async (e) => {
        if (e.statusCode === 401) {
          tokenRef.current = await getToken(); // refresh token
          reconnect();                         // re-connects immediately with new token
        }
      },
    },
  );

  return <Text>{lastMessage?.data}</Text>;
}
```

Or with the low-level API:

```ts
let token = await getToken();

const sse = new NativeSSE('https://api.example.com/events', {
  get headers() {
    return { Authorization: `Bearer ${token}` };
  },
});

sse.onerror = async (e) => {
  if (e.statusCode === 401) {
    token = await refreshToken();
    sse.reconnect(); // immediately re-connects with the new token
  }
};
```

> **Note**: `reconnect()` is a no-op when `state` is `'closed'` or `'failed'`. It works from any other state, including `'open'`, `'reconnecting'`, and `'paused'`.

---

### OpenAI streaming

```tsx
import { useNativeSSE } from 'jose-native-sse';

function ChatStream({ messages }: { messages: OpenAIMessage[] }) {
  const [output, setOutput] = useState('');

  const { state } = useNativeSSE('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      Authorization:  'Bearer sk-...',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gpt-4o', stream: true, messages }),
    // Batch tokens to reduce React re-renders to one per animation frame
    batch: { enabled: true, flushIntervalMs: 16, maxBatchSize: 50 },
    onbatch: (events) => {
      const chunk = events
        .map(e => {
          try { return JSON.parse(e.data)?.choices?.[0]?.delta?.content ?? ''; }
          catch { return ''; }
        })
        .join('');
      setOutput(prev => prev + chunk);
    },
  } as any);

  return <Text>{output}</Text>;
}
```

Or with the low-level API and `onbatch`:

```ts
const sse = new NativeSSE('https://api.openai.com/v1/chat/completions', {
  method:  'POST',
  headers: { Authorization: 'Bearer sk-...', 'Content-Type': 'application/json' },
  body:    JSON.stringify({ model: 'gpt-4o', stream: true, messages }),
  batch:   { enabled: true, flushIntervalMs: 16 },
});

sse.onbatch = (events) => {
  for (const e of events) {
    if (e.data === '[DONE]') { sse.close(); return; }
    try {
      const delta = JSON.parse(e.data).choices?.[0]?.delta?.content;
      if (delta) appendToken(delta);
    } catch { /* ignore non-JSON */ }
  }
};
```

---

### Anthropic streaming

```ts
const sse = new NativeSSE('https://api.anthropic.com/v1/messages', {
  method:  'POST',
  headers: {
    'x-api-key':         'sk-ant-...',
    'anthropic-version': '2023-06-01',
    'Content-Type':      'application/json',
  },
  body: JSON.stringify({
    model:      'claude-opus-4-7',
    max_tokens: 1024,
    stream:     true,
    messages:   [{ role: 'user', content: 'Hello' }],
  }),
});

sse.addEventListener('content_block_delta', (e) => {
  try {
    const delta = JSON.parse(e.data)?.delta?.text;
    if (delta) appendToken(delta);
  } catch { /* ignore */ }
});

sse.addEventListener('message_stop', () => sse.close());
```

---

### AI token streaming (batch mode)

Reduces React re-renders from one-per-token to one-per-animation-frame:

```ts
const sse = new NativeSSE('https://api.example.com/chat/completions', {
  method:  'POST',
  headers: { Authorization: 'Bearer sk-...' },
  body:    JSON.stringify({ model: 'gpt-4o', stream: true, messages }),
  batch: {
    enabled:         true,
    flushIntervalMs: 50,   // flush every 50 ms
    maxBatchSize:    100,  // or when 100 tokens accumulate
  },
});

sse.onbatch = (events) => {
  setOutput(prev => prev + events.map(e => e.data).join(''));
};
```

---

### Pause on background

```ts
const sse = new NativeSSE('https://api.example.com/stream', {
  pauseOnBackground:  true,
  backgroundBehavior: 'pause', // auto-resume on foreground
});

// Manual control
sse.pause();  // state → 'paused'
sse.resume(); // state → 'connecting'
```

---

### Stale connection detection

Some proxies and mobile NATs silently drop TCP connections, leaving the client in a zombie state. `staleTimeoutMs` reconnects automatically if no data arrives within the configured window:

```ts
const sse = new NativeSSE('https://api.example.com/stream', {
  staleTimeoutMs: 30_000,
});

sse.onerror = (e) => {
  if (e.code === 'TIMEOUT_ERROR' && e.retryable) {
    // Stale connection detected — library is already reconnecting.
  }
};
```

The timer resets on every received chunk, including heartbeat comments (`: ping\n\n`).

---

### Network awareness

```ts
// Automatic — requires @react-native-community/netinfo
const sse = new NativeSSE(url, { networkAwareness: true });

// Manual observer — integrate any network library
import NetInfo from '@react-native-community/netinfo';

const sse = new NativeSSE(url, {
  networkObserver: {
    subscribe: (cb) =>
      NetInfo.addEventListener((s) => cb(!!s.isConnected)),
  },
});
```

While offline, pending reconnect timers are suspended. When connectivity is restored, reconnect happens immediately, bypassing the backoff delay.

---

### Last-Event-ID persistence

```ts
import { AsyncStorageAdapter } from 'jose-native-sse';

const sse = new NativeSSE('https://api.example.com/stream', {
  persistLastEventId: true,
  storageAdapter: new AsyncStorageAdapter(), // requires @react-native-async-storage/async-storage
  storageKey: 'my-stream:last-event-id',
});
```

---

### Multi-stream manager

```ts
import { SseStreamManager } from 'jose-native-sse';

const manager = new SseStreamManager();

const chat = manager.create('chat', 'https://api.example.com/chat/events', {
  headers: { Authorization: `Bearer ${token}` },
});
const presence = manager.create('presence', 'https://api.example.com/presence');

chat.onmessage     = (e) => handleChat(JSON.parse(e.data));
presence.onmessage = (e) => updatePresence(JSON.parse(e.data));

manager.pauseAll();   // app goes to background
manager.resumeAll();  // app returns
manager.closeAll();   // user logs out

const { totalEventsReceived, totalBytesReceived, totalReconnects } =
  manager.getAggregateMetrics();
```

---

### Custom event types

```ts
// Server sends:
// event: user-joined
// data: {"userId":"abc","name":"Alice"}

sse.addEventListener('user-joined', (e) => {
  addUser(JSON.parse(e.data));
});

sse.addEventListener('user-left', (e) => {
  removeUser(JSON.parse(e.data).userId);
});
```

---

## TypeScript

All public types are exported from the package root:

```ts
import type {
  // Options
  SseConnectOptions,
  ReconnectPolicy,
  FixedReconnectPolicy,
  ExponentialReconnectPolicy,
  BatchConfig,
  NetworkObserver,
  StorageAdapter,

  // States
  SseState,
  SseReadyState,

  // Events
  SseOpenEvent,
  SseMessageEvent,
  SseErrorEvent,
  SseStateChangeEvent,

  // Errors
  SseError,
  SseErrorCode,

  // Metrics
  StreamMetrics,

  // Parser
  ParsedEvent,
  SseParserOptions,

  // Hook
  UseNativeSSEOptions,
  UseNativeSSEResult,
} from 'jose-native-sse';
```

Internal building blocks are also exported for advanced use cases (custom transports, testing):

```ts
import {
  StateMachine,
  AppLifecycleManager,
  NetworkMonitor,
  SseParser,
} from 'jose-native-sse';
```

---

## New Architecture

The library targets the React Native New Architecture (TurboModules + Codegen).

```ruby
# ios/Podfile
use_react_native!(:new_arch_enabled => true)
```

```properties
# android/gradle.properties
newArchEnabled=true
```

The Codegen spec is in `src/NativeNativeSse.ts`. The toolchain generates the C++ / ObjC++ / Kotlin bridge at build time. The legacy bridge is also supported — the JS module detects which is available at runtime.

---

## Architecture — thin transport

```
  iOS / Android native
  ┌──────────────────────────────────────────┐
  │  URLSession / OkHttp                     │
  │  ↓ raw UTF-8 bytes                       │
  │  onChunk(text, byteLength)               │
  │  ↓ sse_chunk event to JS bridge          │
  └──────────────────────────────────────────┘
                      ↓
  JavaScript (all transports share this path)
  ┌──────────────────────────────────────────┐
  │  SseParser.ts                            │
  │  • line splitting (\r, \n, \r\n)         │
  │  • field parsing (data/event/id/retry)   │
  │  • event dispatch                        │
  │  • retry: field → reconnect interval     │
  │  • maxLineLength overflow protection     │
  └──────────────────────────────────────────┘
```

---

## Contributing

```sh
git clone https://github.com/EduardoGoncalves/jose-native-sse.git
cd jose-native-sse
npm install

npm test          # run tests
npm test -- --watch
npm run typecheck
```

Before opening a PR: all tests must pass, new features need tests, follow the existing code style.

---

## License

MIT © Eduardo Gonçalves

See [LICENSE](./LICENSE) for the full text.

---

<div align="center">

Made with ♥ for the React Native community

</div>
