export type DeviceState = 'Booted' | 'Shutdown' | 'Creating' | 'Booting' | 'Shutting Down' | (string & {});

export interface DeviceInfo {
  udid: string;
  name: string;
  state: DeviceState;
  dataPath: string;
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export type Appearance = 'light' | 'dark';

export type StatusBarFields = Record<string, string>;

export interface SimTools {
  device(udid: string): Promise<DeviceInfo | undefined>;

  setLocation(udid: string, at: Coordinate): Promise<void>;
  readLocation(udid: string, since: Date): Promise<Coordinate | undefined>;

  readHardwareKeyboard(udid: string): Promise<boolean | undefined>;
  writeHardwareKeyboard(udid: string, connected: boolean): Promise<void>;

  readKeyboardIntroShown(udid: string): Promise<boolean | undefined>;
  writeKeyboardIntroShown(udid: string, shown: boolean): Promise<void>;

  overrideStatusBar(udid: string, flags: readonly string[]): Promise<void>;
  readStatusBar(udid: string): Promise<StatusBarFields>;

  setAppearance(udid: string, appearance: Appearance): Promise<void>;
  readAppearance(udid: string): Promise<string | undefined>;

  appInstalled(udid: string, bundleId: string): Promise<boolean>;
  appRunning(udid: string, bundleId: string): Promise<boolean>;
  installApp(udid: string, appPath: string): Promise<void>;
  appContainer(udid: string, bundleId: string): Promise<string | undefined>;
  appCommandLine(udid: string, bundleId: string): Promise<string | undefined>;
  readAppDefault(udid: string, bundleId: string, key: string): Promise<string | undefined>;
  writeAppDefault(udid: string, bundleId: string, key: string, value: string): Promise<void>;
  deleteAppDefault(udid: string, bundleId: string, key: string): Promise<void>;

  readPlistString(file: string, key: string): Promise<string | undefined>;
  writePlistString(file: string, key: string, value: string): Promise<void>;

  launch(udid: string, bundleId: string, args: readonly string[]): Promise<void>;
  terminate(udid: string, bundleId: string): Promise<void>;
  openUrl(udid: string, url: string): Promise<void>;
  shutdown(udid: string): Promise<void>;
  boot(udid: string): Promise<void>;

  now(): Date;
  sleep(ms: number): Promise<void>;
}
