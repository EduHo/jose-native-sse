import type { ConfigPlugin } from '@expo/config-plugins';
type NativeSsePluginOptions = {
    /**
     * Hostnames allowed to serve plain `http://`, e.g.
     * `["sse.internal.example.com"]`.
     *
     * Scoped per domain: iOS gets an `NSExceptionDomains` entry and Android a
     * `network_security_config.xml` `domain-config`. Everything else keeps its
     * HTTPS requirement.
     *
     * **Prefer this over `allowCleartext`.**
     */
    cleartextDomains?: string[];
    /**
     * Allow cleartext HTTP to **every** host in the app.
     *
     * On iOS this sets `NSAllowsArbitraryLoads`, which disables App Transport
     * Security app-wide and needs a written justification during App Store
     * review; on Android it sets `android:usesCleartextTraffic="true"` on the
     * whole application.
     *
     * Use `cleartextDomains` unless you genuinely need this. Default: false.
     */
    allowCleartext?: boolean;
};
declare const _default: ConfigPlugin<void | NativeSsePluginOptions>;
export default _default;
//# sourceMappingURL=index.d.ts.map