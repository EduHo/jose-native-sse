#import "SseConnection.h"

// ─── SSE line-state machine ───────────────────────────────────────────────────

typedef NS_ENUM(NSInteger, SSELineState) {
  SSELineStateNormal,   // reading ordinary characters
  SSELineStateAfterCR,  // just saw a bare \r, waiting to see if \n follows
};

// ─── SseConnection implementation ────────────────────────────────────────────

@implementation SseConnection {
  NSURL *_url;
  NSString *_method;
  NSDictionary<NSString *, NSString *> *_headers;
  NSString *_body;
  NSTimeInterval _timeout;

  SseOpenBlock  _onOpen;
  SseEventBlock _onEvent;
  SseErrorBlock _onError;
  SseCloseBlock _onClose;

  NSURLSession *_session;
  NSURLSessionDataTask *_task;
  dispatch_queue_t _callbackQueue;

  // Protects _cancelled and connection lifecycle.
  dispatch_semaphore_t _lock;
  BOOL _cancelled;
  BOOL _openFired;

  // ─── Line buffer ────────────────────────────────────────────────────────────
  // Accumulates bytes for the current (possibly incomplete) line.
  NSMutableData *_lineData;
  SSELineState _lineState;

  // ─── SSE parser state ───────────────────────────────────────────────────────
  NSString *_eventType;
  NSMutableArray<NSString *> *_dataLines;
  NSString *_lastEventId;
  NSNumber *_retry;
}

@synthesize streamId = _streamId;
NSString *_streamId;

// ─── Initialisation ───────────────────────────────────────────────────────────

- (instancetype)initWithStreamId:(NSString *)streamId
                             url:(NSURL *)url
                          method:(NSString *)method
                         headers:(NSDictionary<NSString *, NSString *> *)headers
                            body:(nullable NSString *)body
                         timeout:(NSTimeInterval)timeout
                          onOpen:(SseOpenBlock)onOpen
                         onEvent:(SseEventBlock)onEvent
                         onError:(SseErrorBlock)onError
                         onClose:(SseCloseBlock)onClose
{
  if (self = [super init]) {
    _streamId = [streamId copy];
    _url      = url;
    _method   = [method copy];
    _headers  = [headers copy];
    _body     = [body copy];
    _timeout  = timeout;

    _onOpen  = [onOpen copy];
    _onEvent = [onEvent copy];
    _onError = [onError copy];
    _onClose = [onClose copy];

    _lock          = dispatch_semaphore_create(1);
    _callbackQueue = dispatch_queue_create("com.nativesse.connection", DISPATCH_QUEUE_SERIAL);

    _lineData   = [NSMutableData data];
    _lineState  = SSELineStateNormal;
    _dataLines  = [NSMutableArray array];
    _eventType  = @"";
    _lastEventId = @"";
    _retry      = nil;
  }
  return self;
}

// ─── Connect / Disconnect ─────────────────────────────────────────────────────

- (void)connect
{
  dispatch_semaphore_wait(_lock, DISPATCH_TIME_FOREVER);
  _cancelled = NO;
  _openFired = NO;
  dispatch_semaphore_signal(_lock);

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:_url];
  request.HTTPMethod = _method;

  for (NSString *key in _headers) {
    [request setValue:_headers[key] forHTTPHeaderField:key];
  }

  if (_body.length > 0 && ![_method isEqualToString:@"GET"]) {
    request.HTTPBody = [_body dataUsingEncoding:NSUTF8StringEncoding];
  }

  if (_timeout > 0) {
    request.timeoutInterval = _timeout / 1000.0;
  }

  // Disable caching – essential for SSE.
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;

  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
  cfg.requestCachePolicy          = NSURLRequestReloadIgnoringLocalCacheData;
  // SSE streams are long-lived; URLSession must not time out on idle.
  cfg.timeoutIntervalForRequest   = (_timeout > 0) ? _timeout / 1000.0 : DBL_MAX;
  cfg.timeoutIntervalForResource  = DBL_MAX;

  // Delegate queue is nil → URLSession uses its own background thread.
  _session = [NSURLSession sessionWithConfiguration:cfg delegate:self delegateQueue:nil];
  _task    = [_session dataTaskWithRequest:request];
  [_task resume];
}

- (void)disconnect
{
  dispatch_semaphore_wait(_lock, DISPATCH_TIME_FOREVER);
  _cancelled = YES;
  dispatch_semaphore_signal(_lock);

  [_task cancel];
  [_session invalidateAndCancel];
  _task    = nil;
  _session = nil;
}

