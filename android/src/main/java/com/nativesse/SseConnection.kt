package com.nativesse

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * V2 OkHttp-backed SSE connection with:
 *  • Structured error codes (NETWORK_ERROR, HTTP_ERROR, TIMEOUT_ERROR, PARSE_ERROR)
 *  • Buffer overflow protection via maxLineLength
 *  • byteLength reported per event for JS-side metrics
 *  • Thread-safe cancellation via AtomicBoolean
 */
internal class SseConnection(
    val streamId:     String,
    private val url:          String,
    private val method:       String,
    private val headers:      Map<String, String>,
    private val body:         String?,
    private val timeoutMs:    Long,
    private val maxLineLength: Int = 1_048_576,
    private val onOpen:  (statusCode: Int, headers: Map<String, String>) -> Unit,
    /**
     * Parameters: eventType, data, lastEventId, byteLength, retryMs (null if not a retry event).
     * For the __retry__ pseudo-event, byteLength=0 and retryMs is set.
     */
    private val onEvent: (type: String, data: String, id: String, byteLength: Int, retry: Int?) -> Unit,
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

    // ─── SSE parser state ─────────────────────────────────────────────────────

    private var eventType   = ""
    private val dataLines   = mutableListOf<String>()
    private var lastEventId = ""

    // ─── Public API ───────────────────────────────────────────────────────────

    fun connect() {
        cancelled.set(false)

        // Reset parser state (lastEventId preserved across reconnects per spec).
        eventType = ""
        dataLines.clear()

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
                        // BufferedReader.readLine() handles \n, \r, \r\n — perfect for SSE.
                        val reader = BufferedReader(InputStreamReader(bodyStream, Charsets.UTF_8))
                        var line: String?
                        while (!cancelled.get() && reader.readLine().also { line = it } != null) {
                            processLine(line!!)
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

    // ─── SSE line parsing ─────────────────────────────────────────────────────

    private fun processLine(line: String) {
        // Guard against pathological lines (e.g. a server sending a 10 MB line).
        if (line.length > maxLineLength) {
            onError(
                "Line exceeds maxLineLength (${line.length} > $maxLineLength)",
                null, "PARSE_ERROR", false
            )
            return
        }

        when {
            line.isEmpty()         -> dispatchEvent()
            line.startsWith(":")   -> { /* SSE comment – ignored */ }
            else -> {
                val colonIdx = line.indexOf(':')
                val field: String
                val value: String
                if (colonIdx == -1) {
                    field = line; value = ""
                } else {
                    field = line.substring(0, colonIdx)
                    val raw = line.substring(colonIdx + 1)
                    value = if (raw.startsWith(" ")) raw.substring(1) else raw
                }
                when (field) {
                    "event" -> eventType = value
                    "data"  -> dataLines.add(value)
                    "id"    -> if (!value.contains('\u0000')) lastEventId = value
                    "retry" -> {
                        if (value.all { it.isDigit() } && value.isNotEmpty()) {
                            value.toIntOrNull()?.let { ms ->
                                onEvent("__retry__", ms.toString(), lastEventId, 0, ms)
                            }
                        }
                    }
                }
            }
        }
    }

    private fun dispatchEvent() {
        if (dataLines.isEmpty()) { eventType = ""; return }

        val data      = dataLines.joinToString("\n")
        val type      = if (eventType.isEmpty()) "message" else eventType
        val id        = lastEventId
        val byteLength = data.toByteArray(Charsets.UTF_8).size

        eventType = ""
        dataLines.clear()

        onEvent(type, data, id, byteLength, null)
    }
}
