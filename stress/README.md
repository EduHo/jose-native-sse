# Stress suite

Drives the library against a deliberately hostile SSE server over **real sockets**
rather than mocks. Written to reproduce the defects found in the code audit; now
that those are fixed, it is what keeps them fixed.

Everything here should pass. Two lines in `wire.mjs` are labelled `ANTIGO` and are
*expected* to fail: they replay the decoding strategies the native layers used
before the fix, so the report shows the defect next to the current behaviour.
Only the `ACTUAL` line reflects what ships today.

`npm test` does not run any of this — the suite is deliberately separate so the
unit suite stays a statement about intended behaviour, and so a slow, socket-bound
run never gates CI.

## Running it

```sh
npm run stress          # boots the server, runs the JS scenarios, shuts it down
```

Or piecewise, if you want to poke at the server by hand:

```sh
node stress/server.mjs 3000     # terminal 1
node stress/wire.mjs            # terminal 2  (STRESS_PORT to override the port)
node --expose-gc stress/parser.mjs
```

The Android half runs on the JVM and needs no server:

```sh
cd example-expo/android
./gradlew :jose-native-sse:testDebugUnitTest
```

## What each part covers

### `server.mjs` — adversarial SSE server

Writes `Buffer`s, never strings, so chunk boundaries land on exact byte offsets.
That is what makes the UTF-8 cases reproducible instead of accidental.

| Route | Purpose |
|---|---|
| `/health`, `/events` | Liveness and a well-behaved baseline (also serves `__tests__/e2e.test.ts`) |
| `/utf8-split` | Flushes in 7-byte slices, cutting inside multi-byte characters |
| `/utf8-whole` | Control: same payload, whole frames |
| `/retry-zero`, `/retry-huge` | Server-controlled reconnect delay (C2) |
| `/overflow-resync` | Oversized line, then a tail shaped like SSE fields (C3) |
| `/overflow-resync-aligned` | Same, with the boundary forced so the attacker also controls `event:` |
| `/no-blank-line` | `data:` forever, never a blank line (C4) |
| `/flood` | Throughput |
| `/silent` | Opens then goes quiet — stale detection |
| `/forbidden` | 403, must not be retried |

### `wire.mjs` — decoder comparison over real HTTP

Pulls raw `Buffer`s off a live socket and runs each chunk through the two decode
strategies the native layers actually use, plus a correct incremental one, then
feeds each result into the real `SseParser`.

Distinguishes "splitting a string mid-character corrupts it" (obvious) from
"the shipped native code corrupts real traffic" (the claim).

### `parser.mjs` — parser fuzzing and limits

- 20 000 random chunk splittings of the same payload; output must be identical
- C3: nothing from the tail of a dropped line may ever be dispatched
- C4: memory must not track the stream when no blank line ever arrives
- Throughput in events/s and MB/s
- Scan complexity: per-line cost as line count grows, to detect the quadratic
  `indexOf('\r')` rescan

### `SseConnectionStressTest.kt` — the real Kotlin transport

Drives the shipped `SseConnection` against `MockWebServer`. The UTF-8 defect only
exists in the interaction between OkHttp's read buffer and
`String(buffer, 0, n, Charsets.UTF_8)`, so it cannot be observed from the JS layer
or by reading the Kotlin in isolation.

- Throttled reads that guarantee a split inside a 4-byte sequence
- A sustained 460 KB stream, unthrottled, counting real losses
- Control: a short body that fits one read
- Credentials stripped on a cross-origin redirect, via a second MockWebServer
- Thread accumulation across 60 connect/disconnect cycles
- 400 concurrent connect/disconnect cycles against the cancellation flag

## Reading the results

Finding IDs (C1, C3, H3…) refer to the code audit. A `FAIL` outside the two
`ANTIGO` rows is a regression.

The `PASS` lines carry information too: the boundary fuzz says the parser produces
identical output regardless of where 20 000 random chunk splits land, and the race
scenario says 400 concurrent connect/disconnect cycles neither throw nor deliver a
chunk after `disconnect()` returns. Both should stay true.
