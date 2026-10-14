import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button, colors } from '../components/ui';

export default function Sheet() {
  return (
    <View testID="sheet-screen" style={styles.sheet}>
      <Text testID="sheet-title" style={styles.title}>
        A bottom sheet
      </Text>
      <Text style={styles.body}>Close it with the button or drag it down.</Text>
      <Button testID="sheet-close" label="Close sheet" onPress={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.surface, padding: 24, gap: 12 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  body: { color: colors.muted, fontSize: 16 },
});
