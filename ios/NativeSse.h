#pragma once

#import <React/RCTEventEmitter.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <RNNativeSseSpec/RNNativeSseSpec.h>

NS_ASSUME_NONNULL_BEGIN
@interface NativeSse : RCTEventEmitter <NativeNativeSseSpec>
@end
NS_ASSUME_NONNULL_END

#else

NS_ASSUME_NONNULL_BEGIN
@interface NativeSse : RCTEventEmitter
@end
NS_ASSUME_NONNULL_END

#endif
