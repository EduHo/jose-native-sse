/**
 * TurboModule spec for jose-native-sse.
 *
 * This file is the codegen source. The RN codegen tool reads it and generates
 * the corresponding C++ / ObjC++ / Kotlin boilerplate during the build step.
 *
 * Naming convention: the file must be named `Native<ModuleName>.ts` and the
 * module name passed to TurboModuleRegistry must equal the native module name.
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** Options forwarded verbatim from JS to native on each connect() call. */
export type ConnectOptions = {
  /** HTTP method, e.g. "GET" or "POST". */
  method: string;
  /** Key/value request headers including Accept and Last-Event-ID. */
  headers: { [key: string]: string };
  /** Request body string (empty string = no body). */
  body: string;
  /** Last received event ID used to populate Last-Event-ID header. */
  lastEventId: string;
  /** Timeout in milliseconds. 0 = no timeout. */
  timeout: number;
  /** Maximum byte length of a single SSE line. Default: 1 048 576 (1 MB). */
  maxLineLength: number;
};

export interface Spec extends TurboModule {
  /**
   * Open an SSE stream identified by `streamId`.
   * Events are emitted through the NativeEventEmitter:
   *   sse_open    – connection established
   *   sse_message – parsed SSE event
   *   sse_error   – transport or protocol error
   *   sse_close   – server closed the stream
   */
  connect(streamId: string, url: string, options: ConnectOptions): void;

  /** Close the stream identified by `streamId`. */
  disconnect(streamId: string): void;

  /** Close all open streams (called on app background / unmount). */
  disconnectAll(): void;

  // Required by RCTEventEmitter subscription tracking.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>('NativeNativeSse');
