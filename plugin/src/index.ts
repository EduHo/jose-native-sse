import {
  AndroidConfig,
  ConfigPlugin,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} from '@expo/config-plugins';

// ─── Plugin options ───────────────────────────────────────────────────────────

type NativeSsePluginOptions = {
  /**
   * Allow cleartext HTTP traffic (i.e. `http://` endpoints).
   *
   * On iOS adds `NSAppTransportSecurity.NSAllowsArbitraryLoads = true` to
   * Info.plist. On Android sets `android:usesCleartextTraffic="true"` on
   * the `<application>` element.
   *
   * **Only enable this if your SSE server uses plain HTTP.**
   * Default: false.
   */
  allowCleartext?: boolean;
};

// ─── iOS modifier ─────────────────────────────────────────────────────────────

const withIosNativeSse: ConfigPlugin<NativeSsePluginOptions> = (
  config,
  { allowCleartext = false } = {},
) =>
  withInfoPlist(config, (c) => {
    if (allowCleartext) {
      c.modResults.NSAppTransportSecurity = {
        ...(c.modResults.NSAppTransportSecurity as object | undefined),
        NSAllowsArbitraryLoads: true,
      };
    }
    return c;
  });

// ─── Android modifier ─────────────────────────────────────────────────────────

const withAndroidNativeSse: ConfigPlugin<NativeSsePluginOptions> = (
  config,
  { allowCleartext = false } = {},
) =>
  withAndroidManifest(config, (c) => {
    // Ensure INTERNET permission is present (required for any network access).
    AndroidConfig.Permissions.ensurePermissions(c.modResults, [
      'android.permission.INTERNET',
    ]);

    if (allowCleartext) {
      const app = AndroidConfig.Manifest.getMainApplication(c.modResults);
      if (app?.$) {
        app.$['android:usesCleartextTraffic'] = 'true';
      }
    }

    return c;
  });

// ─── Combined plugin ──────────────────────────────────────────────────────────

const withNativeSse: ConfigPlugin<NativeSsePluginOptions | void> = (
  config,
  options,
) => {
  const opts: NativeSsePluginOptions = options ?? {};
  config = withIosNativeSse(config, opts);
  config = withAndroidNativeSse(config, opts);
  return config;
};

export default createRunOncePlugin(withNativeSse, 'jose-native-sse');
