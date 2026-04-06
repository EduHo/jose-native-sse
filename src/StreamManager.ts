/**
 * SseStreamManager — centralised lifecycle management for multiple SSE streams.
 *
 * Useful in apps that maintain several concurrent streams (e.g. chat, presence,
 * notifications). The manager acts as a registry and provides aggregate
 * operations (pause all on background, close all on logout, etc.).
 *
 * @example
 * ```ts
 * const manager = new SseStreamManager();
 *
 * const chat = manager.create('chat', 'https://api.example.com/chat/events', {
 *   headers: { Authorization: 'Bearer token' },
 * });
 * const presence = manager.create('presence', 'https://api.example.com/presence', {
 *   reconnectPolicy: { type: 'exponential', initialMs: 1000, maxMs: 30000 },
 * });
 *
 * chat.onmessage = (e) => handleChatMessage(e.data);
 * presence.onmessage = (e) => handlePresence(e.data);
 *
 * // On logout:
 * manager.closeAll();
 * ```
 */

import { NativeModules } from 'react-native';
import { NativeSSE } from './EventSource';
import type { SseConnectOptions, StreamMetrics } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NativeNativeSse = (global as any).__turboModuleProxy != null
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ? require('./NativeNativeSse').default
  : NativeModules.NativeNativeSse;

export class SseStreamManager {
  private readonly _streams = new Map<string, NativeSSE>();

  /**
   * Create (or replace) a named stream.
   * If a stream with `id` already exists it is closed before the new one is created.
   */
  create(id: string, url: string, options?: SseConnectOptions): NativeSSE {
    this._streams.get(id)?.close();
    const stream = new NativeSSE(url, options);
    this._streams.set(id, stream);
    return stream;
  }

  /** Get an existing stream by id, or undefined if not registered. */
  get(id: string): NativeSSE | undefined {
    return this._streams.get(id);
  }

  /** Check whether a stream with the given id is registered. */
  has(id: string): boolean {
    return this._streams.has(id);
  }

  /**
   * Close a stream and remove it from the registry.
   * Returns true if the stream existed.
   */
  remove(id: string): boolean {
    const stream = this._streams.get(id);
    if (!stream) return false;
    stream.close();
    this._streams.delete(id);
    return true;
  }

  /** Number of currently registered streams. */
  get size(): number {
    return this._streams.size;
  }

  /** All registered stream IDs. */
  get ids(): string[] {
    return [...this._streams.keys()];
  }

  // ── Aggregate operations ──────────────────────────────────────────────────

  /** Pause all streams (e.g. when the app goes to background). */
  pauseAll(): void {
    for (const s of this._streams.values()) s.pause();
  }

  /** Resume all paused streams (e.g. when the app returns to foreground). */
  resumeAll(): void {
    for (const s of this._streams.values()) s.resume();
  }

  /** Permanently close all streams and clear the registry. */
  closeAll(): void {
    for (const s of this._streams.values()) s.close();
    this._streams.clear();
    // Belt-and-suspenders: also tell native to clean up.
    NativeNativeSse?.disconnectAll?.();
  }

  // ── Observability ─────────────────────────────────────────────────────────

  /** Returns a snapshot of metrics for every registered stream. */
  getAllMetrics(): Map<string, StreamMetrics> {
    const result = new Map<string, StreamMetrics>();
    for (const [id, stream] of this._streams) {
      result.set(id, stream.getMetrics());
    }
    return result;
  }

  /**
   * Aggregate metrics across all streams.
   * Useful for dashboard-level observability (total events received, etc.).
   */
  getAggregateMetrics(): {
    totalBytesReceived: number;
    totalEventsReceived: number;
    totalReconnects: number;
    streamCount: number;
  } {
    let bytes = 0, events = 0, reconnects = 0;
    for (const s of this._streams.values()) {
      const m = s.getMetrics();
      bytes      += m.bytesReceived;
      events     += m.eventsReceived;
      reconnects += m.reconnectCount;
    }
    return {
      totalBytesReceived:  bytes,
      totalEventsReceived: events,
      totalReconnects:     reconnects,
      streamCount:         this._streams.size,
    };
  }
}
