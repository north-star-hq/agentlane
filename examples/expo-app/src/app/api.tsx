import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, colors } from '../components/ui';
import { API_BASE_URL_ARGUMENT, readApiBaseUrl } from '../config';

const REQUEST_TIMEOUT_MS = 5000;

interface Item {
  id: string;
  name: string;
  minutes: number;
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'loaded'; items: Item[]; port: number };

async function fetchItems(baseUrl: string): Promise<{ items: Item[]; port: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/items`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    return (await response.json()) as { items: Item[]; port: number };
  } finally {
    clearTimeout(timer);
  }
}

function Unconfigured() {
  return (
    <View testID="api-unconfigured" style={styles.panel}>
      <Text style={styles.title}>No API configured</Text>
      <Text style={styles.body}>
        Launch the app with -{API_BASE_URL_ARGUMENT} http://localhost:&lt;port&gt; to point it at a running API.
      </Text>
    </View>
  );
}

function Connected({ baseUrl }: { baseUrl: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    fetchItems(baseUrl).then(
      result => {
        if (current) setState({ kind: 'loaded', ...result });
      },
      (error: unknown) => {
        if (current) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [baseUrl, attempt]);

  const reload = () => {
    setState({ kind: 'loading' });
    setAttempt(value => value + 1);
  };

  return (
    <>
      <Text testID="api-base-url" style={styles.body}>
        API: {baseUrl}
      </Text>
      {state.kind === 'loading' && <ActivityIndicator testID="api-loading" color={colors.accent} />}
      {state.kind === 'error' && (
        <View testID="api-error" style={styles.panel}>
          <Text style={[styles.title, styles.error]}>Could not reach the API</Text>
          <Text testID="api-error-detail" style={styles.body}>
            {state.message}
          </Text>
        </View>
      )}
      {state.kind === 'loaded' && (
        <View testID="api-result" style={styles.panel}>
          <Text testID="api-served-by" style={styles.title}>
            Served by port {state.port}
          </Text>
          {state.items.map(item => (
            <Text key={item.id} testID={`api-item-${item.id}`} style={styles.item}>
              {item.name} · {item.minutes} min
            </Text>
          ))}
        </View>
      )}
      <Button testID="api-reload" label="Reload" onPress={reload} />
    </>
  );
}

export default function Api() {
  const baseUrl = readApiBaseUrl();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {baseUrl ? <Connected baseUrl={baseUrl} /> : <Unconfigured />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12 },
  panel: { backgroundColor: colors.surface, borderRadius: 12, padding: 16, gap: 8 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  error: { color: colors.danger },
  body: { color: colors.muted, fontSize: 15 },
  item: { color: colors.text, fontSize: 16 },
});
