import { ConfigPlugin } from '@expo/config-plugins';
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
declare const _default: ConfigPlugin<void | NativeSsePluginOptions>;
export default _default;
//# sourceMappingURL=index.d.ts.map