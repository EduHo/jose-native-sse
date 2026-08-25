# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

A security and correctness release. Two of the fixes are data-integrity bugs that
silently corrupted or discarded stream content, so upgrading is strongly
recommended.

Every fix below is covered by a regression test. The ones marked **(reproduced)**
were demonstrated failing against real sockets before the fix — see
[`stress/`](./stress/README.md).

### Fixed — data integrity

- **UTF-8 sequences split across read boundaries are no longer corrupted**
  (reproduced). Both native layers decoded each read in isolation, so any
  multi-byte character straddling a boundary was destroyed. On Android it became
  replacement characters; on iOS `String(data:encoding:)` returned `nil` and the
  **entire chunk was discarded in silence**, taking valid text and line
  terminators with it. Decoding is now incremental on both platforms.

  A 460 KB stream of emoji lost 24 characters before the fix and none after.
  Under network-level fragmentation the old iOS path lost 41 of 50 events.

- **An over-long line no longer leaks its own fields** (reproduced). When a line
  exceeded `maxLineLength` the buffer was dropped but the parser did not
  resynchronise, so the tail of that line was re-read as a fresh set of SSE
  fields — letting a large enough payload choose the `event:` type delivered to
  the app. The parser now discards input up to the next terminator.

- **CRLF split across chunks no longer produces a phantom empty line.** A `\r`
  arriving at the end of one chunk and its `\n` in the next was treated as a
  bare-CR terminator. See *Changed* for the behavioural consequence.

### Fixed — resource exhaustion

- **A stream that never sends a blank line no longer grows memory without bound**
  (reproduced). `maxLineLength` bounded a single line but nothing bounded the
  accumulated event. 38 MB of input grew the heap by 48 MB before the fix and by
  7 MB after. Configurable via the new `maxEventSize`.

- **The XHR fallback no longer accumulates the whole response.**
  `XMLHttpRequest.responseText` keeps everything for the life of the connection.
  It now force-reconnects past `xhrMaxBufferBytes`, resuming from
  `Last-Event-ID`.

- **iOS: the URLSession is invalidated on natural stream end.** A session
  strongly retains its delegate, and only `disconnect()` invalidated one — so
  every reconnect leaked a session and a connection object.

- **Android: one shared `OkHttpClient` instead of one per connection.** Each
  client brought its own connection pool and dispatcher, so reconnects
  accumulated threads. 60 connect/disconnect cycles left 62 OkHttp threads
  before the fix and 3 after.

- **Line scanning is linear in line count.** The scan for `\r` restarted from
  scratch for every line, which is quadratic on the common LF-only stream.
  Parsing 32 000 lines took 146 ms before and 2.9 ms after — the old cost was
  enough to drop frames on the UI thread.

- **The React hook no longer re-renders once per event.** `metrics` refreshed on
  every message with a freshly allocated object, forcing a render even when
  nothing observable changed. It now refreshes on state changes and on
  `metricsIntervalMs`.

### Fixed — security

- **Credentials no longer follow a cross-origin redirect.** `Authorization`,
  `Cookie`, and `Proxy-Authorization` are stripped when a redirect changes
  scheme, host, or port. OkHttp already dropped `Authorization` on a host change
  but carried `Cookie` through, and treated a port change as the same origin;
  iOS had no redirect policy at all.

- **The Expo config plugin scopes cleartext HTTP to named domains.**
  `allowCleartext: true` set `NSAllowsArbitraryLoads`, disabling App Transport
  Security app-wide. The new `cleartextDomains` writes an `NSExceptionDomains`
  entry and an Android `network_security_config.xml` `domain-config` instead.
  `allowCleartext` still works and is now documented as the blunt option.

- **`id:` is capped** (`maxIdLength`, default 1024). The value is echoed back in
  the `Last-Event-ID` header, so an unbounded one lets a server provoke requests
  that proxies reject with 431.

- **Invalid-URL errors no longer reproduce the URL.** SSE endpoints routinely
  carry a token in the query string, and exception text reaches logs and crash
  reporters. Only the origin is reported.

### Fixed — lifecycle

- **A late callback can no longer resurrect a closed stream.** An error arriving
  after `close()` moved the state from `closed` to `failed` and fired
  `onFatalError` for a stream the caller had deliberately shut down.
- **`close()` is idempotent.** A second call no longer re-runs teardown or
  re-emits a `stateChange`.
- **iOS: `os_unfair_lock` replaced with `NSLock`.** Taking `&_lock` on a stored
  property of a class does not guarantee a stable address in Swift, so the lock
  was not reliably locking.
- **The state-transition table now matches the code.** Four legitimate
  transitions were missing from it, including `failed → closed` and the direct
  `open → connecting` that `reconnect()` performs.

### Fixed — Android linking

- **Android autolinking config corrected, and now actually shipped.**
  `react-native.config.js` set `platforms.android: null`, which excludes a
  package from autolinking entirely.

  The blast radius was narrower than it looks: the file was never listed in
  `files`, so it never reached npm. Installing from the registry gave the
  resolver no config, it fell back to its defaults, and Android autolinked fine
  — confirmed against the published 0.1.7 tarball. What broke was every *linked*
  install: `file:` dependencies, workspaces, monorepo checkouts, and this
  repository's own example app, where the module was absent and the app fell
  back to the JS transport. If you install this package from npm, Android was
  working; if you develop against a checkout of it, it was not.
