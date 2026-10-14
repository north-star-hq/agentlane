import { shellQuote } from '../registry/format.ts';
import { UsageError } from '../registry/refusal.ts';
import { findAndroidSdk, MAESTRO_DRIVER_PACKAGE } from './emulator.ts';
import { parseDebuggable } from './variant.ts';
import type { Appearance, Coordinate } from './tools.ts';
import { DeviceCommandError, execCommand, type Exec } from './xcrun.ts';

export const ANIMATION_SETTINGS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const;

/** The adb commands the toolkit runs on one claimed emulator. Every one names its serial; none acts on another device. */
export interface AdbTools {
  readonly serial: string;
  bootCompleted(): Promise<boolean>;
  appInstalled(pkg: string): Promise<boolean>;
  appRunning(pkg: string): Promise<boolean>;
  installedApk(pkg: string): Promise<string[]>;
  /** Whether the installed package is DEBUGGABLE; undefined when dumpsys lists no flags. */
  debuggable(pkg: string): Promise<boolean | undefined>;
  pull(remote: string, local: string): Promise<void>;
  install(apk: string): Promise<void>;
  forceStop(pkg: string): Promise<void>;
  start(args: readonly string[]): Promise<void>;
  launcherActivity(pkg: string): Promise<string | undefined>;
  reverse(devicePort: number, hostPort: number): Promise<void>;
  reverses(): Promise<Map<number, number>>;
  removeReverse(devicePort: number): Promise<void>;
  setLocation(at: Coordinate): Promise<void>;
  nightMode(): Promise<Appearance | undefined>;
  setNightMode(appearance: Appearance): Promise<void>;
  globalSetting(key: string): Promise<string | undefined>;
  putGlobalSetting(key: string, value: string): Promise<void>;
  permission(action: 'grant' | 'revoke', pkg: string, permission: string): Promise<void>;
  clearPermissionFlags(pkg: string, permission: string): Promise<void>;
  resetPermissions(): Promise<void>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export function adbPath(env: NodeJS.ProcessEnv): string {
  const sdk = findAndroidSdk(env);
  if (!sdk) {
    throw new UsageError(
      'no Android SDK found (looked at ANDROID_HOME, ANDROID_SDK_ROOT and ~/Library/Android/sdk)',
      'install Android Studio or the SDK command-line tools, and set ANDROID_HOME',
    );
  }
  return sdk.adb;
}

/** `adb -s <serial> reverse --list` lists only that device's rules, each led by a transport name such as host-16. */
export type AdbFactory = (serial: string) => AdbTools;

/** The adb tools for one serial: the injected factory in tests, else the SDK's adb. */
export function adbTools(deps: { env: NodeJS.ProcessEnv; adb?: AdbFactory | undefined }, serial: string): AdbTools {
  return deps.adb ? deps.adb(serial) : createAdbTools(serial, { adb: adbPath(deps.env) });
}

export function parseReverseList(text: string): Map<number, number> {
  const rules = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\S+\s+tcp:(\d+)\s+tcp:(\d+)\s*$/.exec(line.trim());
    if (match) rules.set(Number(match[1]), Number(match[2]));
  }
  return rules;
}

export function parseNightMode(text: string): Appearance | undefined {
  const match = /Night mode:\s*(yes|no)/i.exec(text);
  if (!match) return undefined;
  return match[1]?.toLowerCase() === 'yes' ? 'dark' : 'light';
}

export function parsePackagePaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => /^package:(.+)$/.exec(line.trim())?.[1])
    .filter((p): p is string => p !== undefined && p !== '');
}

export function parseResolvedActivity(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last !== undefined && /^[\w.]+\/[\w.$]+$/.test(last) ? last : undefined;
}

/** `adb shell` joins its arguments into one command line for the device's shell, so each one is quoted here. */
export function deviceCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(' ');
}

