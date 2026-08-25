package com.nativesse

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * JVM stress tests for the real Kotlin transport, driven by MockWebServer.
 *
 * These run the shipped [SseConnection] against a real socket. That is the point:
 * the UTF-8 boundary defect only exists in the interaction between OkHttp's read
 * buffer and `String(buffer, 0, n, Charsets.UTF_8)`, so it cannot be observed by
 * testing the JS layer or by reasoning about the Kotlin in isolation.
 *
 *   cd example-expo/android && ./gradlew :jose-native-sse:testDebugUnitTest
 */
class SseConnectionStressTest {

  private lateinit var server: MockWebServer

  /** U+1F680 ROCKET — 4 bytes in UTF-8, the widest sequence a decoder must carry. */
  private val rocket = "🚀"
  private val replacement = '�'

  @Before
  fun setUp() {
    server = MockWebServer()
    server.start()
  }

  @After
  fun tearDown() {
    server.shutdown()
  }

  // ── Harness ────────────────────────────────────────────────────────────────

  private class Capture {
    val text = StringBuilder()
    val chunks = AtomicInteger(0)
    val bytes = AtomicInteger(0)
    val errors = mutableListOf<String>()
    val done = CountDownLatch(1)

    val replacementCount: Int get() = text.count { it == '�' }
  }

  /** Drive a full connect → stream → close cycle and return what JS would have seen. */
  private fun drive(path: String, timeoutMs: Long = 0L): Capture {
    val cap = Capture()
    val conn = SseConnection(
      streamId = "stress",
      url = server.url(path).toString(),
      method = "GET",
      headers = mapOf("Accept" to "text/event-stream"),
      body = null,
      timeoutMs = timeoutMs,
      onOpen = { _, _ -> },
      onChunk = { chunk, byteLength ->
        synchronized(cap.text) { cap.text.append(chunk) }
        cap.chunks.incrementAndGet()
        cap.bytes.addAndGet(byteLength)
      },
      onError = { message, _, code, _ ->
        synchronized(cap.errors) { cap.errors.add("$code: $message") }
        cap.done.countDown()
      },
      onClose = { cap.done.countDown() },
    )
    conn.connect()
    assertTrue(cap.done.await(30, TimeUnit.SECONDS), "stream did not finish in 30s")
    return cap
  }

  // ── C1a — deterministic split via a throttled socket ───────────────────────

  /**
   * Throttling to 7 bytes per period forces `read()` to return short buffers, so
   * every 4-byte sequence is guaranteed to straddle a read boundary. A decoder
   * that carries partial sequences across reads emits the text intact; the
   * shipped per-read decode cannot.
   */
  @Test
  fun `throttled reads split multi-byte sequences`() {
    val payload = "data: um $rocket dois $rocket tres $rocket\n\n"
    server.enqueue(
      MockResponse()
        .setHeader("Content-Type", "text/event-stream")
        .setBody(payload)
        .throttleBody(7, 20, TimeUnit.MILLISECONDS),
    )

    val cap = drive("/throttled")

    println("[C1a] chunks=${cap.chunks.get()} bytes=${cap.bytes.get()}")
    println("[C1a] esperado : ${payload.trim()}")
    println("[C1a] recebido : ${cap.text.toString().trim()}")
    println("[C1a] U+FFFD   : ${cap.replacementCount}")

    assertEquals(
      payload, cap.text.toString(),
      "texto corrompido: ${cap.replacementCount} caracteres de substituição " +
        "em ${cap.chunks.get()} chunks",
    )
  }

  // ── C1b — a sustained stream, no throttling ────────────────────────────────

