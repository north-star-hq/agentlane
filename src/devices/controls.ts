import { DeviceCommandError, execCommand, type Exec } from './xcrun.ts';

export const PRIVACY_SERVICES = [
  'all',
  'calendar',
  'contacts-limited',
  'contacts',
  'location',
  'location-always',
  'photos-add',
  'photos',
  'media-library',
  'microphone',
  'motion',
  'reminders',
  'siri',
] as const;

export type PrivacyService = (typeof PRIVACY_SERVICES)[number];

/** The Android runtime permissions behind each service; the services with no Android permission are left out. */
export const ANDROID_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  calendar: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
  camera: ['android.permission.CAMERA'],
  contacts: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  location: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  'location-always': ['android.permission.ACCESS_BACKGROUND_LOCATION'],
  'media-library': ['android.permission.READ_MEDIA_AUDIO'],
  microphone: ['android.permission.RECORD_AUDIO'],
  motion: ['android.permission.ACTIVITY_RECOGNITION'],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  photos: ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO'],
};

export const ANDROID_SERVICES = ['all', ...Object.keys(ANDROID_PERMISSIONS)] as const;

export function androidPermissionsOf(service: string): readonly string[] | undefined {
  if (service === 'all') return Object.values(ANDROID_PERMISSIONS).flat();
  return ANDROID_PERMISSIONS[service];
}
export type PrivacyAction = 'grant' | 'revoke' | 'reset';

/** The simulator controls beyond capture hygiene: permissions, push, clipboard and clearing the location. */
export interface ControlTools {
  clearLocation(udid: string): Promise<void>;
  privacy(udid: string, action: PrivacyAction, service: PrivacyService, bundleId?: string): Promise<void>;
  push(udid: string, bundleId: string, payload: string): Promise<void>;
  writeClipboard(udid: string, text: string): Promise<void>;
  readClipboard(udid: string): Promise<string>;
}

export function isPrivacyService(value: string): value is PrivacyService {
  return (PRIVACY_SERVICES as readonly string[]).includes(value);
}

export function createXcrunControls(options: { exec?: Exec } = {}): ControlTools {
  const exec = options.exec ?? execCommand;
  const simctl = async (args: readonly string[], input?: string): Promise<string> => {
    const full = ['simctl', ...args];
    const result = await exec('xcrun', full, input === undefined ? undefined : { input });
    if (result.code !== 0) throw new DeviceCommandError('xcrun', full, result);
    return result.stdout;
  };
  return {
    async clearLocation(udid) {
      await simctl(['location', udid, 'clear']);
    },
    async privacy(udid, action, service, bundleId) {
      await simctl(['privacy', udid, action, service, ...(bundleId === undefined ? [] : [bundleId])]);
    },
    async push(udid, bundleId, payload) {
      await simctl(['push', udid, bundleId, '-'], payload);
    },
    async writeClipboard(udid, text) {
      await simctl(['pbcopy', udid], text);
    },
    async readClipboard(udid) {
      return simctl(['pbpaste', udid]);
    },
  };
}
