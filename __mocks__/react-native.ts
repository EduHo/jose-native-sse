/**
 * react-native mock for Jest (V2).
 *
 * Exports test helpers:
 *   __emit(event, data)       – simulate a native event
 *   __reset()                 – clear all state between tests
 *   __setAppState(state)      – simulate app going background/foreground
 */

type Listener = (data: unknown) => void;
type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

const _listeners = new Map<string, Listener[]>();
let _appStateHandlers: Array<(state: AppStateStatus) => void> = [];

// ─── NativeEventEmitter ───────────────────────────────────────────────────────

export const NativeEventEmitter = jest.fn().mockImplementation(() => ({
  addListener: jest.fn().mockImplementation((event: string, listener: Listener) => {
    if (!_listeners.has(event)) _listeners.set(event, []);
    _listeners.get(event)!.push(listener);
    return {
      remove: jest.fn().mockImplementation(() => {
        const arr = _listeners.get(event);
        if (!arr) return;
        const idx = arr.indexOf(listener);
        if (idx !== -1) arr.splice(idx, 1);
      }),
    };
  }),
  removeAllListeners: jest.fn().mockImplementation((event: string) => {
    _listeners.delete(event);
  }),
}));

// ─── NativeModules ────────────────────────────────────────────────────────────

export const NativeModules = {
  NativeNativeSse: {
    connect: jest.fn(),
    disconnect: jest.fn(),
    disconnectAll: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
};

// ─── Platform ────────────────────────────────────────────────────────────────

export const Platform = {
  OS: 'ios' as const,
  select: (obj: { ios?: unknown; android?: unknown; default?: unknown }) =>
    obj.ios ?? obj.default,
};

// ─── AppState ────────────────────────────────────────────────────────────────

export const AppState = {
  currentState: 'active' as AppStateStatus,
  addEventListener: jest.fn().mockImplementation(
    (_event: string, handler: (state: AppStateStatus) => void) => {
      _appStateHandlers.push(handler);
      return {
        remove: jest.fn().mockImplementation(() => {
          _appStateHandlers = _appStateHandlers.filter((h) => h !== handler);
        }),
      };
    },
  ),
};

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Simulate a native event being sent to JS. */
export function __emit(event: string, data: unknown): void {
  const listeners = _listeners.get(event);
  if (!listeners) return;
  for (const l of [...listeners]) l(data);
}

/** Simulate a change in the app foreground/background state. */
export function __setAppState(state: AppStateStatus): void {
  AppState.currentState = state;
  for (const h of [..._appStateHandlers]) h(state);
}

/** Reset all listener/mock state between tests. */
export function __reset(): void {
  _listeners.clear();
  _appStateHandlers = [];
  AppState.currentState = 'active';
  jest.clearAllMocks();
  // Re-wire addListener so future NativeEventEmitter instances work.
  (NativeEventEmitter as jest.Mock).mockImplementation(() => ({
    addListener: jest.fn().mockImplementation((event: string, listener: Listener) => {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event)!.push(listener);
      return {
        remove: jest.fn().mockImplementation(() => {
          const arr = _listeners.get(event);
          if (!arr) return;
          const idx = arr.indexOf(listener);
          if (idx !== -1) arr.splice(idx, 1);
        }),
      };
    }),
    removeAllListeners: jest.fn().mockImplementation((event: string) => {
      _listeners.delete(event);
    }),
  }));
  (AppState.addEventListener as jest.Mock).mockImplementation(
    (_event: string, handler: (state: AppStateStatus) => void) => {
      _appStateHandlers.push(handler);
      return {
        remove: jest.fn().mockImplementation(() => {
          _appStateHandlers = _appStateHandlers.filter((h) => h !== handler);
        }),
      };
    },
  );
}
