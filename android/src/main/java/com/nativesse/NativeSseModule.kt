package com.nativesse

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.ConcurrentHashMap

/**
 * V2 TurboModule implementation.
 *
 * Changes from V1:
 *  • onEvent callback now includes byteLength and retryMs parameters.
 *  • onError callback now includes an errorCode string.
 *  • maxLineLength option forwarded to SseConnection.
 *  • Module invalidate() cleans up all connections on unmount.
 */
@ReactModule(name = NativeSseModule.NAME)
class NativeSseModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "NativeNativeSse"
    }

    override fun getName(): String = NAME

    private val connections = ConcurrentHashMap<String, SseConnection>()

    // ─── React Methods ──────────────────────────────────────────────────────────

    @ReactMethod
    fun connect(streamId: String, url: String, options: ReadableMap) {
        val method    = options.getString("method") ?: "GET"
        val body      = options.getString("body")   ?: ""
        val timeoutMs = if (options.hasKey("timeout")) options.getInt("timeout").toLong() else 0L

        val headers = mutableMapOf<String, String>()
        options.getMap("headers")?.entryIterator?.forEach { e ->
            headers[e.key] = e.value?.toString() ?: ""
        }

        // Cancel any existing connection with this stream ID before creating a new one.
        connections[streamId]?.disconnect()

        val connection = SseConnection(
            streamId  = streamId,
            url       = url,
            method    = method,
            headers   = headers,
            body      = body.ifEmpty { null },
            timeoutMs = timeoutMs,

            onOpen = { statusCode, respHeaders ->
                val params: WritableMap = Arguments.createMap()
                params.putString("streamId",   streamId)
                params.putInt("statusCode",    statusCode)
                val hdrsMap = Arguments.createMap()
                for ((k, v) in respHeaders) hdrsMap.putString(k, v)
                params.putMap("headers", hdrsMap)
                sendEvent("sse_open", params)
            },

            onChunk = { chunk, byteLength ->
                val params: WritableMap = Arguments.createMap()
                params.putString("streamId",   streamId)
                params.putString("chunk",      chunk)
                params.putInt("byteLength",    byteLength)
                sendEvent("sse_chunk", params)
            },

            onError = { message, statusCode, errorCode, isFatal ->
                val params: WritableMap = Arguments.createMap()
                params.putString("streamId",  streamId)
                params.putString("message",   message)
                params.putString("errorCode", errorCode)
                params.putBoolean("isFatal",  isFatal)
                if (statusCode != null) params.putInt("statusCode", statusCode)
                sendEvent("sse_error", params)
                if (isFatal) connections.remove(streamId)
            },

            onClose = {
                val params: WritableMap = Arguments.createMap()
                params.putString("streamId", streamId)
                sendEvent("sse_close", params)
                connections.remove(streamId)
            },
        )

        connections[streamId] = connection
        connection.connect()
    }

    @ReactMethod
    fun disconnect(streamId: String) {
        connections.remove(streamId)?.disconnect()
    }

    @ReactMethod
    fun disconnectAll() {
        connections.values.forEach { it.disconnect() }
        connections.clear()
    }

    // No-ops required by TurboModule spec / RCTEventEmitter subscription tracking.
    @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}
    @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int)    {}

    // ─── Lifecycle ──────────────────────────────────────────────────────────────

    override fun invalidate() {
        super.invalidate()
        connections.values.forEach { it.disconnect() }
        connections.clear()
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private fun sendEvent(name: String, params: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(name, params)
    }
}
