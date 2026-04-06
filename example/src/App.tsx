/**
 * jose-native-sse V2 Example App
 *
 * Tab 1 – Basic Stream          : single stream, state badges, event log
 * Tab 2 – Multi-Stream          : two concurrent streams with isolation demo
 * Tab 3 – AI / Token Streaming  : batched high-frequency stream + token display
 * Tab 4 – Lifecycle             : manual pause/resume + AppState awareness
 */

import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Button,
  FlatList,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  NativeSSE,
  SseStreamManager,
  SSE_STATE,
} from 'jose-native-sse';
import type {
  SseConnectOptions,
  SseErrorEvent,
  SseMessageEvent,
  SseState,
  StreamMetrics,
} from 'jose-native-sse';

// ─── Demo SSE endpoints ───────────────────────────────────────────────────────
// Replace with your own server URLs.

const ENDPOINTS = {
  basic:     'https://sse.dev/test',
  stream1:   'https://sse.dev/test',
  stream2:   'https://sse.dev/test',
  aiTokens:  'https://sse.dev/test',
  lifecycle: 'https://sse.dev/test',
};

// ─── Shared types ─────────────────────────────────────────────────────────────

interface LogEntry {
  id:   string;
  ts:   string;
  tag:  'open' | 'message' | 'batch' | 'error' | 'close' | 'state' | 'info';
  text: string;
}

function mkEntry(tag: LogEntry['tag'], text: string): LogEntry {
  return { id: `${Date.now()}-${Math.random()}`, ts: new Date().toLocaleTimeString(), tag, text };
}

// ─── STATE BADGE ──────────────────────────────────────────────────────────────

const STATE_CONFIG: Record<SseState, { color: string; label: string }> = {
  idle:         { color: '#9ca3af', label: 'IDLE'         },
  connecting:   { color: '#f59e0b', label: 'CONNECTING'   },
  open:         { color: '#10b981', label: 'OPEN'         },
  reconnecting: { color: '#f97316', label: 'RECONNECTING' },
  paused:       { color: '#6366f1', label: 'PAUSED'       },
  closed:       { color: '#6b7280', label: 'CLOSED'       },
  failed:       { color: '#ef4444', label: 'FAILED'       },
};

