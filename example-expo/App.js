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
import { NativeSSE, SSE_STATE } from 'jose-native-sse';

const DEFAULT_URL = 'https://sse.dev/test';

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

  useEffect(() => {
    return () => {
      sseRef.current?.close();
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
  log:          { flex: 1, marginHorizontal: 20, backgroundColor: '#2C2C2E', borderRadius: 12, marginBottom: 16 },
  logContent:   { padding: 12 },
  logLineWrap:  { paddingVertical: 2 },
  logLine:      { fontSize: 12, color: '#E5E5EA', fontFamily: 'Menlo', paddingVertical: 2 },
});
