// SseConnection.swift
// V2 – Swift implementation using URLSession streaming data tasks.
//
// Design:
//  • Pure Swift — no ObjC-specific APIs except where needed for bridge compat.
//  • Byte-level SSE line state machine with full \r, \n, \r\n support.
//  • Buffer overflow protection: lines exceeding maxLineLength are dropped and
//    reported via onError with code "PARSE_ERROR".
//  • byteLength reported per event for JS-side metrics.
//  • Thread-safe cancel flag via NSLock.
//  • Exposed to ObjC++ via @objcMembers so NativeSse.mm can use it directly.

import Foundation

// MARK: - Internal line parser state

private enum LineState {
    case normal
    case afterCR
}

// MARK: - SseConnectionSwift

@objcMembers
public final class SseConnectionSwift: NSObject {

    // MARK: Public properties

    public let streamId: String

    // Callbacks set by NativeSse.mm before connect() is called.
    // Using ObjC-compatible closure types (Swift closures bridge to ObjC blocks).
    public var onOpen:  ((Int, [String: String]) -> Void)?
    /// Parameters: (eventType, data, lastEventId, byteLength, retryMs or -1)
    public var onEvent: ((String, String, String, Int, Int) -> Void)?
    /// Parameters: (message, statusCode or -1, errorCode, isFatal)
    public var onError: ((String, Int, String, Bool) -> Void)?
    public var onClose: (() -> Void)?

    // MARK: Private configuration

    private let url: URL
    private let method: String
    private let headers: [String: String]
    private let body: String?
    private let timeoutMs: TimeInterval   // in ms; 0 = no timeout
    private let maxLineLength: Int

    // MARK: Private networking state

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private let lock = NSLock()
    private var _cancelled = false

    // MARK: Private parser state

    // Line byte buffer – never grows beyond maxLineLength + 1.
    private var lineBytes = Data()
    private var lineState: LineState = .normal

    // SSE field accumulators.
    private var eventType  = ""
    private var dataLines  = [String]()
    private var lastEventId = ""

    // MARK: Init

    public init(
        streamId:     String,
        url:          URL,
        method:       String,
        headers:      [String: String],
        body:         String?,
        timeoutMs:    Double,
        maxLineLength: Int
    ) {
        self.streamId     = streamId
        self.url          = url
        self.method       = method
        self.headers      = headers
        self.body         = body
        self.timeoutMs    = timeoutMs
        self.maxLineLength = maxLineLength
        super.init()
    }

    // MARK: Public API

    public func connect() {
        lock.lock(); _cancelled = false; lock.unlock()

        // Reset parser for this new connection (lastEventId preserved per spec).
        lineBytes  = Data()
        lineState  = .normal
        eventType  = ""
        dataLines  = []

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

    /// Feed raw data through the SSE byte-level line state machine.
    private func process(data: Data) {
        for byte in data {
            switch lineState {
            case .normal:
                if byte == 0x0A {                           // \n
                    emitLine()
                } else if byte == 0x0D {                   // \r
                    emitLine()
                    lineState = .afterCR
                } else {
                    guard lineBytes.count < maxLineLength else {
                        onError?("Line buffer overflow: exceeds \(maxLineLength) bytes", -1, "PARSE_ERROR", false)
                        lineBytes = Data()
                        continue
                    }
                    lineBytes.append(byte)
                }

            case .afterCR:
                if byte == 0x0A {
                    // \r\n: line was already emitted on \r; skip this \n.
                } else if byte == 0x0D {
                    // Second consecutive \r → emit empty line, stay in afterCR.
                    emitLine()
                } else {
                    lineBytes.append(byte)
                }
                lineState = (byte == 0x0D) ? .afterCR : .normal
            }
        }
    }

    private func emitLine() {
        let line: String
        if lineBytes.isEmpty {
            line = ""
        } else if let s = String(data: lineBytes, encoding: .utf8) {
            line = s
        } else {
            onError?("Invalid UTF-8 sequence in stream", -1, "PARSE_ERROR", false)
            lineBytes = Data()
            lineState = .normal
            return
        }
        lineBytes = Data()
        parse(line: line)
    }

    private func parse(line: String) {
        if line.isEmpty { dispatch(); return }
        if line.hasPrefix(":") { return }

        let field: String
        let value: String

        if let colonIdx = line.firstIndex(of: ":") {
            field = String(line[line.startIndex ..< colonIdx])
            let afterColon = line[line.index(after: colonIdx)...]
            value = afterColon.hasPrefix(" ") ? String(afterColon.dropFirst()) : String(afterColon)
        } else {
            field = line; value = ""
        }

        switch field {
        case "event": eventType = value
        case "data":  dataLines.append(value)
        case "id":
            if !value.contains("\0") { lastEventId = value }
        case "retry":
            if !value.isEmpty, value.unicodeScalars.allSatisfy({ CharacterSet.decimalDigits.contains($0) }),
               let ms = Int(value) {
                onEvent?("__retry__", String(ms), lastEventId, 0, ms)
            }
        default: break
        }
    }

    private func dispatch() {
        guard !dataLines.isEmpty else { eventType = ""; return }

        let data   = dataLines.joined(separator: "\n")
        let type   = eventType.isEmpty ? "message" : eventType
        let id     = lastEventId
        let bytes  = data.utf8.count

        eventType = ""; dataLines = []

        onEvent?(type, data, id, bytes, -1)
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
            let code = "HTTP_ERROR"
            onError?("HTTP \(status)", status, code, true)
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
        process(data: data)
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
