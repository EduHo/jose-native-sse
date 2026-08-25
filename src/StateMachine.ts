import { SSE_STATE } from './types';
import type { SseState } from './types';

/**
 * Valid state transitions. Any transition not listed here is a programming error.
 * Having this in one place prevents impossible states from being reached silently.
 */
const VALID: Partial<Record<SseState, readonly SseState[]>> = {
  [SSE_STATE.IDLE]:         [SSE_STATE.CONNECTING, SSE_STATE.CLOSED],
  // → CONNECTING from any live state: reconnect() is a user-initiated restart
  // that bypasses the backoff, so it can fire while connecting or open.
  [SSE_STATE.CONNECTING]:   [SSE_STATE.CONNECTING, SSE_STATE.OPEN, SSE_STATE.RECONNECTING, SSE_STATE.STALE, SSE_STATE.PAUSED, SSE_STATE.FAILED, SSE_STATE.CLOSED],
  [SSE_STATE.OPEN]:         [SSE_STATE.CONNECTING, SSE_STATE.RECONNECTING, SSE_STATE.STALE, SSE_STATE.PAUSED, SSE_STATE.FAILED, SSE_STATE.CLOSED],
  [SSE_STATE.STALE]:        [SSE_STATE.CONNECTING, SSE_STATE.RECONNECTING, SSE_STATE.CLOSED],
  // → RECONNECTING again: a second error can arrive while a retry is pending.
  [SSE_STATE.RECONNECTING]: [SSE_STATE.CONNECTING, SSE_STATE.RECONNECTING, SSE_STATE.PAUSED, SSE_STATE.FAILED, SSE_STATE.CLOSED],
  [SSE_STATE.PAUSED]:       [SSE_STATE.CONNECTING, SSE_STATE.CLOSED],
  // CLOSED is final. FAILED still accepts close(), which is resource release
  // rather than a lifecycle step — nothing restarts from it.
  [SSE_STATE.CLOSED]:       [],
  [SSE_STATE.FAILED]:       [SSE_STATE.CLOSED],
};

export class StateMachine {
  private _state: SseState;

  constructor(initial: SseState = SSE_STATE.IDLE) {
    this._state = initial;
  }

  get state(): SseState { return this._state; }

  /**
   * Transition to `next`.
   *
   * Under test an invalid transition throws, so a bug fails the suite instead of
   * printing a warning nobody reads. In development it warns; in production it
   * is a no-op check and the transition is applied regardless — a wedged state
   * machine is worse for a user than an unexpected one.
   */
  transition(next: SseState): void {
    const allowed = VALID[this._state];
    if (allowed && !allowed.includes(next)) {
      const message = `[StateMachine] Invalid transition: ${this._state} → ${next}`;
      if (isTestEnv()) throw new Error(message);
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(message);
    }
    this._state = next;
  }
}

function isTestEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' && process.env?.NODE_ENV === 'test'
    );
  } catch {
    return false;
  }
}

declare const __DEV__: boolean | undefined;
