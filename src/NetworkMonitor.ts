import type { NetworkObserver } from './types';

/**
 * Encapsulates network-awareness subscription (manual observer or auto netinfo).
 * Decoupled from EventSource so the connectivity logic can be tested in isolation.
 */
export class NetworkMonitor {
  private _unsub: (() => void) | null = null;

  constructor(
    private readonly onStateChange: (isConnected: boolean) => void,
  ) {}

  /**
   * Start observing connectivity changes.
   *
   * @param observer  Manual `NetworkObserver` (takes precedence).
   * @param autoNetInfo  When true, attempt to integrate with
   *                     `@react-native-community/netinfo` automatically.
   */
  start(observer?: NetworkObserver, autoNetInfo = false): void {
    if (this._unsub) return;

    if (observer) {
      this._unsub = observer.subscribe(this.onStateChange);
      return;
    }

    if (autoNetInfo) {
      try {
        const mod = require('@react-native-community/netinfo');
        const NetInfo = mod.default ?? mod;
        this._unsub = NetInfo.addEventListener(
          (state: { isConnected: boolean | null }) => {
            this.onStateChange(state.isConnected ?? true);
          },
        );
      } catch {
        // netinfo not installed — silently skip.
      }
    }
  }

  stop(): void {
    this._unsub?.();
    this._unsub = null;
  }
}
