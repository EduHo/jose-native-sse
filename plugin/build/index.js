"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_plugins_1 = require("@expo/config-plugins");
// ─── iOS modifier ─────────────────────────────────────────────────────────────
const withIosNativeSse = (config, { allowCleartext = false } = {}) => (0, config_plugins_1.withInfoPlist)(config, (c) => {
    if (allowCleartext) {
        c.modResults.NSAppTransportSecurity = {
            ...c.modResults.NSAppTransportSecurity,
            NSAllowsArbitraryLoads: true,
        };
    }
    return c;
});
// ─── Android modifier ─────────────────────────────────────────────────────────
const withAndroidNativeSse = (config, { allowCleartext = false } = {}) => (0, config_plugins_1.withAndroidManifest)(config, (c) => {
    // Ensure INTERNET permission is present (required for any network access).
    config_plugins_1.AndroidConfig.Permissions.ensurePermissions(c.modResults, [
        'android.permission.INTERNET',
    ]);
    if (allowCleartext) {
        const app = config_plugins_1.AndroidConfig.Manifest.getMainApplication(c.modResults);
        if (app === null || app === void 0 ? void 0 : app.$) {
            app.$['android:usesCleartextTraffic'] = 'true';
        }
    }
    return c;
});
// ─── Combined plugin ──────────────────────────────────────────────────────────
const withNativeSse = (config, options) => {
    const opts = options !== null && options !== void 0 ? options : {};
    config = withIosNativeSse(config, opts);
    config = withAndroidNativeSse(config, opts);
    return config;
};
exports.default = (0, config_plugins_1.createRunOncePlugin)(withNativeSse, 'jose-native-sse');
