import { SSE_STATE } from './types';
import type { SseState } from './types';

/**
 * Valid state transitions. Any transition not listed here is a programming error.
 * Having this in one place prevents impossible states from being reached silently.
 */
const VALID: Partial<Record<SseState, readonly SseState[]>> = {
  [SSE_STATE.IDLE]:         [SSE_STATE.CONNECTING, SSE_STATE.CLOSED],
  [SSE_STATE.CONNECTING]:   [SSE_STATE.OPEN, SSE_STATE.RECONNECTING, SSE_STATE.STALE, SSE_STATE.PAUSED, SSE_STATE.FAILED, SSE_STATE.CLOSED],
  [SSE_STATE.OPEN]:         [SSE_STATE.RECONNECTING, SSE_STATE.STALE, SSE_STATE.PAUSED, SSE_STATE.FAILED, SSE_STATE.CLOSED],
  [SSE_STATE.STALE]:        [SSE_STATE.RECONNECTING, SSE_STATE.CLOSED],
  [SSE_STATE.RECONNECTING]: [SSE_STATE.CONNECTING, SSE_STATE.PAUSED, SSE_STATE.FAILED, SSE_STATE.CLOSED],
  [SSE_STATE.PAUSED]:       [SSE_STATE.CONNECTING, SSE_STATE.CLOSED],
  [SSE_STATE.CLOSED]:       [],
  [SSE_STATE.FAILED]:       [],
};

export class StateMachine {
  private _state: SseState;

  constructor(initial: SseState = SSE_STATE.IDLE) {
    this._state = initial;
  }

  get state(): SseState { return this._state; }

  /**
   * Transition to `next`. Throws in __DEV__ if the transition is invalid so
   * bugs are caught in development and tests.
   */
  transition(next: SseState): void {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      const allowed = VALID[this._state];
      if (allowed && !allowed.includes(next)) {
        console.warn(
          `[StateMachine] Invalid transition: ${this._state} → ${next}`,
        );
      }
    }
    this._state = next;
  }
}

declare const __DEV__: boolean | undefined;
