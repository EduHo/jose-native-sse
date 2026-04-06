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
  NSInteger _listenerCount;
}

// ─── Registration ────────────────────────────────────────────────────────────

RCT_EXPORT_MODULE(NativeNativeSse)

+ (BOOL)requiresMainQueueSetup { return NO; }

// ─── Init / dealloc ──────────────────────────────────────────────────────────

- (instancetype)init
{
  if (self = [super init]) {
    _connections   = [NSMutableDictionary dictionary];
    _queue         = dispatch_queue_create("com.nativesse.module.v2", DISPATCH_QUEUE_SERIAL);
    _listenerCount = 0;
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
  return @[@"sse_open", @"sse_message", @"sse_error", @"sse_close"];
}
- (void)startObserving  { _listenerCount++; }
- (void)stopObserving   { _listenerCount--; }

// ─── Exported methods ─────────────────────────────────────────────────────────

RCT_EXPORT_METHOD(connect:(NSString *)streamId
                  url:(NSString *)urlStr
                  options:(NSDictionary *)options)
{
  NSURL *url = [NSURL URLWithString:urlStr];
  if (!url) {
    [self sendError:streamId message:@"Invalid URL" statusCode:-1 errorCode:@"INVALID_URL" isFatal:YES];
    return;
  }

  NSString    *method    = options[@"method"]        ?: @"GET";
  NSDictionary *headers  = options[@"headers"]       ?: @{};
  NSString    *body      = options[@"body"]          ?: @"";
  double       timeoutMs = [options[@"timeout"] doubleValue];
  NSInteger    maxLine   = options[@"maxLineLength"] ? [options[@"maxLineLength"] integerValue] : 1048576;

  dispatch_async(_queue, ^{
    // Cancel any previous connection with this ID.
    [self->_connections[streamId] disconnect];

    __weak typeof(self) weak = self;

    SseConnectionSwift *conn = [[SseConnectionSwift alloc]
        initWithStreamId: streamId
                     url: url
                  method: method
                 headers: headers
                    body: (body.length > 0 ? body : nil)
               timeoutMs: timeoutMs
           maxLineLength: (NSInteger)maxLine];

    conn.onOpen = ^(NSInteger statusCode, NSDictionary<NSString *, NSString *> *respHeaders) {
      __strong typeof(weak) s = weak; if (!s) return;
      [s sendEventWithName:@"sse_open" body:@{
        @"streamId":   streamId,
        @"statusCode": @(statusCode),
        @"headers":    respHeaders,
      }];
    };

    conn.onEvent = ^(NSString *type, NSString *data, NSString *lastId, NSInteger byteLen, NSInteger retryMs) {
      __strong typeof(weak) s = weak; if (!s) return;
      // __retry__ is a protocol-internal signal; don't forward as a user event.
      if ([type isEqualToString:@"__retry__"]) {
        // Forward just the retry hint so JS can update its reconnect interval.
        [s sendEventWithName:@"sse_message" body:@{
          @"streamId":   streamId,
          @"eventType":  @"__retry__",
          @"data":       data,
          @"id":         lastId ?: @"",
          @"byteLength": @(0),
          @"retry":      @(retryMs),
        }];
        return;
      }
      NSMutableDictionary *body = [@{
        @"streamId":   streamId,
        @"eventType":  type,
        @"data":       data,
        @"id":         lastId ?: @"",
        @"byteLength": @(byteLen),
      } mutableCopy];
      if (retryMs >= 0) body[@"retry"] = @(retryMs);
      [s sendEventWithName:@"sse_message" body:body];
    };

    conn.onError = ^(NSString *message, NSInteger statusCode, NSString *errorCode, BOOL isFatal) {
      __strong typeof(weak) s = weak; if (!s) return;
      [s sendError:streamId message:message statusCode:statusCode errorCode:errorCode isFatal:isFatal];
      if (isFatal) {
        dispatch_async(s->_queue, ^{ [s->_connections removeObjectForKey:streamId]; });
      }
    };

    conn.onClose = ^{
      __strong typeof(weak) s = weak; if (!s) return;
      [s sendEventWithName:@"sse_close" body:@{ @"streamId": streamId }];
      dispatch_async(s->_queue, ^{ [s->_connections removeObjectForKey:streamId]; });
    };

    self->_connections[streamId] = conn;
    [conn connect];
  });
}

RCT_EXPORT_METHOD(disconnect:(NSString *)streamId)
{
  dispatch_async(_queue, ^{
    [self->_connections[streamId] disconnect];
    [self->_connections removeObjectForKey:streamId];
  });
}

RCT_EXPORT_METHOD(disconnectAll)
{
  dispatch_async(_queue, ^{
    for (SseConnectionSwift *c in self->_connections.allValues) [c disconnect];
    [self->_connections removeAllObjects];
  });
}

// Subscription bookkeeping — no-op because startObserving/stopObserving handle it.
RCT_EXPORT_METHOD(addListener:(NSString *)eventName)  {}
RCT_EXPORT_METHOD(removeListeners:(double)count)       {}

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