- `NativeSseModule` now extends the Codegen-generated spec, which caught a
  signature mismatch: `removeListeners` took `Int` where Codegen declares
  `double`.
- Gradle configuration modernised for React Native 0.86: AGP 8.12, Kotlin 2.1.20,
  `com.facebook.react:react-android` in place of a wildcard `react-native:+`, and
  the New Architecture Gradle plugin applied unconditionally (a `newArchEnabled`
  check would silently skip Codegen, since RN 0.82 no longer sets that property).

### Changed — breaking

- **`timeout` is a connection-establishment timeout, not a read timeout.** It
  previously also served as a read timeout, so `timeout: 5000` killed a healthy
  stream after five seconds of silence — normal on SSE. Use `staleTimeoutMs` for
  zombie detection, which is what it is for.

- **A server's `retry:` value is clamped and jittered.** It is no longer scheduled
  verbatim. `retry: 0` meant reconnecting with no backoff at all, and a value
  large enough to overflow to `Infinity` collapsed to ~1 ms in `setTimeout` — the
  same tight loop by the opposite route. Bounded by the new
  `minReconnectDelayMs` / `maxReconnectDelayMs`; opt out with
  `respectServerRetry: false`.

- **`SseStreamManager.closeAll()` only closes its own streams.** It used to issue
  a process-wide native `disconnectAll()`, tearing down streams created with
  `new NativeSSE()` directly or held by another manager. Use the new
  `disconnectAllStreams()` for the process-wide behaviour.

- **`transport: 'fetch'` throws when the runtime cannot stream a response body.**
  It used to fall back to `await response.text()`, which never resolves for a
  stream that does not end — the connection sat there delivering nothing and
  reporting no error.

- **`transport: 'auto'` prefers streaming fetch over XHR** when the native module
  is absent, because of the `responseText` accumulation described above.

- **The default `storageKey` is derived from the URL.** It was the fixed string
  `'sse:last-event-id'`, so two streams using `persistLastEventId` overwrote each
  other's resume position. Now `sse:last-event-id:<origin><pathname>`. Streams on
  the same endpoint still need an explicit key.

- **A trailing `\r` at the end of a chunk is deferred to the next chunk or
  `flush()`.** It is genuinely ambiguous — bare-CR terminator, or the first half
  of a CRLF still in flight — and resolving it eagerly broke CRLF split across
  chunks. Affects only servers using bare-CR terminators, which the spec permits
  but almost nothing uses; such an event now arrives one chunk later.

- **`maxLineLength` no longer crosses the bridge.** It was declared in the
  TurboModule spec and sent on every `connect()`, but no native code ever read
  it: the native layer is a pure transport and the limit is enforced in JS.

- **Deep imports into the package are no longer resolvable.** Adding an `exports`
  map encapsulates the package, so `import ... from 'jose-native-sse/lib/commonjs/SseParser'`
  now fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Import from the package root;
  everything intended for consumers is exported there.

- **`peerDependencies` require `react-native >= 0.76`** (New Architecture) and
  Node >= 20.19.4 to build.

- **iOS deployment target is 15.1**, matching React Native 0.86.

### Added

- `maxEventSize`, `maxIdLength` — parser limits (see *Fixed*).
- `respectServerRetry`, `minReconnectDelayMs`, `maxReconnectDelayMs` — control
  over server-supplied reconnect delays.
- `xhrMaxBufferBytes` — XHR fallback buffer ceiling.
- `metricsIntervalMs` (hook) — how often the `metrics` snapshot refreshes.
- `useNativeSSE` returns `sse`, the underlying stream, for `addEventListener` and
  for reading every event rather than only the most recent.
- `SseStreamManager.disconnectAllStreams()`.
- Expo config plugin option `cleartextDomains`.
- `react-native.config.js` is now published, so the podspec path and Android
  source directory are stated rather than inferred.
- `exports` map and `sideEffects: false` in `package.json`. The build now emits a
  real dual package — `lib/commonjs` and `lib/module` each carry a `type` marker,
  and type definitions are split per condition — so both `require()` and `import`
  resolve. Verified by installing the packed tarball into a clean project and
  loading it through both.
- `stress/` — an adversarial SSE server plus JS and Kotlin/JVM stress suites.
- Regression tests for every finding above.

### Removed

- `ios/SseConnection.{h,m}` — 416 lines of a superseded native-parsing
  implementation. It was never referenced, but was compiled into every build and
  shipped in the package, and declared an unprefixed Objective-C class
  (`SseConnection`) that risked a symbol collision with another pod.

### Documentation

- `lastMessage` is documented as a preview of the latest event, not a log: React
  coalesces state updates, so events landing in the same tick are not all
  rendered. Anything that must see every event reads from `sse` instead.
- New "Limits and hardening" section covering every bound and the redirect and
  decoding guarantees.
- Corrected claims that `maxLineLength` was enforced natively, that the legacy
  bridge needed manual registration, and that the XHR fallback used only
  "slightly" more memory.

## [0.2.0] — unreleased

Never published; its changes ship as part of 0.3.0.

- Updated toolchain for Expo SDK 57 / React Native 0.86.2.
- Public `reconnect()` method for a forced immediate reconnect.

## [0.1.7]

- ESLint and Prettier configuration.
- Documentation fixes.
