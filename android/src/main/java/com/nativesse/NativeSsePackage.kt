package com.nativesse

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Package for jose-native-sse.
 *
 * Register in your MainApplication:
 *
 * ```kotlin
 * // MainApplication.kt
 * override fun getPackages(): List<ReactPackage> =
 *   PackageList(this).packages + listOf(NativeSsePackage())
 * ```
 *
 * For New Architecture (TurboModules), the module is auto-discovered via
 * codegen and this package is used only for the legacy bridge path.
 */
class NativeSsePackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(NativeSseModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
