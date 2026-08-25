package com.nativesse

import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharsetDecoder
import java.nio.charset.CoderResult
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * OkHttp-backed SSE connection — thin transport.
 *
 * Raw UTF-8 chunks are forwarded to JS via onChunk. All SSE protocol parsing
 * (line splitting, field extraction, event dispatch) lives in the JS SseParser,
 * keeping native code minimal and eliminating parsing duplication.
 *
 * Two details matter for correctness:
 *
 *  • Decoding is **incremental**. A read boundary lands inside a multi-byte
 *    sequence roughly as often as the sequence is wide, so decoding each read
 *    in isolation corrupts any non-ASCII stream. The decoder below carries the
 *    partial sequence over to the next read.
 *
 *  • The HTTP client is **shared**. A per-connection OkHttpClient brings its own
 *    connection pool and dispatcher, so a client per reconnect accumulates
 *    threads and prevents connection reuse.
 */
internal class SseConnection(
    val streamId:     String,
    private val url:          String,
    private val method:       String,
    private val headers:      Map<String, String>,
    private val body:         String?,
    /** Connection-establishment timeout. 0 = OkHttp default. Never a read timeout. */
    private val timeoutMs:    Long,
    private val onOpen:  (statusCode: Int, headers: Map<String, String>) -> Unit,
    /** Parameters: decoded text, UTF-8 byte length actually read. */
    private val onChunk: (chunk: String, byteLength: Int) -> Unit,
    /** Parameters: message, statusCode (null = not HTTP), errorCode, isFatal. */
    private val onError: (message: String, statusCode: Int?, errorCode: String, isFatal: Boolean) -> Unit,
    private val onClose: () -> Unit,
) {
    private val cancelled = AtomicBoolean(false)
    private var call: Call? = null

    companion object {
        private const val READ_BUFFER_BYTES = 8192
        private const val DEFAULT_CONNECT_TIMEOUT_MS = 30_000L

        /**
         * One client for the whole process. Reconnects derive from it with
         * [OkHttpClient.newBuilder], which shares the connection pool and
         * dispatcher rather than allocating new thread pools.
         *
         * No read timeout: silence is normal on an SSE stream, and zombie
         * detection belongs to the JS `staleTimeoutMs` option, which knows
         * whether events are still arriving.
         */
        private val sharedClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .retryOnConnectionFailure(false)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .callTimeout(0, TimeUnit.MILLISECONDS)
                .connectTimeout(DEFAULT_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .addNetworkInterceptor(CrossOriginHeaderScrubber)
                .build()
        }

        /** Carries the origin the caller actually asked for across redirects. */
        private data class OriginTag(val url: HttpUrl)

        private val SENSITIVE_HEADERS =
            listOf("Authorization", "Cookie", "Proxy-Authorization")

        /**
         * Strips credentials when a redirect leaves the original origin, so a
         * server-chosen `Location` cannot harvest the caller's Authorization or
         * Cookie header.
         *
         * OkHttp already drops Authorization on a cross-host redirect but keeps
         * Cookie, and it treats a port change as the same origin. This closes
         * both gaps and matches the iOS delegate's behaviour.
         */
        private object CrossOriginHeaderScrubber : Interceptor {
            override fun intercept(chain: Interceptor.Chain): Response {
                val request = chain.request()
                val origin = request.tag(OriginTag::class.java)?.url
                    ?: return chain.proceed(request)

                val sameOrigin = request.url.scheme == origin.scheme &&
                    request.url.host == origin.host &&
                    request.url.port == origin.port
                if (sameOrigin) return chain.proceed(request)

                val scrubbed = request.newBuilder().apply {
                    for (h in SENSITIVE_HEADERS) removeHeader(h)
                }.build()
                return chain.proceed(scrubbed)
            }
        }
    }

    private fun clientFor(connectTimeoutMs: Long): OkHttpClient =
        if (connectTimeoutMs <= 0) {
            sharedClient
        } else {
            sharedClient.newBuilder()
                .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
                .build()
        }

    // ─── Public API ───────────────────────────────────────────────────────────

    fun connect() {
        cancelled.set(false)

        val reqBuilder = Request.Builder().url(url)
        for ((k, v) in headers) reqBuilder.header(k, v)

        // Only attach a body when the method allows one. The content type comes
        // from the caller's headers when set; OkHttp's BridgeInterceptor only
        // fills Content-Type from the body when the header is absent.
        val requestBody = if (!body.isNullOrEmpty() && method.uppercase() != "GET") {
            body.toRequestBody(headers["Content-Type"]?.toMediaTypeOrNull())
        } else null
        reqBuilder.method(method, requestBody)

        val request = reqBuilder.build()
        // Tags survive redirect rebuilding, so the scrubber can always compare
        // against the origin the caller actually asked for.
        val tagged = request.newBuilder()
            .tag(OriginTag::class.java, OriginTag(request.url))
            .build()

        val newCall = clientFor(timeoutMs).newCall(tagged)
        call = newCall
        newCall.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cancelled.get()) return
                val isTimeout = e is SocketTimeoutException
                onError(e.message ?: "Connection failed", null,
                    if (isTimeout) "TIMEOUT_ERROR" else "NETWORK_ERROR", false)
            }

            override fun onResponse(call: Call, response: Response) {
                if (cancelled.get()) { response.close(); return }

                val statusCode = response.code
                if (statusCode < 200 || statusCode >= 300) {
                    response.close()
                    onError("HTTP $statusCode", statusCode, "HTTP_ERROR", true)
                    return
                }

                val respHeaders = buildMap {
                    for (i in 0 until response.headers.size) {
                        put(response.headers.name(i), response.headers.value(i))
                    }
                }
                onOpen(statusCode, respHeaders)

                response.use { r ->
                    val bodyStream = r.body?.byteStream() ?: run {
                        onError("Empty response body", null, "NETWORK_ERROR", false)
                        return
                    }
                    try {
                        pump(bodyStream)
                        if (!cancelled.get()) onClose()
                    } catch (e: IOException) {
                        if (!cancelled.get()) {
                            val isTimeout = e is SocketTimeoutException
                            onError(e.message ?: "Stream read error", null,
                                if (isTimeout) "TIMEOUT_ERROR" else "NETWORK_ERROR", false)
                        }
                    }
                }
            }
        })
    }

    fun disconnect() {
        cancelled.set(true)
        call?.cancel()
        call = null
    }

    // ─── Streaming ────────────────────────────────────────────────────────────

    /**
     * Read the body and forward decoded text, carrying any partial multi-byte
     * sequence across read boundaries. All SSE parsing happens in JS.
     */
    private fun pump(bodyStream: java.io.InputStream) {
        val decoder: CharsetDecoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)

        val raw = ByteArray(READ_BUFFER_BYTES)
        // Headroom for a partial sequence carried over from the previous read
        // (at most 3 bytes of an incomplete 4-byte sequence).
        val bytes = ByteBuffer.allocate(READ_BUFFER_BYTES + 8)
        // An all-ASCII read yields one char per byte, the densest case.
        val chars = CharBuffer.allocate(READ_BUFFER_BYTES + 8)

        while (!cancelled.get()) {
            val n = bodyStream.read(raw)
            if (n == -1) break
            if (n == 0) continue

            bytes.put(raw, 0, n)
            emitDecoded(decoder, bytes, chars, endOfInput = false, byteLength = n)
        }

        if (cancelled.get()) return

        // Drain: decode what is left, then let the decoder emit a replacement
        // char for any sequence the server truncated.
        emitDecoded(decoder, bytes, chars, endOfInput = true, byteLength = 0)
        chars.clear()
        decoder.flush(chars)
        chars.flip()
        if (chars.hasRemaining()) onChunk(chars.toString(), 0)
    }

    /**
     * Decode everything currently buffered, emitting as many chunks as needed if
     * the char buffer fills. Undecoded trailing bytes stay in [bytes] for the
     * next read.
     */
    private fun emitDecoded(
        decoder: CharsetDecoder,
        bytes: ByteBuffer,
        chars: CharBuffer,
        endOfInput: Boolean,
        byteLength: Int,
    ) {
        bytes.flip()
        var reportedBytes = byteLength
        while (true) {
            chars.clear()
            val result: CoderResult = decoder.decode(bytes, chars, endOfInput)
            chars.flip()
            if (chars.hasRemaining()) {
                // Attribute the byte count to the first emission of this read so
                // metrics stay accurate without double counting.
                onChunk(chars.toString(), reportedBytes)
                reportedBytes = 0
            }
            if (!result.isOverflow) break
        }
        bytes.compact()
    }
}
