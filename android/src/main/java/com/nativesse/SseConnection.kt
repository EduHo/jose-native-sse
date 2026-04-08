package com.nativesse

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * V2 OkHttp-backed SSE connection — thin transport.
 *
 * Raw UTF-8 chunks are forwarded to JS via onChunk. All SSE protocol parsing
 * (line splitting, field extraction, event dispatch) lives in the JS SseParser,
 * keeping native code minimal and eliminating parsing duplication.
 *
 * Features:
 *  • Structured error codes (NETWORK_ERROR, HTTP_ERROR, TIMEOUT_ERROR)
 *  • Thread-safe cancellation via AtomicBoolean
 */
internal class SseConnection(
    val streamId:     String,
    private val url:          String,
    private val method:       String,
    private val headers:      Map<String, String>,
    private val body:         String?,
    private val timeoutMs:    Long,
    private val onOpen:  (statusCode: Int, headers: Map<String, String>) -> Unit,
    /** Parameters: rawChunk text, UTF-8 byte length. */
    private val onChunk: (chunk: String, byteLength: Int) -> Unit,
    /** Parameters: message, statusCode (null = not HTTP), errorCode, isFatal. */
    private val onError: (message: String, statusCode: Int?, errorCode: String, isFatal: Boolean) -> Unit,
    private val onClose: () -> Unit,
) {
    private val cancelled = AtomicBoolean(false)
    private var call: Call? = null

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .readTimeout(if (timeoutMs > 0) timeoutMs else 0L, TimeUnit.MILLISECONDS)
            .connectTimeout(if (timeoutMs > 0) timeoutMs else 30_000L, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    fun connect() {
        cancelled.set(false)

        val reqBuilder = Request.Builder().url(url)
        for ((k, v) in headers) reqBuilder.header(k, v)

        val requestBody = if (!body.isNullOrEmpty() && method != "GET") {
            body.toRequestBody("text/plain".toMediaTypeOrNull())
        } else null
        reqBuilder.method(method, requestBody)

        call = client.newCall(reqBuilder.build())
        call!!.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cancelled.get()) return
                val isTimeout = e.message?.contains("timeout", ignoreCase = true) == true
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
                        // Read raw bytes and forward as UTF-8 text chunks.
                        // All SSE parsing happens in JS.
                        val buffer = ByteArray(8192)
                        var bytesRead: Int
                        while (!cancelled.get() &&
                               bodyStream.read(buffer).also { bytesRead = it } != -1) {
                            val chunk = String(buffer, 0, bytesRead, Charsets.UTF_8)
                            onChunk(chunk, bytesRead)
                        }
                        if (!cancelled.get()) onClose()
                    } catch (e: IOException) {
                        if (!cancelled.get()) {
                            val isTimeout = e.message?.contains("timeout", ignoreCase = true) == true
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
    }
}
