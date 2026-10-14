import { requireOptionalNativeModule } from 'expo';
import { Platform, Settings } from 'react-native';

export const API_BASE_URL_ARGUMENT = 'apiBaseUrl';

interface LaunchArguments {
  string(name: string): string | null;
}

function launchArgument(name: string): unknown {
  if (Platform.OS === 'ios') return Settings.get(name);
  if (Platform.OS === 'android') return requireOptionalNativeModule<LaunchArguments>('LaunchArguments')?.string(name);
  return null;
}

export function readApiBaseUrl(): string | null {
  const value = launchArgument(API_BASE_URL_ARGUMENT);
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim().replace(/\/+$/, '');
}