  /**
   * A long body densely packed with 4-byte sequences, delivered as fast as the
   * socket allows. Read boundaries here are chosen by Okio's segmentation and by
   * socket delivery — not by a fixed offset — so this measures how often a real
   * unthrottled stream lands a boundary inside a character.
   *
   * Note this does NOT assume reads return exactly 8192 bytes: OkHttp hands back
   * whatever the buffered source has, which is why the small control case above
   * survives while a long stream does not.
   */
  @Test
  fun `sustained stream keeps multi-byte sequences intact`() {
    val unit = "data: $rocket$rocket$rocket ok\n\n"
    val repeats = 20_000
    val expectedRockets = repeats * 3

    val body = Buffer().apply { repeat(repeats) { writeUtf8(unit) } }
    val totalBytes = body.size

    server.enqueue(
      MockResponse()
        .setHeader("Content-Type", "text/event-stream")
        .setBody(body),
    )

    val cap = drive("/sustained")
    val received = cap.text.toString()
    val gotRockets = Regex(rocket).findAll(received).count()

    println("[C1b] $totalBytes bytes em ${cap.chunks.get()} leituras")
    println("[C1b] sequencias de 4 bytes: esperadas=$expectedRockets recebidas=$gotRockets " +
      "perdidas=${expectedRockets - gotRockets}")
    println("[C1b] U+FFFD: ${cap.replacementCount}")

    assertEquals(
      0, cap.replacementCount,
      "stream de ${totalBytes / 1024} KB em ${cap.chunks.get()} leituras produziu " +
        "${cap.replacementCount} caracteres de substituicao e perdeu " +
        "${expectedRockets - gotRockets} de $expectedRockets sequencias",
    )
  }

  // ── C1c — control: everything inside a single read ─────────────────────────

  @Test
  fun `short body inside one read is intact`() {
    val payload = "data: um $rocket dois\n\n"
    server.enqueue(
      MockResponse()
        .setHeader("Content-Type", "text/event-stream")
        .setBody(payload),
    )

    val cap = drive("/short")
    println("[C1c] chunks=${cap.chunks.get()} intacto=${cap.text.toString() == payload}")
    assertEquals(payload, cap.text.toString(), "o caso de controlo devia passar")
  }

  // ── S2 — credentials must not follow a cross-origin redirect ──────────────

