package com.nativesse

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

/**
 * Package for jose-native-sse.
 *
 * The module is discovered automatically through autolinking and Codegen, so
 * apps do not need to register this package in `MainApplication`.
 *
 * Extends [BaseReactPackage] — the TurboModule-aware base class. The older
 * `ReactPackage.createNativeModules` entry point is deprecated because it
 * cannot express lazy module loading.
 */
class NativeSsePackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? =
    if (name == NativeSseModule.NAME) NativeSseModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider {
      mapOf(
        NativeSseModule.NAME to
          ReactModuleInfo(
            NativeSseModule.NAME,
            NativeSseModule::class.java.name,
            /* canOverrideExistingModule = */ false,
            /* needsEagerInit = */ false,
            /* isCxxModule = */ false,
            /* isTurboModule = */ true,
          ),
      )
    }

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<in Nothing, in Nothing>> = emptyList()
}
