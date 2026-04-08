#import "NativeSse.h"

// Swift bridge header. The module name equals the pod name with hyphens
// replaced by underscores: jose-native-sse → jose_native_sse.
#if __has_include("jose_native_sse-Swift.h")
  #import "jose_native_sse-Swift.h"
#else
  // Fallback for build systems that use a different header name.
  #import <jose_native_sse/jose_native_sse-Swift.h>
#endif

#ifdef RCT_NEW_ARCH_ENABLED
using namespace facebook::react;
#endif

// ─── NativeSse ────────────────────────────────────────────────────────────────

@implementation NativeSse {
  /// streamId → active SseConnectionSwift. Protected by _queue.
  NSMutableDictionary<NSString *, SseConnectionSwift *> *_connections;
  dispatch_queue_t _queue;
}

// ─── Registration ────────────────────────────────────────────────────────────

RCT_EXPORT_MODULE(NativeNativeSse)

+ (BOOL)requiresMainQueueSetup { return NO; }

// ─── Init / dealloc ──────────────────────────────────────────────────────────

- (instancetype)init
{
  if (self = [super init]) {
    _connections = [NSMutableDictionary dictionary];
    _queue       = dispatch_queue_create("com.nativesse.module.v2", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)dealloc
{
  for (SseConnectionSwift *c in _connections.allValues) [c disconnect];
  [_connections removeAllObjects];
}

// ─── RCTEventEmitter ─────────────────────────────────────────────────────────

- (NSArray<NSString *> *)supportedEvents {
  return @[@"sse_open", @"sse_chunk", @"sse_error", @"sse_close"];
}
// ─── Exported methods ─────────────────────────────────────────────────────────

/// Shared implementation used by both Old and New Architecture entry points.
- (void)_connectImpl:(NSString *)streamId
                 url:(NSURL *)url
              method:(NSString *)method
             headers:(NSDictionary *)headers
                body:(NSString *)body
           timeoutMs:(double)timeoutMs
{
  dispatch_async(_queue, ^{
    // Cancel any previous connection with this ID.
    [self->_connections[streamId] disconnect];

    __weak NativeSse *weakSelf = self;

    SseConnectionSwift *conn = [[SseConnectionSwift alloc]
        initWithStreamId: streamId
                     url: url
                  method: method
                 headers: headers
                    body: (body.length > 0 ? body : nil)
               timeoutMs: timeoutMs];

    conn.onOpen = ^(NSInteger statusCode, NSDictionary<NSString *, NSString *> *respHeaders) {
      __strong NativeSse *s = weakSelf; if (!s) return;
      [s sendEventWithName:@"sse_open" body:@{
        @"streamId":   streamId,
        @"statusCode": @(statusCode),
        @"headers":    respHeaders,
      }];
    };

    conn.onChunk = ^(NSString *chunk, NSInteger byteLen) {
      __strong NativeSse *s = weakSelf; if (!s) return;
      [s sendEventWithName:@"sse_chunk" body:@{
        @"streamId":   streamId,
        @"chunk":      chunk,
        @"byteLength": @(byteLen),
      }];
    };

    conn.onError = ^(NSString *message, NSInteger statusCode, NSString *errorCode, BOOL isFatal) {
      __strong NativeSse *s = weakSelf; if (!s) return;
      [s sendError:streamId message:message statusCode:statusCode errorCode:errorCode isFatal:isFatal];
      if (isFatal) {
        dispatch_async(s->_queue, ^{ [s->_connections removeObjectForKey:streamId]; });
      }
    };

    conn.onClose = ^{
      __strong NativeSse *s = weakSelf; if (!s) return;
      [s sendEventWithName:@"sse_close" body:@{ @"streamId": streamId }];
      dispatch_async(s->_queue, ^{ [s->_connections removeObjectForKey:streamId]; });
    };

    self->_connections[streamId] = conn;
    [conn connect];
  });
}

#ifdef RCT_NEW_ARCH_ENABLED
- (void)connect:(NSString *)streamId
            url:(NSString *)urlStr
        options:(JS::NativeNativeSse::ConnectOptions &)options
{
  NSURL *url = [NSURL URLWithString:urlStr];
  if (!url) {
    [self sendError:streamId message:@"Invalid URL" statusCode:-1 errorCode:@"INVALID_URL" isFatal:YES];
    return;
  }
  NSString     *method    = options.method()        ?: @"GET";
  NSDictionary *headers   = (NSDictionary *)options.headers() ?: @{};
  NSString     *body      = options.body()          ?: @"";
  double        timeoutMs = options.timeout();
  [self _connectImpl:streamId url:url method:method headers:headers body:body timeoutMs:timeoutMs];
}
#else
RCT_EXPORT_METHOD(connect:(NSString *)streamId
                  url:(NSString *)urlStr
                  options:(NSDictionary *)options)
{
  NSURL *url = [NSURL URLWithString:urlStr];
  if (!url) {
    [self sendError:streamId message:@"Invalid URL" statusCode:-1 errorCode:@"INVALID_URL" isFatal:YES];
    return;
  }
  NSString     *method    = options[@"method"]        ?: @"GET";
  NSDictionary *headers   = options[@"headers"]       ?: @{};
  NSString     *body      = options[@"body"]          ?: @"";
  double        timeoutMs = [options[@"timeout"] doubleValue];
  [self _connectImpl:streamId url:url method:method headers:headers body:body timeoutMs:timeoutMs];
}
#endif

- (void)_disconnectImpl:(NSString *)streamId
{
  dispatch_async(_queue, ^{
    SseConnectionSwift *conn = self->_connections[streamId];
    if (conn) {
      // Nil callbacks first so in-flight URLSession callbacks don't fire
      // spurious sse_close / sse_error events to JS after we've cancelled.
      conn.onOpen  = nil;
      conn.onChunk = nil;
      conn.onError = nil;
      conn.onClose = nil;
      [conn disconnect];
      [self->_connections removeObjectForKey:streamId];
    }
  });
}

- (void)_disconnectAllImpl
{
  dispatch_async(_queue, ^{
    for (SseConnectionSwift *c in self->_connections.allValues) {
      c.onOpen  = nil;
      c.onChunk = nil;
      c.onError = nil;
      c.onClose = nil;
      [c disconnect];
    }
    [self->_connections removeAllObjects];
  });
}

#ifdef RCT_NEW_ARCH_ENABLED
- (void)disconnect:(NSString *)streamId { [self _disconnectImpl:streamId]; }
- (void)disconnectAll                  { [self _disconnectAllImpl]; }
#else
RCT_EXPORT_METHOD(disconnect:(NSString *)streamId) { [self _disconnectImpl:streamId]; }
RCT_EXPORT_METHOD(disconnectAll)                   { [self _disconnectAllImpl]; }
#endif

// Required by NativeNativeSseSpec (New Architecture) and RCTEventEmitter (Old
// Architecture). Must delegate to super so that RCTEventEmitter's internal
// _listenerCount is maintained — sendEventWithName:body: silently drops events
// when that counter is 0, which caused "Sending sse_X with no listeners" warnings.
- (void)addListener:(NSString *)eventName { [super addListener:eventName]; }
- (void)removeListeners:(double)count     { [super removeListeners:count]; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

- (void)sendError:(NSString *)streamId
          message:(NSString *)message
       statusCode:(NSInteger)statusCode
        errorCode:(NSString *)errorCode
          isFatal:(BOOL)isFatal
{
  NSMutableDictionary *body = [@{
    @"streamId":  streamId,
    @"message":   message,
    @"errorCode": errorCode,
    @"isFatal":   @(isFatal),
  } mutableCopy];
  if (statusCode >= 0) body[@"statusCode"] = @(statusCode);
  [self sendEventWithName:@"sse_error" body:body];
}

// ─── New Architecture TurboModule ─────────────────────────────────────────────

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<TurboModule>)getTurboModule:(const ObjCTurboModule::InitParams &)params
{
  return std::make_shared<NativeNativeSseSpecJSI>(params);
}
#endif

@end
