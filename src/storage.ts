import type { StorageAdapter } from './types';

// ─── InMemoryStorageAdapter ───────────────────────────────────────────────────

/**
 * Default in-memory storage adapter. Last-Event-ID is kept in memory only
 * and is lost when the process restarts.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private _store: Record<string, string> = {};

  async getItem(key: string): Promise<string | null> {
    return this._store[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this._store[key] = value;
  }

  async removeItem(key: string): Promise<void> {
    delete this._store[key];
  }
}

// ─── AsyncStorageAdapter ──────────────────────────────────────────────────────

/**
 * Persistent storage adapter backed by
 * `@react-native-async-storage/async-storage`.
 *
 * The module is loaded lazily — the constructor does not throw if the package
 * is not installed; the error surfaces only on the first read/write.
 *
 * @example
 * ```ts
 * import { NativeSSE, AsyncStorageAdapter } from 'jose-native-sse';
 *
 * const sse = new NativeSSE(url, {
 *   persistLastEventId: true,
 *   storageAdapter: new AsyncStorageAdapter(),
 * });
 * ```
 */
export class AsyncStorageAdapter implements StorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _mod: any | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _get(): any {
    if (!this._mod) {
      try {
        const mod = require('@react-native-async-storage/async-storage');
        this._mod = mod.default ?? mod;
      } catch {
        throw new Error(
          '[NativeSSE] AsyncStorageAdapter requires ' +
            '@react-native-async-storage/async-storage. ' +
            'Install it or use InMemoryStorageAdapter instead.',
        );
      }
    }
    return this._mod;
  }

  async getItem(key: string): Promise<string | null> {
    return this._get().getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    return this._get().setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return this._get().removeItem(key);
  }
}
