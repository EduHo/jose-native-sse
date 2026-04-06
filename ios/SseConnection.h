#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// ─── Callback block typedefs ─────────────────────────────────────────────────

typedef void (^SseOpenBlock)(NSInteger statusCode,
                             NSDictionary<NSString *, NSString *> *headers);

typedef void (^SseEventBlock)(NSString *eventType,
                              NSString *data,
                              NSString *lastEventId,
                              NSNumber *_Nullable retry);

typedef void (^SseErrorBlock)(NSString *message,
                              NSNumber *_Nullable statusCode,
                              BOOL isFatal);

typedef void (^SseCloseBlock)(void);

// ─── SseConnection ────────────────────────────────────────────────────────────

/**
 * Manages a single SSE stream using URLSession streaming data tasks.
 *
 * • SSE parsing (including multi-line data, retry, id fields) is done natively.
 * • Calls back on a private serial queue; callers must not assume the main queue.
 * • Thread-safe: connect/disconnect may be called from any queue.
 */
@interface SseConnection : NSObject <NSURLSessionDataDelegate>

@property (nonatomic, readonly, copy) NSString *streamId;

- (instancetype)initWithStreamId:(NSString *)streamId
                             url:(NSURL *)url
                          method:(NSString *)method
                         headers:(NSDictionary<NSString *, NSString *> *)headers
                            body:(nullable NSString *)body
                         timeout:(NSTimeInterval)timeout
                          onOpen:(SseOpenBlock)onOpen
                         onEvent:(SseEventBlock)onEvent
                         onError:(SseErrorBlock)onError
                         onClose:(SseCloseBlock)onClose NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/** Start the HTTP request and begin streaming. */
- (void)connect;

/** Cancel the stream. Safe to call multiple times. */
- (void)disconnect;

@end

NS_ASSUME_NONNULL_END