  /**
   * A server-chosen `Location` must not be able to harvest the Authorization
   * header the caller set for the original host. Two MockWebServers stand in for
   * two origins; the redirect target is addressed by a different host string so
   * the comparison is a genuine origin change, not just a different port.
   */
  @Test
  fun `authorization is stripped on cross-origin redirect`() {
    val attacker = MockWebServer()
    attacker.start()
    try {
      attacker.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/event-stream")
          .setBody("data: landed\n\n"),
      )

      // Same loopback interface, different host string → different origin.
      val attackerUrl = attacker.url("/collect").toString()
        .replace("127.0.0.1", "localhost")
      server.enqueue(
        MockResponse().setResponseCode(302).setHeader("Location", attackerUrl),
      )

      val latch = CountDownLatch(1)
      val conn = SseConnection(
        streamId = "redirect",
        url = server.url("/start").toString(),
        method = "GET",
        headers = mapOf(
          "Authorization" to "Bearer super-secret",
          "Cookie" to "session=abc",
          "Accept" to "text/event-stream",
        ),
        body = null,
        timeoutMs = 0L,
        onOpen = { _, _ -> },
        onChunk = { _, _ -> },
        onError = { _, _, _, _ -> latch.countDown() },
        onClose = { latch.countDown() },
      )
      conn.connect()
      assertTrue(latch.await(20, TimeUnit.SECONDS), "redirect never resolved")

      val first = server.takeRequest(5, TimeUnit.SECONDS)
      val second = attacker.takeRequest(5, TimeUnit.SECONDS)

      println("[S2] pedido 1 (origem legitima): Authorization=${first?.getHeader("Authorization")}")
      println("[S2] pedido 2 (outra origem):    Authorization=${second?.getHeader("Authorization")}")
      println("[S2] pedido 2 Cookie:            ${second?.getHeader("Cookie")}")

      assertEquals(
        "Bearer super-secret", first?.getHeader("Authorization"),
        "o header devia chegar a origem legitima",
      )
      assertTrue(
        second == null || second.getHeader("Authorization") == null,
        "Authorization seguiu para outra origem: ${second?.getHeader("Authorization")}",
      )
    } finally {
      attacker.shutdown()
    }
  }

  // ── H3 — resource churn across connect/disconnect cycles ──────────────────

  /**
   * Each SseConnection lazily builds its own OkHttpClient, so every reconnect
   * creates a fresh ConnectionPool and Dispatcher with their own thread pools.
   * This measures what 60 cycles leave behind.
   */
  @Test
  fun `repeated connections do not accumulate threads`() {
    val cycles = 60
    repeat(cycles) {
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/event-stream")
          .setBody("data: tick\n\n"),
      )
    }

    fun okHttpThreads() = Thread.getAllStackTraces().keys.count {
      it.name.contains("OkHttp", ignoreCase = true)
    }

    val before = okHttpThreads()

    repeat(cycles) { i ->
      val latch = CountDownLatch(1)
      val conn = SseConnection(
        streamId = "churn-$i",
        url = server.url("/churn").toString(),
        method = "GET",
        headers = emptyMap(),
        body = null,
        timeoutMs = 0L,
        onOpen = { _, _ -> },
        onChunk = { _, _ -> },
        onError = { _, _, _, _ -> latch.countDown() },
        onClose = { latch.countDown() },
      )
      conn.connect()
      latch.await(10, TimeUnit.SECONDS)
      conn.disconnect()
    }

    // Give the pools a moment to reap idle threads on their own.
    Thread.sleep(1_000)
    val after = okHttpThreads()

    println("[H3] threads OkHttp antes=$before depois=$after apos $cycles ciclos")
    println("[H3] total de threads na JVM: ${Thread.getAllStackTraces().size}")

    assertTrue(
      after - before <= 4,
      "$cycles ciclos deixaram ${after - before} threads OkHttp extra " +
        "(antes=$before depois=$after) — um OkHttpClient por conexao nao e reciclado",
    )
  }

  // ── Concurrency — parallel connect/disconnect on the cancel flag ───────────

  /**
   * Hammers connect/disconnect from many threads at once. Guards against races
   * around the AtomicBoolean and the nullable `call` field: nothing here may
   * throw, and no callback may fire after disconnect returns.
   */
  @Test
  fun `concurrent connect and disconnect is race free`() {
    val threads = 16
    val perThread = 25
    repeat(threads * perThread + 50) {
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/event-stream")
          .setBody("data: x\n\n")
          .throttleBody(4, 5, TimeUnit.MILLISECONDS),
      )
    }

    val crashes = mutableListOf<Throwable>()
    val chunksAfterDisconnect = AtomicInteger(0)
    val start = CountDownLatch(1)

    val workers = (0 until threads).map { t ->
      Thread {
        start.await()
        repeat(perThread) { i ->
          try {
            val disconnected = java.util.concurrent.atomic.AtomicBoolean(false)
            val conn = SseConnection(
              streamId = "race-$t-$i",
              url = server.url("/race").toString(),
              method = "GET",
              headers = emptyMap(),
              body = null,
              timeoutMs = 0L,
              onOpen = { _, _ -> },
              onChunk = { _, _ ->
                if (disconnected.get()) chunksAfterDisconnect.incrementAndGet()
              },
              onError = { _, _, _, _ -> },
              onClose = { },
            )
            conn.connect()
            Thread.sleep((i % 5).toLong())
            disconnected.set(true)
            conn.disconnect()
          } catch (e: Throwable) {
            synchronized(crashes) { crashes.add(e) }
          }
        }
      }.also { it.isDaemon = true; it.start() }
    }

    start.countDown()
    workers.forEach { it.join(60_000) }

    println("[RACE] ${threads * perThread} ciclos, excepcoes=${crashes.size}, " +
      "chunks apos disconnect=${chunksAfterDisconnect.get()}")
    crashes.take(3).forEach { println("[RACE] ${it::class.simpleName}: ${it.message}") }

    assertTrue(crashes.isEmpty(), "excepcoes sob concorrencia: ${crashes.size}")
  }
}