// ─── NSURLSessionDataDelegate ─────────────────────────────────────────────────

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler
{
  dispatch_semaphore_wait(_lock, DISPATCH_TIME_FOREVER);
  BOOL cancelled = _cancelled;
  dispatch_semaphore_signal(_lock);

  if (cancelled) {
    completionHandler(NSURLSessionResponseCancel);
    return;
  }

  if (![response isKindOfClass:[NSHTTPURLResponse class]]) {
    completionHandler(NSURLSessionResponseCancel);
    NSString *sid = _streamId;
    dispatch_async(_callbackQueue, ^{
      self->_onError(@"Non-HTTP response", nil, YES);
    });
    (void)sid;
    return;
  }

  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  NSInteger statusCode = http.statusCode;

  if (statusCode < 200 || statusCode >= 300) {
    completionHandler(NSURLSessionResponseCancel);
    NSNumber *code = @(statusCode);
    NSString *msg  = [NSString stringWithFormat:@"HTTP error %ld", (long)statusCode];
    dispatch_async(_callbackQueue, ^{
      self->_onError(msg, code, YES);
    });
    return;
  }

  // Collect response headers.
  NSMutableDictionary<NSString *, NSString *> *respHeaders = [NSMutableDictionary dictionary];
  [http.allHeaderFields enumerateKeysAndObjectsUsingBlock:^(id key, id val, BOOL *__unused stop) {
    respHeaders[[key description]] = [val description];
  }];

  _openFired = YES;
  NSDictionary<NSString *, NSString *> *frozen = [respHeaders copy];
  dispatch_async(_callbackQueue, ^{
    self->_onOpen(statusCode, frozen);
  });

  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data
{
  dispatch_semaphore_wait(_lock, DISPATCH_TIME_FOREVER);
  BOOL cancelled = _cancelled;
  dispatch_semaphore_signal(_lock);
  if (cancelled) return;

  [self processBytes:(const uint8_t *)data.bytes length:data.length];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(nullable NSError *)error
{
  dispatch_semaphore_wait(_lock, DISPATCH_TIME_FOREVER);
  BOOL cancelled = _cancelled;
  dispatch_semaphore_signal(_lock);
  if (cancelled) return;

  if (error) {
    if (error.code == NSURLErrorCancelled) return;
    NSString *msg  = error.localizedDescription;
    NSNumber *code = @(error.code);
    dispatch_async(_callbackQueue, ^{
      self->_onError(msg, code, NO);
    });
  } else {
    dispatch_async(_callbackQueue, ^{
      self->_onClose();
    });
  }
}

// ─── Byte-stream SSE line parser ──────────────────────────────────────────────

/**
 * Process raw incoming bytes through the SSE line-state machine.
 *
 * SSE specifies that lines are terminated by:
 *   U+000A LF
 *   U+000D CR
 *   U+000D CR followed by U+000A LF  (treated as a single terminator)
 *
 * We handle the CR→LF boundary-across-chunks case with _lineState.
 */
- (void)processBytes:(const uint8_t *)bytes length:(NSUInteger)length
{
  for (NSUInteger i = 0; i < length; i++) {
    uint8_t c = bytes[i];

    switch (_lineState) {
      case SSELineStateNormal:
        if (c == '\n') {
          [self emitLine];
        } else if (c == '\r') {
          [self emitLine];
          _lineState = SSELineStateAfterCR;
        } else {
          [_lineData appendBytes:&c length:1];
        }
        break;

      case SSELineStateAfterCR:
        if (c == '\n') {
          // \r\n: the line was already emitted on \r; skip this \n.
        } else if (c == '\r') {
          // Another bare \r immediately after: emit an empty line and stay.
          [self emitLine];
          // Stay in SSELineStateAfterCR.
        } else {
          // Not a \n after \r → start new line with this character.
          [_lineData appendBytes:&c length:1];
        }
        _lineState = (c == '\r') ? SSELineStateAfterCR : SSELineStateNormal;
        break;
    }
  }
}

/** Called with the complete bytes for one SSE line (without the terminator). */
- (void)emitLine
{
  NSString *line = [[NSString alloc] initWithData:_lineData encoding:NSUTF8StringEncoding];
  if (!line) {
    // Gracefully handle invalid UTF-8: treat as empty line.
    line = @"";
  }
  [_lineData setLength:0];
  [self parseLine:line];
}

// ─── SSE field parser ─────────────────────────────────────────────────────────

- (void)parseLine:(NSString *)line
{
  if (line.length == 0) {
    [self dispatchCurrentEvent];
    return;
  }

  if ([line hasPrefix:@":"]) {
    return; // Comment – ignored.
  }

  NSString *field;
  NSString *value;
  NSRange colonRange = [line rangeOfString:@":"];

  if (colonRange.location == NSNotFound) {
    field = line;
    value = @"";
  } else {
    field = [line substringToIndex:colonRange.location];
    NSString *raw = [line substringFromIndex:colonRange.location + 1];
    // Strip a single leading space per spec.
    value = [raw hasPrefix:@" "] ? [raw substringFromIndex:1] : raw;
  }

  if ([field isEqualToString:@"event"]) {
    _eventType = value;
  } else if ([field isEqualToString:@"data"]) {
    [_dataLines addObject:value];
  } else if ([field isEqualToString:@"id"]) {
    // Per spec: ignore if value contains U+0000 NULL.
    if ([value rangeOfString:@"\0"].location == NSNotFound) {
      _lastEventId = value;
    }
  } else if ([field isEqualToString:@"retry"]) {
    // Must be all ASCII digits.
    NSCharacterSet *nonDigit = [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
    if ([value rangeOfCharacterFromSet:nonDigit].location == NSNotFound && value.length > 0) {
      NSInteger ms = [value integerValue];
      _retry = @(ms);
      NSNumber *retryNum = _retry;
      dispatch_async(_callbackQueue, ^{
        self->_onEvent(@"__retry__", @"", @"", retryNum);
      });
    }
  }
  // Unknown fields are silently ignored.
}

- (void)dispatchCurrentEvent
{
  if (_dataLines.count == 0) {
    // Empty data buffer → reset event fields and do not dispatch.
    _eventType = @"";
    return;
  }

  NSString *data        = [_dataLines componentsJoinedByString:@"\n"];
  NSString *type        = (_eventType.length > 0) ? _eventType : @"message";
  NSString *lastEventId = [_lastEventId copy];
  NSNumber *retry       = _retry;

  // Reset event-scoped fields (lastEventId persists globally per spec).
  _eventType = @"";
  _dataLines = [NSMutableArray array];
  _retry     = nil;

  dispatch_async(_callbackQueue, ^{
    self->_onEvent(type, data, lastEventId, retry);
  });
}

@end