function StateBadge({ state }: { state: SseState }) {
  const { color, label } = STATE_CONFIG[state];
  const spinning = state === 'connecting' || state === 'reconnecting';
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      {spinning && <ActivityIndicator size="small" color="#fff" style={{ marginRight: 4, transform: [{ scale: 0.7 }] }} />}
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

// ─── LOG LIST ─────────────────────────────────────────────────────────────────

const TAG_COLORS: Record<LogEntry['tag'], string> = {
  open:    '#10b981',
  message: '#3b82f6',
  batch:   '#8b5cf6',
  error:   '#ef4444',
  close:   '#6b7280',
  state:   '#f59e0b',
  info:    '#6366f1',
};

const LogRow = React.memo(({ item }: { item: LogEntry }) => (
  <View style={styles.logRow}>
    <Text style={styles.logTs}>{item.ts}</Text>
    <View style={[styles.logTag, { backgroundColor: TAG_COLORS[item.tag] }]}>
      <Text style={styles.logTagText}>{item.tag}</Text>
    </View>
    <Text style={styles.logText} numberOfLines={4}>{item.text}</Text>
  </View>
));

// ─── Metrics display ──────────────────────────────────────────────────────────

function MetricsRow({ metrics }: { metrics: StreamMetrics }) {
  return (
    <View style={styles.metricsRow}>
      {[
        ['Events', String(metrics.eventsReceived)],
        ['Bytes',  String(metrics.bytesReceived)],
        ['Reconnects', String(metrics.reconnectCount)],
      ].map(([k, v]) => (
        <View key={k} style={styles.metricCell}>
          <Text style={styles.metricVal}>{v}</Text>
          <Text style={styles.metricKey}>{k}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── useStream hook ───────────────────────────────────────────────────────────

function useStream(options: SseConnectOptions = {}) {
  const [state, setState] = useState<SseState>(SSE_STATE.IDLE);
  const [log, dispatch] = useReducer(
    (prev: LogEntry[], entry: LogEntry) => [entry, ...prev].slice(0, 200),
    [],
  );
  const [metrics, setMetrics] = useState<StreamMetrics>({
    bytesReceived: 0, eventsReceived: 0, reconnectCount: 0,
    lastEventId: '', lastEventTimestamp: null, lastError: null, connectedAt: null,
  });

  const sseRef  = useRef<NativeSSE | null>(null);
  const push    = useCallback((e: LogEntry) => dispatch(e), []);

  const connect = useCallback((url: string) => {
    sseRef.current?.close();
    const sse = new NativeSSE(url, { ...options, autoConnect: false });

    sse.onopen = () => {
      setState(sse.state);
      push(mkEntry('open', 'Connected'));
    };
    sse.onmessage = (e: SseMessageEvent) => {
      setState(sse.state);
      setMetrics(sse.getMetrics());
      push(mkEntry('message', `[${e.type}] ${e.data}`));
    };
    sse.onerror = (e: SseErrorEvent) => {
      setState(sse.state);
      setMetrics(sse.getMetrics());
      push(mkEntry('error', `${e.code}: ${e.message}${e.statusCode ? ` (${e.statusCode})` : ''}`));
    };
    sse.addEventListener('error', () => {
      setState(sse.state);
    });

    sseRef.current = sse;
    sse.connect();
    setState(sse.state);
    push(mkEntry('info', `Connecting to ${url}…`));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
    setState(SSE_STATE.CLOSED);
    push(mkEntry('info', 'Disconnected'));
  }, [push]);

  const pause  = useCallback(() => { sseRef.current?.pause();  setState(sseRef.current?.state ?? SSE_STATE.PAUSED);  }, []);
  const resume = useCallback(() => { sseRef.current?.resume(); setState(sseRef.current?.state ?? SSE_STATE.CONNECTING); }, []);

  useEffect(() => () => { sseRef.current?.close(); }, []);

  return { state, log, metrics, sseRef, connect, close, pause, resume };
}

// ─── TAB 1: Basic Stream ──────────────────────────────────────────────────────

function BasicStreamTab() {
  const { state, log, metrics, connect, close, pause, resume } = useStream({
    reconnectPolicy: { type: 'exponential', initialMs: 1000, maxMs: 30000 },
    maxReconnectAttempts: 10,
    debug: true,
  });

  const isActive = state === SSE_STATE.OPEN || state === SSE_STATE.CONNECTING || state === SSE_STATE.RECONNECTING;

  return (
    <View style={styles.tab}>
      <View style={styles.row}>
        <Text style={styles.tabTitle}>Basic Stream</Text>
        <StateBadge state={state} />
      </View>
      <MetricsRow metrics={metrics} />
      <View style={styles.btnRow}>
        <View style={styles.btn}>
          <Button title={isActive ? 'Disconnect' : 'Connect'}
                  onPress={isActive ? close : () => connect(ENDPOINTS.basic)}
                  color={isActive ? '#ef4444' : '#10b981'} />
        </View>
        {state === SSE_STATE.OPEN && (
          <View style={styles.btn}><Button title="Pause" onPress={pause} color="#6366f1" /></View>
        )}
        {state === SSE_STATE.PAUSED && (
          <View style={styles.btn}><Button title="Resume" onPress={resume} color="#10b981" /></View>
        )}
      </View>
      <EventLog log={log} />
    </View>
  );
}

// ─── TAB 2: Multi-Stream ─────────────────────────────────────────────────────

const manager = new SseStreamManager();

function MultiStreamTab() {
  const [states, setStates] = useState<Record<string, SseState>>({
    s1: SSE_STATE.IDLE, s2: SSE_STATE.IDLE,
  });
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({ s1: [], s2: [] });
  const [agg, setAgg] = useState(manager.getAggregateMetrics());

  const addLog = (id: string, entry: LogEntry) => {
    setLogs(prev => ({ ...prev, [id]: [entry, ...prev[id]!].slice(0, 50) }));
    setAgg(manager.getAggregateMetrics());
  };

  const connect = (id: string, url: string) => {
    const sse = manager.create(id, url, {
      reconnectPolicy: { type: 'fixed', intervalMs: 3000 },
    });
    sse.onopen    = ()  => { setStates(p => ({ ...p, [id]: sse.state })); addLog(id, mkEntry('open', 'Connected')); };
    sse.onmessage = (e) => { setStates(p => ({ ...p, [id]: sse.state })); addLog(id, mkEntry('message', e.data)); };
    sse.onerror   = (e) => { setStates(p => ({ ...p, [id]: sse.state })); addLog(id, mkEntry('error', e.message)); };
    setStates(p => ({ ...p, [id]: sse.state }));
  };

  const disconnectStream = (id: string) => {
    manager.get(id)?.close();
    setStates(p => ({ ...p, [id]: SSE_STATE.CLOSED }));
    addLog(id, mkEntry('info', 'Closed'));
  };

  useEffect(() => () => { manager.closeAll(); }, []);

  return (
    <View style={styles.tab}>
      <Text style={styles.tabTitle}>Multi-Stream</Text>
      <View style={styles.metricsRow}>
        <View style={styles.metricCell}>
          <Text style={styles.metricVal}>{agg.totalEventsReceived}</Text>
          <Text style={styles.metricKey}>Total Events</Text>
        </View>
        <View style={styles.metricCell}>
          <Text style={styles.metricVal}>{agg.totalBytesReceived}</Text>
          <Text style={styles.metricKey}>Total Bytes</Text>
        </View>
        <View style={styles.metricCell}>
          <Text style={styles.metricVal}>{agg.totalReconnects}</Text>
          <Text style={styles.metricKey}>Reconnects</Text>
        </View>
      </View>
      {['s1', 's2'].map(id => {
        const st = states[id]!;
        const active = st === SSE_STATE.OPEN || st === SSE_STATE.CONNECTING;
        return (
          <View key={id} style={styles.miniPanel}>
            <View style={styles.row}>
              <Text style={styles.miniTitle}>Stream {id}</Text>
              <StateBadge state={st} />
            </View>
            <View style={styles.btn}>
              <Button title={active ? 'Disconnect' : 'Connect'}
                      onPress={active ? () => disconnectStream(id) : () => connect(id, id === 's1' ? ENDPOINTS.stream1 : ENDPOINTS.stream2)}
                      color={active ? '#ef4444' : '#10b981'} />
            </View>
            <FlatList
              data={logs[id]}
              keyExtractor={e => e.id}
              renderItem={({ item }) => <LogRow item={item} />}
              style={styles.miniLog}
              ListEmptyComponent={<Text style={styles.empty}>No events</Text>}
            />
          </View>
        );
      })}
    </View>
  );
}

// ─── TAB 3: AI Token Streaming ───────────────────────────────────────────────

function AiStreamTab() {
  const [tokens, setTokens] = useState('');
  const [state, setStreamState] = useState<SseState>(SSE_STATE.IDLE);
  const [batchCount, setBatchCount] = useState(0);
  const sseRef = useRef<NativeSSE | null>(null);

  const start = () => {
    sseRef.current?.close();
    setTokens('');
    setBatchCount(0);

    const sse = new NativeSSE(ENDPOINTS.aiTokens, {
      batch: { enabled: true, flushIntervalMs: 50, maxBatchSize: 30 },
      reconnectPolicy: { type: 'exponential', initialMs: 500, maxMs: 10000 },
    });

    sse.onopen = () => setStreamState(sse.state);
    sse.onerror = () => setStreamState(sse.state);

    // onbatch delivers tokens in chunks → single setState per render cycle.
    sse.onbatch = (events) => {
      setStreamState(sse.state);
      setBatchCount(n => n + 1);
      setTokens(prev => prev + events.map(e => e.data).join(''));
    };

    sseRef.current = sse;
    setStreamState(sse.state);
  };

  const stop = () => {
    sseRef.current?.close();
    sseRef.current = null;
    setStreamState(SSE_STATE.CLOSED);
  };

  useEffect(() => () => { sseRef.current?.close(); }, []);

  const active = state === SSE_STATE.OPEN || state === SSE_STATE.CONNECTING;

  return (
    <View style={styles.tab}>
      <View style={styles.row}>
        <Text style={styles.tabTitle}>AI Token Stream</Text>
        <StateBadge state={state} />
      </View>
      <Text style={styles.hint}>
        Uses batch mode (50ms flush) for efficient React updates.{'\n'}
        Batches flushed: {batchCount}
      </Text>
      <View style={styles.btnRow}>
        <View style={styles.btn}>
          <Button title={active ? 'Stop' : 'Start'} onPress={active ? stop : start}
                  color={active ? '#ef4444' : '#10b981'} />
        </View>
        <View style={styles.btn}>
          <Button title="Clear" onPress={() => setTokens('')} color="#6b7280" />
        </View>
      </View>
      <ScrollView style={styles.tokenOutput}>
        <Text style={styles.tokenText}>{tokens || 'Output appears here…'}</Text>
      </ScrollView>
    </View>
  );
}

// ─── TAB 4: Lifecycle ─────────────────────────────────────────────────────────

function LifecycleTab() {
  const [state, setStreamState] = useState<SseState>(SSE_STATE.IDLE);
  const [log, dispatch] = useReducer(
    (p: LogEntry[], e: LogEntry) => [e, ...p].slice(0, 100),
    [],
  );
  const [pauseOnBg, setPauseOnBg] = useState(true);
  const sseRef = useRef<NativeSSE | null>(null);

  const push = (tag: LogEntry['tag'], text: string) => dispatch(mkEntry(tag, text));

  const start = () => {
    sseRef.current?.close();
    const sse = new NativeSSE(ENDPOINTS.lifecycle, {
      pauseOnBackground: pauseOnBg,
      reconnectPolicy: { type: 'exponential', initialMs: 1000, maxMs: 15000 },
      debug: true,
    });
    sse.onopen    = ()  => { setStreamState(sse.state); push('open',  'Connected'); };
    sse.onmessage = (e) => { setStreamState(sse.state); push('message', e.data); };
    sse.onerror   = (e) => { setStreamState(sse.state); push('error',  `${e.code}: ${e.message}`); };
    sse.addEventListener('error', () => setStreamState(sse.state));
    sseRef.current = sse;
    setStreamState(sse.state);
    push('info', `Started (pauseOnBackground: ${pauseOnBg})`);
  };

  const stop   = () => { sseRef.current?.close(); sseRef.current = null; setStreamState(SSE_STATE.CLOSED); push('info', 'Closed'); };
  const pause  = () => { sseRef.current?.pause(); setStreamState(sseRef.current?.state ?? SSE_STATE.PAUSED); push('state', 'Paused'); };
  const resume = () => { sseRef.current?.resume(); setStreamState(sseRef.current?.state ?? SSE_STATE.CONNECTING); push('state', 'Resumed'); };

  useEffect(() => () => { sseRef.current?.close(); }, []);

  const running = state !== SSE_STATE.IDLE && state !== SSE_STATE.CLOSED && state !== SSE_STATE.FAILED;

  return (
    <View style={styles.tab}>
      <View style={styles.row}>
        <Text style={styles.tabTitle}>Lifecycle</Text>
        <StateBadge state={state} />
      </View>
      <View style={[styles.row, { marginBottom: 8 }]}>
        <Text style={styles.switchLabel}>Pause on Background</Text>
        <Switch value={pauseOnBg} onValueChange={setPauseOnBg} disabled={running} />
      </View>
      <View style={styles.btnRow}>
        {!running ? (
          <View style={styles.btn}><Button title="Start" onPress={start} color="#10b981" /></View>
        ) : (
          <>
            <View style={styles.btn}><Button title="Stop" onPress={stop} color="#ef4444" /></View>
            {state === SSE_STATE.OPEN && <View style={styles.btn}><Button title="Pause" onPress={pause} color="#6366f1" /></View>}
            {state === SSE_STATE.PAUSED && <View style={styles.btn}><Button title="Resume" onPress={resume} color="#10b981" /></View>}
          </>
        )}
      </View>
      <Text style={styles.hint}>
        With pauseOnBackground ON, the stream pauses automatically when you leave the app and resumes when you return.
      </Text>
      <EventLog log={log} />
    </View>
  );
}

// ─── Shared EventLog ──────────────────────────────────────────────────────────

function EventLog({ log }: { log: LogEntry[] }) {
  return (
    <FlatList
      data={log}
      keyExtractor={e => e.id}
      renderItem={({ item }) => <LogRow item={item} />}
      style={styles.logList}
      ListEmptyComponent={<Text style={styles.empty}>No events yet…</Text>}
    />
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

type Tab = 'basic' | 'multi' | 'ai' | 'lifecycle';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'basic',     label: 'Basic'     },
  { id: 'multi',     label: 'Multi'     },
  { id: 'ai',        label: 'AI'        },
  { id: 'lifecycle', label: 'Lifecycle' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('basic');

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.tabBar}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.id}
            style={[styles.tabItem, tab === t.id && styles.tabItemActive]}
            onPress={() => setTab(t.id)}
          >
            <Text style={[styles.tabLabel, tab === t.id && styles.tabLabelActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
        {tab === 'basic'     && <BasicStreamTab />}
        {tab === 'multi'     && <MultiStreamTab />}
        {tab === 'ai'        && <AiStreamTab />}
        {tab === 'lifecycle' && <LifecycleTab />}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#f3f4f6' },
  tabBar:        { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  tabItem:       { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabItemActive: { borderBottomWidth: 2, borderBottomColor: '#6366f1' },
  tabLabel:      { fontSize: 13, color: '#9ca3af', fontWeight: '500' },
  tabLabelActive:{ color: '#6366f1', fontWeight: '700' },
  content:       { flex: 1 },
  tab:           { padding: 16 },
  tabTitle:      { fontSize: 17, fontWeight: '700', color: '#111827' },
  hint:          { fontSize: 12, color: '#6b7280', marginVertical: 8, lineHeight: 18 },
  badge:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99 },
  badgeText:     { color: '#fff', fontSize: 11, fontWeight: '600' },
  row:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  btnRow:        { flexDirection: 'row', gap: 8, marginBottom: 12 },
  btn:           { flex: 1 },
  switchLabel:   { fontSize: 14, color: '#374151' },
  metricsRow:    { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  metricCell:    { flex: 1, alignItems: 'center' },
  metricVal:     { fontSize: 20, fontWeight: '700', color: '#111827' },
  metricKey:     { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  logList:       { maxHeight: 300, borderTopWidth: 1, borderTopColor: '#f3f4f6', paddingTop: 4 },
  logRow:        { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 3, gap: 6 },
  logTs:         { fontSize: 10, color: '#9ca3af', minWidth: 60, paddingTop: 2 },
  logTag:        { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  logTagText:    { color: '#fff', fontSize: 10, fontWeight: '600' },
  logText:       { flex: 1, fontSize: 12, color: '#374151', fontFamily: 'Menlo' },
  empty:         { color: '#9ca3af', fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  miniPanel:     { backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  miniTitle:     { fontSize: 14, fontWeight: '600', color: '#374151' },
  miniLog:       { maxHeight: 120, marginTop: 8 },
  tokenOutput:   { flex: 1, backgroundColor: '#1e1e2e', borderRadius: 10, padding: 14, minHeight: 200 },
  tokenText:     { fontSize: 14, color: '#cdd6f4', fontFamily: 'Menlo', lineHeight: 22 },
});
