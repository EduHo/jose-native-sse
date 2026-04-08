import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';

/**
 * Encapsulates React Native AppState subscription so EventSource stays focused
 * on connection logic rather than lifecycle boilerplate.
 */
export class AppLifecycleManager {
  private _sub: { remove(): void } | null = null;

  constructor(
    private readonly onBackground: () => void,
    private readonly onForeground: () => void,
  ) {}

  start(): void {
    if (this._sub) return;
    this._sub = AppState.addEventListener('change', this._handle);
  }

  stop(): void {
    this._sub?.remove();
    this._sub = null;
  }

  private _handle = (nextState: AppStateStatus): void => {
    if (nextState === 'background' || nextState === 'inactive') {
      this.onBackground();
    } else if (nextState === 'active') {
      this.onForeground();
    }
  };
}
