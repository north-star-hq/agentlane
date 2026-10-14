import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Home' }} />
        <Stack.Screen name="details" options={{ title: 'Details' }} />
        <Stack.Screen name="api" options={{ title: 'API' }} />
        <Stack.Screen
          name="sheet"
          options={{
            presentation: 'formSheet',
            headerShown: false,
            sheetAllowedDetents: [0.4],
            sheetGrabberVisible: true,
          }}
        />
      </Stack>
    </>
  );
}
