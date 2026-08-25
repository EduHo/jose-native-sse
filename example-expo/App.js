import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { NativeSSE, SseStreamManager, SSE_STATE } from 'jose-native-sse';

const DEFAULT_URL = 'https://sse.dev/test';

// The hardening scenarios need a server that misbehaves on purpose:
//   npm run stress:server        (from the repository root)
// The Android emulator reaches the host machine through 10.0.2.2.
const STRESS_HOST = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
const stressUrl = (path) => `http://${STRESS_HOST}:3000${path}`;

const PRESETS = [
  { label: 'retry: 0',      path: '/retry-zero', hint: 'server demands no backoff' },
  { label: 'retry: 9…9',    path: '/retry-huge', hint: 'overflows to Infinity' },
  { label: 'split UTF-8',   path: '/utf8-split', hint: 'cuts mid-character' },
  { label: 'well-behaved',  path: '/events',     hint: 'baseline' },
];

// Floor and ceiling applied to any delay the server asks for. Deliberately
// visible here so the numbers in the panel can be checked against them.
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10000;

const STATE_COLOR = {
  [SSE_STATE.IDLE]:         '#8E8E93',
  [SSE_STATE.CONNECTING]:   '#FF9500',
  [SSE_STATE.OPEN]:         '#34C759',
  [SSE_STATE.STALE]:        '#FF6B00',
  [SSE_STATE.RECONNECTING]: '#FFCC00',
  [SSE_STATE.PAUSED]:       '#5AC8FA',
  [SSE_STATE.CLOSED]:       '#8E8E93',
  [SSE_STATE.FAILED]:       '#FF3B30',
};

