import { Link, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Button, Section, colors } from '../components/ui';

const ROW_COUNT = 40;
const rows = Array.from({ length: ROW_COUNT }, (_, index) => index + 1);

function Ticker() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(value => value + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <Text testID="home-ticker" style={styles.ticker}>
      Open for {seconds} s
    </Text>
  );
}

function Controls() {
  const [taps, setTaps] = useState(0);
  const [name, setName] = useState('');
  const [notify, setNotify] = useState(false);

  return (
    <View>
      <Ticker />

      <Section title="Counter">
        <View style={styles.row}>
          <Button testID="home-increment" label="Add one" onPress={() => setTaps(value => value + 1)} />
          <Text testID="home-tap-count" style={styles.value}>
            Taps: {taps}
          </Text>
        </View>
      </Section>

      <Section title="Name">
        <TextInput
          testID="home-name-input"
          style={styles.input}
          placeholder="Type a name"
          placeholderTextColor={colors.muted}
          value={name}
          onChangeText={setName}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="done"
        />
        <Text testID="home-greeting" style={styles.value}>
          {name ? `Hello, ${name}` : 'Hello, stranger'}
        </Text>
      </Section>

      <Section title="Notifications">
        <View style={styles.row}>
          <Switch testID="home-notify-switch" value={notify} onValueChange={setNotify} />
          <Text testID="home-notify-state" style={styles.value}>
            {notify ? 'Notifications on' : 'Notifications off'}
          </Text>
        </View>
      </Section>

      <Section title="Go">
        <View style={styles.actions}>
          <Button testID="home-open-sheet" label="Open sheet" onPress={() => router.push('/sheet')} />
          <Link href="/details" asChild>
            <Pressable testID="home-open-details" accessibilityRole="button" style={styles.secondary}>
              <Text style={styles.secondaryLabel}>Details</Text>
            </Pressable>
          </Link>
          <Link href="/api" asChild>
            <Pressable testID="home-open-api" accessibilityRole="button" style={styles.secondary}>
              <Text style={styles.secondaryLabel}>API</Text>
            </Pressable>
          </Link>
        </View>
      </Section>

      <Section title="Rows" />
    </View>
  );
}

export default function Home() {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <FlatList
      testID="home-list"
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<Controls />}
      data={rows}
      keyExtractor={row => String(row)}
      renderItem={({ item }) => (
        <Pressable testID={`row-${String(item)}`} style={styles.listRow} onPress={() => setSelected(item)}>
          <Text style={styles.listRowLabel}>
            Row {item}
            {selected === item ? ' (selected)' : ''}
          </Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 48 },
  ticker: { color: colors.muted, fontSize: 14, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  actions: { flexDirection: 'row', gap: 8 },
  value: { color: colors.text, fontSize: 16, marginTop: 4 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
  },
  secondary: {
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryLabel: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  listRow: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  listRowLabel: { color: colors.text, fontSize: 16 },
});
