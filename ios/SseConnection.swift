// SseConnection.swift
// Swift implementation using URLSession streaming data tasks.
//
// Design:
//  • Thin transport: raw UTF-8 chunks are forwarded to JS for SSE parsing.
//    All SSE protocol parsing (line splitting, field extraction, event dispatch)
//    lives in the JS SseParser, keeping native code minimal.
//  • Decoding is incremental: URLSession hands over arbitrary byte boundaries,
//    so a partial multi-byte sequence is held back until its remaining bytes
//    arrive. Decoding each delivery in isolation would corrupt — or, with
//    `String(data:encoding:)`, silently discard — any non-ASCII stream.
//  • Exposed to ObjC++ via @objcMembers so NativeSse.mm can use it directly.

import Foundation

// MARK: - SseConnectionSwift

@objcMembers
public final class SseConnectionSwift: NSObject {

    // MARK: Public properties

    public let streamId: String

    // Callbacks set by NativeSse.mm before connect() is called.
    public var onOpen:  ((Int, [String: String]) -> Void)?
    /// Parameters: (decodedText, byteLength)
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

    // NSLock rather than os_unfair_lock: taking `&_lock` on a stored property of
    // a class does not guarantee a stable address in Swift, so the lock may not
    // actually lock. This is taken once per delivery — the cost is noise next to
    // the bridge crossing that follows.
    private let lock = NSLock()
    private var _cancelled = false
    private var _didOpen = false
    private var _connectTimer: DispatchWorkItem?

    /// Bytes received but not yet decodable: the tail of a split UTF-8 sequence.
    /// Never exceeds 3 bytes. Only touched on the delegate queue.
    private var pending = Data()

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
        lock.lock()
        _cancelled = false
        _didOpen = false
        pending.removeAll(keepingCapacity: true)
        lock.unlock()

        var request = URLRequest(url: url)
        request.httpMethod = method
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }

        if let b = body, !b.isEmpty, method.uppercased() != "GET" {
            request.httpBody = b.data(using: .utf8)
        }
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let cfg = URLSessionConfiguration.default
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        // `timeoutIntervalForRequest` is an inactivity timeout, and silence is
        // normal on an SSE stream. Zombie detection belongs to the JS
        // `staleTimeoutMs` option, which knows whether events are arriving.
        cfg.timeoutIntervalForRequest  = .greatestFiniteMagnitude
        cfg.timeoutIntervalForResource = .greatestFiniteMagnitude

        // delegateQueue: nil → URLSession uses its own background serial queue.
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        task = session!.dataTask(with: request)
        if timeoutMs > 0 {
            // Approximate a connect timeout: URLSession has no dedicated one, so
            // bound how long the task may sit before a response arrives.
            scheduleConnectTimeout(seconds: timeoutMs / 1_000)
        }
        task!.resume()
    }

    public func disconnect() {
        lock.lock()
        _cancelled = true
        let timer = _connectTimer
        _connectTimer = nil
        let s = session
        let t = task
        session = nil
        task = nil
        lock.unlock()

        timer?.cancel()
        t?.cancel()
        // Releases the session's strong reference to this delegate.
        s?.invalidateAndCancel()
    }

    // MARK: Private helpers

    private var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _cancelled
    }

    private func scheduleConnectTimeout(seconds: TimeInterval) {
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let fire = !self._cancelled && !self._didOpen
            self.lock.unlock()
            guard fire else { return }
            self.onError?("Connection timed out", -1, "TIMEOUT_ERROR", false)
            self.teardown()
        }
        lock.lock(); _connectTimer = item; lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: item)
    }

    /// Mark the response as arrived and cancel the connect deadline.
    private func markOpened() {
        lock.lock()
        _didOpen = true
        let timer = _connectTimer
        _connectTimer = nil
        lock.unlock()
        timer?.cancel()
    }

    /// Release the session so it stops retaining this object as its delegate.
    /// Safe to call more than once, from any queue.
    private func teardown() {
        lock.lock()
        let timer = _connectTimer
        _connectTimer = nil
        let s = session
        session = nil
        task = nil
        lock.unlock()

        timer?.cancel()
        s?.finishTasksAndInvalidate()
    }

    /**
     Number of leading bytes of `data` that form only complete UTF-8 sequences.

     Scans back at most four bytes for the last lead byte; if the sequence it
     starts is short of the length its prefix declares, that sequence is held
     back for the next delivery.
     */
    private static func completeByteCount(_ data: Data) -> Int {
        guard !data.isEmpty else { return 0 }
        let count = data.count
        var offset = 0

        while offset < 4 && offset < count {
            let b = data[data.startIndex + count - 1 - offset]
            let isContinuation = (b & 0xC0) == 0x80
            if !isContinuation {
                let need: Int
                if b & 0x80 == 0        { need = 1 }
                else if b & 0xE0 == 0xC0 { need = 2 }
                else if b & 0xF0 == 0xE0 { need = 3 }
                else if b & 0xF8 == 0xF0 { need = 4 }
                else                     { need = 1 }  // invalid lead: let the decoder replace it
                let have = offset + 1
                return have >= need ? count : count - have
            }
            offset += 1
        }
        // Four or more continuation bytes with no lead in sight: malformed, so
        // hand it all to the decoder and let it substitute.
        return count
    }

    /// Decode as much of `pending` as forms whole characters and hand it to JS.
    private func drain(reportingBytes byteLength: Int) {
        let safe = Self.completeByteCount(pending)
        guard safe > 0 else { return }  // whole delivery was a partial sequence

        let decodable = pending.prefix(safe)
        pending.removeFirst(safe)

        // `String(decoding:as:)` substitutes U+FFFD instead of returning nil, so
        // a malformed byte costs one character rather than the whole chunk.
        let text = String(decoding: decodable, as: UTF8.self)
        if !text.isEmpty {
            onChunk?(text, byteLength)
        }
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

        markOpened()

        var respHeaders = [String: String]()
        http.allHeaderFields.forEach { respHeaders["\($0.key)"] = "\($0.value)" }
        onOpen?(status, respHeaders)
        completionHandler(.allow)
    }

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        guard !isCancelled else { return }
        pending.append(data)
        drain(reportingBytes: data.count)
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard !isCancelled else { teardown(); return }

        // Flush any trailing partial sequence so the server's last bytes are not
        // swallowed; the decoder substitutes for whatever is truncated.
        if !pending.isEmpty {
            let text = String(decoding: pending, as: UTF8.self)
            pending.removeAll(keepingCapacity: false)
            if !text.isEmpty { onChunk?(text, 0) }
        }

        defer { teardown() }

        guard let err = error as NSError? else { onClose?(); return }
        if err.code == NSURLErrorCancelled { return }
        let code = err.code == NSURLErrorTimedOut ? "TIMEOUT_ERROR" : "NETWORK_ERROR"
        onError?(err.localizedDescription, -1, code, false)
    }

    /**
     Redirects are followed, but credentials are not carried to a different
     origin: a server-chosen `Location` must not be able to harvest the
     Authorization header the caller set for the original host.
     */
    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard !isCancelled else { completionHandler(nil); return }

        let sameOrigin =
            request.url?.host == url.host &&
            request.url?.scheme == url.scheme &&
            request.url?.port == url.port

        if sameOrigin {
            completionHandler(request)
            return
        }

        var stripped = request
        for header in ["Authorization", "Cookie", "Proxy-Authorization"] {
            stripped.setValue(nil, forHTTPHeaderField: header)
        }
        completionHandler(stripped)
    }
}