export default function App() {
  const sseRef = useRef(null);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [state, setState] = useState(SSE_STATE.IDLE);
  const [messages, setMessages] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const metricsTimer = useRef(null);

  // Every reconnect delay the library actually scheduled.
  const [delays, setDelays] = useState([]);

  // A manager holding streams this screen did NOT create standalone, so the
  // difference between closeAll() and disconnectAllStreams() is observable.
  const managerRef = useRef(null);
  const [managerIds, setManagerIds] = useState([]);

  const log = useCallback((text) => {
    const ts = new Date().toLocaleTimeString();
    setMessages((prev) => [`[${ts}] ${text}`, ...prev].slice(0, 50));
  }, []);

  const connect = useCallback(() => {
    if (!url.trim()) return;

    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    clearInterval(metricsTimer.current);

    setDelays([]);

    const sse = new NativeSSE(url.trim(), {
      staleTimeoutMs: 15000,
      pauseOnBackground: true,
      backgroundBehavior: 'pause',
      reconnectPolicy: {
        type: 'exponential',
        initialMs: 1000,
        maxMs: 15000,
        jitter: true,
      },
      // A `retry:` field is server-controlled input. It is honoured, but only
      // within these bounds — `retry: 0` would otherwise mean reconnecting with
      // no backoff at all, and a value big enough to overflow to Infinity
      // collapses to ~1ms in setTimeout, which is the same loop.
      minReconnectDelayMs: MIN_RECONNECT_MS,
      maxReconnectDelayMs: MAX_RECONNECT_MS,
      onReconnectAttempt: (attempt, delayMs) => {
        setDelays((prev) => [delayMs, ...prev].slice(0, 12));
        log(`reconnect #${attempt} in ${delayMs}ms`);
      },
      debug: true,
    });

    sse.onopen = () => {
      setState(sse.state);
      log('Connected');
    };

    sse.onmessage = (e) => {
      setState(sse.state);
      log(`message: ${e.data}`);
    };

    // onmessage only fires for events with no explicit type (i.e. "message").
    // Use addEventListener for custom event types your server emits.
    sse.addEventListener('random', (e) => {
      setState(sse.state);
      log(`random: ${e.data}`);
    });

    sse.onerror = (e) => {
      setState(sse.state);
      log(`error [${e.code}]: ${e.message}`);
    };

    metricsTimer.current = setInterval(() => {
      if (sseRef.current) {
        setMetrics(sseRef.current.getMetrics());
        setState(sseRef.current.state);
      }
    }, 2000);

    sseRef.current = sse;
    setState(sse.state);
    log(`Connecting to ${url.trim()}…`);
  }, [url, log]);

  const handlePause = useCallback(() => {
    sseRef.current?.pause();
    setState(sseRef.current?.state ?? SSE_STATE.IDLE);
    log('Paused');
  }, [log]);

  const handleResume = useCallback(() => {
    sseRef.current?.resume();
    setState(sseRef.current?.state ?? SSE_STATE.IDLE);
    log('Resumed');
  }, [log]);

  const handleClose = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
    clearInterval(metricsTimer.current);
    setState(SSE_STATE.IDLE);
    setMetrics(null);
    log('Closed');
  }, [log]);

  // ── SseStreamManager ───────────────────────────────────────────────────────

  const startManagedStreams = useCallback(() => {
    const manager = managerRef.current ?? new SseStreamManager();
    managerRef.current = manager;

    for (const id of ['alpha', 'beta']) {
      manager.create(id, stressUrl('/events'), {
        // Distinct keys: the default is derived from the URL, and these two
        // share an endpoint.
        storageKey: `sse:last-event-id:${id}`,
        reconnectPolicy: { type: 'fixed', intervalMs: 3000 },
      });
    }
    setManagerIds(manager.ids);
    log(`manager: started ${manager.ids.join(', ')}`);
  }, [log]);

  const managerCloseAll = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.closeAll();
    setManagerIds(manager.ids);
    const standalone = sseRef.current?.state ?? 'none';
    log(`closeAll() -> manager empty; standalone stream is "${standalone}"`);
  }, [log]);

  const managerDisconnectAll = useCallback(() => {
    const manager = managerRef.current ?? new SseStreamManager();
    managerRef.current = manager;
    manager.disconnectAllStreams();
    setManagerIds(manager.ids);
    // The standalone stream was never in this manager, and it is gone too.
    log('disconnectAllStreams() -> every stream in the process was cut');
    setTimeout(() => {
      const st = sseRef.current?.state ?? 'none';
      log(`  standalone stream is now "${st}"`);
      setState(sseRef.current?.state ?? SSE_STATE.IDLE);
    }, 300);
  }, [log]);

  useEffect(() => {
    return () => {
      sseRef.current?.close();
      managerRef.current?.closeAll();
      clearInterval(metricsTimer.current);
    };
  }, []);

  const isIdle     = state === SSE_STATE.IDLE;
  const canPause   = state === SSE_STATE.OPEN || state === SSE_STATE.CONNECTING || state === SSE_STATE.RECONNECTING;
  const canResume  = state === SSE_STATE.PAUSED;
  const canConnect = isIdle || state === SSE_STATE.CLOSED || state === SSE_STATE.FAILED;
  const canClose   = !canConnect;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>jose-native-sse</Text>
          <Text style={styles.subtitle}>Native SSE · TurboModules · Expo</Text>
        </View>

        <View style={styles.urlRow}>
          <TextInput
            style={styles.urlInput}
            value={url}
            onChangeText={setUrl}
            placeholder="https://…"
            placeholderTextColor="#636366"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable
            contextMenuHidden={false}
            selectTextOnFocus
          />
        </View>

        <View style={styles.chipRow}>
          {PRESETS.map((preset) => (
            <TouchableOpacity
              key={preset.path}
              style={styles.chip}
              onPress={() => {
                setUrl(stressUrl(preset.path));
                log(`preset: ${preset.label} — ${preset.hint}`);
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.chipText}>{preset.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.stateRow}>
          <View style={[styles.dot, { backgroundColor: STATE_COLOR[state] ?? '#8E8E93' }]} />
          <Text style={styles.stateText}>{state.toUpperCase()}</Text>
        </View>

        {metrics && (
          <View style={styles.metricsCard}>
            <MetricRow label="Events"     value={metrics.eventsReceived} />
            <MetricRow label="Bytes"      value={`${(metrics.bytesReceived / 1024).toFixed(1)} KB`} />
            <MetricRow label="Reconnects" value={metrics.reconnectCount} />
            <MetricRow label="Stale"      value={metrics.staleCount} />
            <MetricRow label="Last ID"    value={metrics.lastEventId || '—'} />
          </View>
        )}

        <View style={styles.controls}>
          <Btn label="Connect" onPress={connect}       disabled={!canConnect} color="#34C759" />
          <Btn label="Pause"   onPress={handlePause}   disabled={!canPause}   color="#5AC8FA" />
          <Btn label="Resume"  onPress={handleResume}  disabled={!canResume}  color="#FF9500" />
          <Btn label="Close"   onPress={handleClose}   disabled={!canClose}   color="#FF3B30" />
        </View>

        <Text style={styles.sectionTitle}>
          RECONNECT DELAYS · floor {MIN_RECONNECT_MS}ms · ceiling {MAX_RECONNECT_MS}ms
        </Text>
        <View style={styles.panel}>
          {delays.length === 0 ? (
            <Text style={styles.panelHint}>
              Pick “retry: 0” or “retry: 9…9” and connect. The server asks for a
              delay that would spin; every value below is what was actually
              scheduled.
            </Text>
          ) : (
            <>
              <View style={styles.delayRow}>
                {delays.map((d, i) => (
                  <Text
                    key={i}
                    style={[
                      styles.delayPill,
                      d < MIN_RECONNECT_MS * 0.8 && styles.delayPillBad,
                    ]}
                  >
                    {d}ms
                  </Text>
                ))}
              </View>
              <Text style={styles.panelHint}>
                min {Math.min(...delays)}ms · jitter is ±20%, so the floor shows
                as ≥{Math.round(MIN_RECONNECT_MS * 0.8)}ms. Anything red would be
                the unclamped bug.
              </Text>
            </>
          )}
        </View>

        <Text style={styles.sectionTitle}>STREAM MANAGER</Text>
        <View style={styles.panel}>
          <Text style={styles.panelHint}>
            {managerIds.length > 0
              ? `Managed: ${managerIds.join(', ')} — plus the standalone stream above, which this manager does not own.`
              : 'Start two managed streams, then compare the two teardowns against the standalone stream above.'}
          </Text>
          <View style={styles.controls}>
            <Btn label="Start 2 streams" onPress={startManagedStreams} color="#34C759" />
            <Btn label="closeAll()" onPress={managerCloseAll} disabled={managerIds.length === 0} color="#5AC8FA" />
            <Btn label="disconnectAllStreams()" onPress={managerDisconnectAll} color="#FF3B30" />
          </View>
          <Text style={styles.panelHint}>
            closeAll() leaves the standalone stream running. disconnectAllStreams()
            cuts every stream in the process, including ones it never created —
            which is why it is a separate method now.
          </Text>
        </View>

        <Text style={styles.logTitle}>EVENT LOG</Text>
        <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
          {messages.map((m, i) => (
            <View key={i} style={styles.logLineWrap}>
              <Text selectable style={styles.logLine}>{m}</Text>
            </View>
          ))}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Btn({ label, onPress, disabled, color }) {
  return (
    <TouchableOpacity
      style={[styles.btn, { backgroundColor: disabled ? '#3A3A3C' : color }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={styles.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function MetricRow({ label, value }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{String(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex:         { flex: 1 },
  safe:         { flex: 1, backgroundColor: '#1C1C1E' },
  header:       { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  title:        { fontSize: 22, fontWeight: '700', color: '#FFFFFF' },
  subtitle:     { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  urlRow:       { paddingHorizontal: 20, marginBottom: 12 },
  urlInput:     {
    backgroundColor: '#2C2C2E',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 14,
    fontFamily: 'Menlo',
  },
  stateRow:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginVertical: 12 },
  dot:          { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  stateText:    { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  metricsCard:  { marginHorizontal: 20, backgroundColor: '#2C2C2E', borderRadius: 12, padding: 14, marginBottom: 16 },
  metricRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  metricLabel:  { fontSize: 14, color: '#8E8E93' },
  metricValue:  { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
  controls:     { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, gap: 10, marginBottom: 16 },
  btn:          { flex: 1, minWidth: '42%', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnText:      { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  logTitle:     { fontSize: 12, fontWeight: '600', color: '#8E8E93', paddingHorizontal: 20, marginBottom: 6, letterSpacing: 1 },
  sectionTitle: { fontSize: 12, fontWeight: '600', color: '#8E8E93', paddingHorizontal: 20, marginBottom: 6, letterSpacing: 1 },
  chipRow:      { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 20, gap: 8 },
  chip:         { backgroundColor: '#2C2C2E', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  chipText:     { color: '#0A84FF', fontSize: 12, fontWeight: '600', fontFamily: 'Menlo' },
  panel:        { marginHorizontal: 20, backgroundColor: '#2C2C2E', borderRadius: 12, padding: 12, marginBottom: 16 },
  panelHint:    { fontSize: 11, color: '#8E8E93', lineHeight: 16 },
  delayRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  delayPill:    { backgroundColor: '#1C1C1E', color: '#34C759', fontSize: 12, fontFamily: 'Menlo', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, overflow: 'hidden' },
  delayPillBad: { color: '#FF3B30' },
  log:          { flex: 1, marginHorizontal: 20, backgroundColor: '#2C2C2E', borderRadius: 12, marginBottom: 16 },
  logContent:   { padding: 12 },
  logLineWrap:  { paddingVertical: 2 },
  logLine:      { fontSize: 12, color: '#E5E5EA', fontFamily: 'Menlo', paddingVertical: 2 },
});
