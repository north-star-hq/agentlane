import fs from 'node:fs';
import type { AdbTools } from '../../src/devices/adb.ts';
import type { Appearance, Coordinate } from '../../src/devices/tools.ts';

/** An in-memory emulator behind the AdbTools interface: what up, doctor, release and the device controls ran. */
export class FakeAdb implements AdbTools {
  readonly serial: string;
  booted = true;
  readonly installed = new Map<string, string[]>();
  readonly notDebuggable = new Set<string>();
  readonly running = new Set<string>();
  readonly reverseRules = new Map<number, number>();
  night: Appearance = 'light';
  readonly globals = new Map<string, string>([
    ['window_animation_scale', '1.0'],
    ['transition_animation_scale', '1.0'],
  ]);
  location: Coordinate | undefined;
  readonly calls: string[] = [];
  readonly starts: string[][] = [];
  readonly declared = new Map<string, Set<string>>();
  readonly granted = new Map<string, Set<string>>();
  stickyNight = false;

  constructor(serial: string) {
    this.serial = serial;
  }

  private call(line: string): void {
    this.calls.push(line);
  }

  bootCompleted(): Promise<boolean> {
    return Promise.resolve(this.booted);
  }
  appInstalled(pkg: string): Promise<boolean> {
    return Promise.resolve(this.installed.has(pkg));
  }
  appRunning(pkg: string): Promise<boolean> {
    return Promise.resolve(this.running.has(pkg));
  }
  installedApk(pkg: string): Promise<string[]> {
    return Promise.resolve(this.installed.get(pkg) ?? []);
  }
  debuggable(pkg: string): Promise<boolean | undefined> {
    return Promise.resolve(this.installed.has(pkg) ? !this.notDebuggable.has(pkg) : undefined);
  }
  pull(remote: string, local: string): Promise<void> {
    this.call(`pull ${remote}`);
    fs.writeFileSync(local, `apk ${remote}`);
    return Promise.resolve();
  }
  install(apk: string): Promise<void> {
    this.call(`install ${apk}`);
    const pkg = fs.readFileSync(apk, 'utf8').trim();
    this.installed.set(pkg, [`/data/app/${pkg}/base.apk`]);
    return Promise.resolve();
  }
  forceStop(pkg: string): Promise<void> {
    this.call(`force-stop ${pkg}`);
    this.running.delete(pkg);
    return Promise.resolve();
  }
  start(args: readonly string[]): Promise<void> {
    this.call(`am start ${args.join(' ')}`);
    this.starts.push([...args]);
    const last = args.at(-1) ?? '';
    const component = args[args.indexOf('-n') + 1];
    const pkg = args.includes('-n') && component ? (component.split('/')[0] ?? '') : last;
    if (this.installed.has(pkg)) this.running.add(pkg);
    return Promise.resolve();
  }
  launcherActivity(pkg: string): Promise<string | undefined> {
    return Promise.resolve(this.installed.has(pkg) ? `${pkg}/.MainActivity` : undefined);
  }
  reverse(devicePort: number, hostPort: number): Promise<void> {
    this.call(`reverse tcp:${String(devicePort)} tcp:${String(hostPort)}`);
    this.reverseRules.set(devicePort, hostPort);
    return Promise.resolve();
  }
  reverses(): Promise<Map<number, number>> {
    return Promise.resolve(new Map(this.reverseRules));
  }
  removeReverse(devicePort: number): Promise<void> {
    this.call(`reverse --remove tcp:${String(devicePort)}`);
    this.reverseRules.delete(devicePort);
    return Promise.resolve();
  }
  setLocation(at: Coordinate): Promise<void> {
    this.call(`emu geo fix ${String(at.longitude)} ${String(at.latitude)}`);
    this.location = at;
    return Promise.resolve();
  }
  nightMode(): Promise<Appearance | undefined> {
    return Promise.resolve(this.night);
  }
  setNightMode(appearance: Appearance): Promise<void> {
    this.call(`uimode night ${appearance === 'dark' ? 'yes' : 'no'}`);
    if (!this.stickyNight) this.night = appearance;
    return Promise.resolve();
  }
  globalSetting(key: string): Promise<string | undefined> {
    return Promise.resolve(this.globals.get(key));
  }
  putGlobalSetting(key: string, value: string): Promise<void> {
    this.call(`settings put global ${key} ${value}`);
    this.globals.set(key, value);
    return Promise.resolve();
  }
  permission(action: 'grant' | 'revoke', pkg: string, permission: string): Promise<void> {
    this.call(`pm ${action} ${pkg} ${permission}`);
    if (!this.declared.get(pkg)?.has(permission)) {
      return Promise.reject(new Error(`Package ${pkg} has not requested permission ${permission}`));
    }
    const set = this.granted.get(pkg) ?? new Set<string>();
    if (action === 'grant') set.add(permission);
    else set.delete(permission);
    this.granted.set(pkg, set);
    return Promise.resolve();
  }
  clearPermissionFlags(pkg: string, permission: string): Promise<void> {
    this.call(`pm clear-permission-flags ${pkg} ${permission}`);
    return Promise.resolve();
  }
  resetPermissions(): Promise<void> {
    this.call('pm reset-permissions');
    this.granted.clear();
    return Promise.resolve();
  }
  now(): Date {
    return new Date();
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
}
