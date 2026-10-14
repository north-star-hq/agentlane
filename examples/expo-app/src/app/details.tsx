import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button, colors } from '../components/ui';

export default function Details() {
  return (
    <View testID="details-screen" style={styles.screen}>
      <Text testID="details-title" style={styles.title}>
        Second screen
      </Text>
      <Text style={styles.body}>Reached by navigation from the home screen.</Text>
      <Button testID="details-back" label="Back to home" onPress={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: 16, gap: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  body: { color: colors.muted, fontSize: 16 },
});