export function createAdbTools(serial: string, options: { adb: string; exec?: Exec }): AdbTools {
  const exec = options.exec ?? execCommand;
  const adb = async (args: readonly string[]): Promise<string> => {
    const full = ['-s', serial, ...args];
    const result = await exec(options.adb, full);
    if (result.code !== 0) throw new DeviceCommandError('adb', full, result);
    return result.stdout;
  };
  const shell = (args: readonly string[]) => adb(['shell', deviceCommand(args)]);
  const tools: AdbTools = {
    serial,
    async bootCompleted() {
      try {
        return (await shell(['getprop', 'sys.boot_completed'])).trim() === '1';
      } catch {
        return false;
      }
    },
    async appInstalled(pkg) {
      return (await tools.installedApk(pkg)).length > 0;
    },
    async appRunning(pkg) {
      const result = await exec(options.adb, ['-s', serial, 'shell', deviceCommand(['pidof', pkg])]);
      return result.code === 0 && /^\d+/.test(result.stdout.trim());
    },
    async installedApk(pkg) {
      const result = await exec(options.adb, ['-s', serial, 'shell', deviceCommand(['pm', 'path', pkg])]);
      return result.code === 0 ? parsePackagePaths(result.stdout) : [];
    },
    async debuggable(pkg) {
      return parseDebuggable(await shell(['dumpsys', 'package', pkg]));
    },
    async pull(remote, local) {
      await adb(['pull', remote, local]);
    },
    async install(apk) {
      const out = await adb(['install', '-r', apk]);
      if (!out.includes('Success'))
        throw new DeviceCommandError('adb', ['-s', serial, 'install', '-r', apk], { code: 1, stdout: out, stderr: '' });
    },
    async forceStop(pkg) {
      await shell(['am', 'force-stop', pkg]);
    },
    async start(args) {
      const out = await shell(['am', 'start', '-W', ...args]);
      if (/^Error/m.test(out))
        throw new DeviceCommandError('adb', ['-s', serial, 'shell', 'am', 'start', ...args], {
          code: 1,
          stdout: out,
          stderr: '',
        });
    },
    async launcherActivity(pkg) {
      return parseResolvedActivity(
        await shell([
          'cmd',
          'package',
          'resolve-activity',
          '--brief',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.LAUNCHER',
          pkg,
        ]),
      );
    },
    async reverse(devicePort, hostPort) {
      await adb(['reverse', `tcp:${String(devicePort)}`, `tcp:${String(hostPort)}`]);
    },
    async reverses() {
      return parseReverseList(await adb(['reverse', '--list']));
    },
    async removeReverse(devicePort) {
      await adb(['reverse', '--remove', `tcp:${String(devicePort)}`]);
    },
    async setLocation(at) {
      await adb(['emu', 'geo', 'fix', String(at.longitude), String(at.latitude)]);
    },
    async nightMode() {
      return parseNightMode(await shell(['cmd', 'uimode', 'night']));
    },
    async setNightMode(appearance) {
      await shell(['cmd', 'uimode', 'night', appearance === 'dark' ? 'yes' : 'no']);
    },
    async globalSetting(key) {
      const value = (await shell(['settings', 'get', 'global', key])).trim();
      return value === '' || value === 'null' ? undefined : value;
    },
    async putGlobalSetting(key, value) {
      await shell(['settings', 'put', 'global', key, value]);
    },
    async permission(action, pkg, permission) {
      await shell(['pm', action, pkg, permission]);
    },
    async clearPermissionFlags(pkg, permission) {
      await shell(['pm', 'clear-permission-flags', pkg, permission, 'user-set', 'user-fixed']);
    },
    async resetPermissions() {
      await shell(['pm', 'reset-permissions']);
    },
    now: () => new Date(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
  return tools;
}

/** Stops Maestro's on-device driver, which outlives a killed `maestro mcp` and then blocks `uiautomator` for anyone. */
export async function forceStopMaestro(tools: Pick<AdbTools, 'forceStop'>): Promise<void> {
  await tools.forceStop(MAESTRO_DRIVER_PACKAGE);
}
