// SseConnection.swift
// V2 – Swift implementation using URLSession streaming data tasks.
//
// Design:
//  • Pure Swift — no ObjC-specific APIs except where needed for bridge compat.
//  • Thin transport: raw UTF-8 chunks are forwarded to JS for SSE parsing.
//    All SSE protocol parsing (line splitting, field extraction, event dispatch)
//    lives in the JS SseParser, keeping native code minimal.
//  • Thread-safe cancel flag via NSLock.
//  • Exposed to ObjC++ via @objcMembers so NativeSse.mm can use it directly.

import Foundation

// MARK: - SseConnectionSwift

@objcMembers
public final class SseConnectionSwift: NSObject {

    // MARK: Public properties

    public let streamId: String

    // Callbacks set by NativeSse.mm before connect() is called.
    public var onOpen:  ((Int, [String: String]) -> Void)?
    /// Parameters: (rawChunk, byteLength)
    public var onChunk: ((String, Int) -> Void)?
    /// Parameters: (message, statusCode or -1, errorCode, isFatal)
    public var onError: ((String, Int, String, Bool) -> Void)?
    public var onClose: (() -> Void)?

    // MARK: Private configuration

    private let url: URL
    private let method: String
    private let headers: [String: String]
    private let body: String?
    private let timeoutMs: TimeInterval   // in ms; 0 = no timeout

    // MARK: Private networking state

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private let lock = NSLock()
    private var _cancelled = false

    // MARK: Init

    public init(
        streamId:  String,
        url:       URL,
        method:    String,
        headers:   [String: String],
        body:      String?,
        timeoutMs: Double
    ) {
        self.streamId  = streamId
        self.url       = url
        self.method    = method
        self.headers   = headers
        self.body      = body
        self.timeoutMs = timeoutMs
        super.init()
    }

    // MARK: Public API

    public func connect() {
        lock.lock(); _cancelled = false; lock.unlock()

        var request = URLRequest(url: url)
        request.httpMethod = method
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }

        if let b = body, !b.isEmpty, method != "GET" {
            request.httpBody = b.data(using: .utf8)
        }
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let cfg = URLSessionConfiguration.default
        cfg.requestCachePolicy         = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest  = timeoutMs > 0 ? timeoutMs / 1_000 : .greatestFiniteMagnitude
        cfg.timeoutIntervalForResource = .greatestFiniteMagnitude

        // delegateQueue: nil → URLSession uses its own background serial queue.
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        task = session!.dataTask(with: request)
        task!.resume()
    }

    public func disconnect() {
        lock.lock(); _cancelled = true; lock.unlock()
        task?.cancel()
        session?.invalidateAndCancel()
        task    = nil
        session = nil
    }

    // MARK: Private helpers

    private var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }; return _cancelled
    }
}

// MARK: - URLSessionDataDelegate

extension SseConnectionSwift: URLSessionDataDelegate {

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard !isCancelled else { completionHandler(.cancel); return }
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            onError?("Non-HTTP response", -1, "NETWORK_ERROR", true)
            return
        }

        let status = http.statusCode
        guard (200 ..< 300).contains(status) else {
            completionHandler(.cancel)
            onError?("HTTP \(status)", status, "HTTP_ERROR", true)
            return
        }

        var respHeaders = [String: String]()
        http.allHeaderFields.forEach { respHeaders["\($0)"] = "\($1)" }
        onOpen?(status, respHeaders)
        completionHandler(.allow)
    }

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        guard !isCancelled else { return }
        // Forward raw bytes as UTF-8 text. All SSE parsing happens in JS.
        if let text = String(data: data, encoding: .utf8) {
            onChunk?(text, data.count)
        }
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard !isCancelled else { return }
        guard let err = error as NSError? else { onClose?(); return }
        if err.code == NSURLErrorCancelled { return }
        let code = err.code == NSURLErrorTimedOut ? "TIMEOUT_ERROR" : "NETWORK_ERROR"
        onError?(err.localizedDescription, -1, code, false)
    }
}
