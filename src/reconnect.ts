/**
 * Reconnect policy helpers.
 *
 * computeDelay(policy, attempt) → delay in ms for the nth reconnect attempt.
 * attempt is 1-based (first reconnect = attempt 1).
 */

import type { ReconnectPolicy } from './types';

export function computeDelay(policy: ReconnectPolicy, attempt: number): number {
  if (policy.type === 'fixed') {
    return policy.intervalMs;
  }

  // Exponential: delay = min(initial × factor^(attempt-1), max)
  const factor = policy.factor ?? 2;
  const raw = Math.min(
    policy.initialMs * Math.pow(factor, attempt - 1),
    policy.maxMs,
  );

  if (policy.jitter ?? true) {
    // ±20 % uniform jitter. Avoids tight sync between many reconnecting clients.
    return Math.floor(raw * (0.8 + Math.random() * 0.4));
  }

  return Math.floor(raw);
}

/**
 * Build a ReconnectPolicy from SseConnectOptions, preserving V1 compatibility.
 * If the caller passed a raw `reconnectInterval` number (V1 API), wrap it in
 * a FixedReconnectPolicy. Explicit `reconnectPolicy` takes precedence.
 */
export function resolvePolicy(options: {
  reconnectPolicy?: ReconnectPolicy;
  reconnectInterval?: number;
}): ReconnectPolicy {
  if (options.reconnectPolicy) return options.reconnectPolicy;
  return { type: 'fixed', intervalMs: options.reconnectInterval ?? 3000 };
}
