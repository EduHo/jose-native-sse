/**
 * The native event listeners are shared across all NativeSSE instances (one set
 * for the process, routing by streamId). That module-level state has to be torn
 * down between tests, because the react-native mock clears its own listener map
 * in `__reset()` and would otherwise leave the library wired to dead listeners.
 */
import { __resetNativeWiring } from './src/EventSource';

beforeEach(() => {
  __resetNativeWiring();
});
