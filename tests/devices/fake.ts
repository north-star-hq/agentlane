import fs from 'node:fs';
import path from 'node:path';

import type { Appearance, Coordinate, DeviceInfo, SimTools, StatusBarFields } from '../../src/devices/index.ts';

export const UDID = 'FC2D4835-7AE5-4CEC-B354-DFE87A10A760';
export const OTHER_UDID = '06F68A96-4A55-41A4-B4F7-651DB85173BB';
export const CLOCK = new Date('2026-03-01T12:00:00.000Z');

export type Fault = 'location' | 'keyboard' | 'keyboard-intro' | 'status-bar' | 'appearance' | 'app-default' | 'plist';

interface App {
  defaults: Map<string, string>;
  running: boolean;
  launchArgs: string[];
  container?: string;
}

export const FAKE_BUNDLE_ID_FILE = 'bundle-id';

interface Device {
  info: DeviceInfo;
  bootedAt: number;
  location?: { coordinate: Coordinate; visibleAt: number; heardAt?: number };
  keyboardIntroShown?: boolean;
  statusBar: StatusBarFields;
  appearance: string;
  apps: Map<string, App>;
}

const APPROVAL_FILE = 'Library/Preferences/com.apple.launchservices.schemeapproval.plist';

const PIN_FIELDS_BY_FLAG: Record<string, [string, (value: string) => string]> = {
  '--time': ['Time', value => value],
  '--dataNetwork': ['DataNetworkType', value => (value === 'wifi' ? '11' : value)],
  '--wifiMode': ['WiFi Mode', value => (value === 'active' ? '3' : value)],
  '--wifiBars': ['WiFi Bars', value => value],
  '--cellularMode': ['Cell Mode', value => (value === 'active' ? '3' : value)],
  '--cellularBars': ['Cell Bars', value => value],
  '--batteryState': ['Battery State', value => (value === 'charged' ? '2' : value)],
  '--batteryLevel': ['Battery Level', value => value],
};

export class FakeSim implements SimTools {
  readonly calls: string[] = [];
  readonly faults = new Set<Fault>();
  readonly failing = new Map<string, Error>();
  readonly hostKeyboard = new Map<string, boolean>();
  readonly plists = new Map<string, Map<string, string>>();
  readonly devices = new Map<string, Device>();
  locationLagMs = 0;
  lostLocationSets = 0;
  crashesOnLaunch = false;
  private clock = CLOCK.getTime();

  addDevice(udid = UDID, state = 'Booted', name = 'agentlane-dev'): Device {
    const device: Device = {
      info: { udid, name, state, dataPath: `/sim/Devices/${udid}/data` },
      bootedAt: this.clock,
      statusBar: {},
      appearance: 'light',
      apps: new Map(),
    };
    this.devices.set(udid, device);
    return device;
  }

  install(bundleId: string, udid = UDID): App {
    const app: App = { defaults: new Map(), running: false, launchArgs: [] };
    this.get(udid).apps.set(bundleId, app);
    return app;
  }

  get(udid: string): Device {
    const device = this.devices.get(udid);
    if (!device) throw new Error(`fake: no device ${udid}`);
    return device;
  }

  mutations(): string[] {
    return this.calls.filter(call => /^(set|write|override|delete|launch|terminate|open|shutdown|boot|install)/.test(call));
  }

  private call(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))].join(' '));
    const failure = this.failing.get(name);
    if (failure) throw failure;
  }

  private booted(udid: string): Device {
    const device = this.get(udid);
    if (device.info.state !== 'Booted') throw new Error(`fake: ${udid} is not booted`);
    return device;
  }

  private app(udid: string, bundleId: string): App {
    const app = this.booted(udid).apps.get(bundleId);
    if (!app) throw new Error(`fake: ${bundleId} is not installed`);
    return app;
  }

  device(udid: string): Promise<DeviceInfo | undefined> {
    this.call('device', udid);
    const device = this.devices.get(udid);
    return Promise.resolve(device ? { ...device.info } : undefined);
  }

  setLocation(udid: string, at: Coordinate): Promise<void> {
    this.call('setLocation', udid, at);
    const device = this.booted(udid);
    if (this.lostLocationSets > 0) this.lostLocationSets -= 1;
    else if (!this.faults.has('location'))
      device.location = { coordinate: { ...at }, visibleAt: this.clock + this.locationLagMs };
    return Promise.resolve();
  }

  readLocation(udid: string, since: Date): Promise<Coordinate | undefined> {
    this.call('readLocation', udid, since.toISOString());
    const { location } = this.booted(udid);
    const visible =
      location !== undefined && location.visibleAt <= this.clock && since.getTime() <= (location.heardAt ?? this.clock);
    return Promise.resolve(visible ? { ...location.coordinate } : undefined);
  }

  readHardwareKeyboard(udid: string): Promise<boolean | undefined> {
    this.call('readHardwareKeyboard', udid);
    return Promise.resolve(this.hostKeyboard.get(udid));
  }

  writeHardwareKeyboard(udid: string, connected: boolean): Promise<void> {
    this.call('writeHardwareKeyboard', udid, connected);
    if (!this.faults.has('keyboard')) this.hostKeyboard.set(udid, connected);
    return Promise.resolve();
  }

  readKeyboardIntroShown(udid: string): Promise<boolean | undefined> {
    this.call('readKeyboardIntroShown', udid);
    return Promise.resolve(this.booted(udid).keyboardIntroShown);
  }

  writeKeyboardIntroShown(udid: string, shown: boolean): Promise<void> {
    this.call('writeKeyboardIntroShown', udid, shown);
    const device = this.booted(udid);
    if (!this.faults.has('keyboard-intro')) device.keyboardIntroShown = shown;
    return Promise.resolve();
  }

  overrideStatusBar(udid: string, flags: readonly string[]): Promise<void> {
    this.call('overrideStatusBar', udid, flags);
    const device = this.booted(udid);
    if (this.faults.has('status-bar')) return Promise.resolve();
    for (let i = 0; i < flags.length; i += 2) {
      const mapping = PIN_FIELDS_BY_FLAG[flags[i] ?? ''];
      const value = flags[i + 1];
      if (!mapping || value === undefined) throw new Error(`fake: unknown status bar flag ${String(flags[i])}`);
      device.statusBar[mapping[0]] = mapping[1](value);
    }
    device.statusBar['Operator Name'] = 'Carrier';
    return Promise.resolve();
  }

  readStatusBar(udid: string): Promise<StatusBarFields> {
    this.call('readStatusBar', udid);
    return Promise.resolve({ ...this.booted(udid).statusBar });
  }

  setAppearance(udid: string, appearance: Appearance): Promise<void> {
    this.call('setAppearance', udid, appearance);
    const device = this.booted(udid);
    if (!this.faults.has('appearance')) device.appearance = appearance;
    return Promise.resolve();
  }

  readAppearance(udid: string): Promise<string | undefined> {
    this.call('readAppearance', udid);
    return Promise.resolve(this.booted(udid).appearance);
  }

  appInstalled(udid: string, bundleId: string): Promise<boolean> {
    this.call('appInstalled', udid, bundleId);
    return Promise.resolve(this.booted(udid).apps.has(bundleId));
  }

  appRunning(udid: string, bundleId: string): Promise<boolean> {
    this.call('appRunning', udid, bundleId);
    return Promise.resolve(this.booted(udid).apps.get(bundleId)?.running ?? false);
  }

  installApp(udid: string, appPath: string): Promise<void> {
    this.call('installApp', udid, appPath);
    const device = this.booted(udid);
    const bundleId = fs.readFileSync(path.join(appPath, FAKE_BUNDLE_ID_FILE), 'utf8').trim();
    const app: App = device.apps.get(bundleId) ?? {
      defaults: new Map<string, string>(),
      running: false,
      launchArgs: [],
    };
    app.running = false;
    app.container = appPath;
    device.apps.set(bundleId, app);
    return Promise.resolve();
  }

  appContainer(udid: string, bundleId: string): Promise<string | undefined> {
    this.call('appContainer', udid, bundleId);
    return Promise.resolve(this.booted(udid).apps.get(bundleId)?.container);
  }

  appCommandLine(udid: string, bundleId: string): Promise<string | undefined> {
    this.call('appCommandLine', udid, bundleId);
    const app = this.booted(udid).apps.get(bundleId);
    return Promise.resolve(app?.running ? [`/fake/${bundleId}.app/app`, ...app.launchArgs].join(' ') : undefined);
  }

  readAppDefault(udid: string, bundleId: string, key: string): Promise<string | undefined> {
    this.call('readAppDefault', udid, bundleId, key);
    return Promise.resolve(this.app(udid, bundleId).defaults.get(key));
  }

  writeAppDefault(udid: string, bundleId: string, key: string, value: string): Promise<void> {
    this.call('writeAppDefault', udid, bundleId, key, value);
    const app = this.app(udid, bundleId);
    if (!this.faults.has('app-default')) app.defaults.set(key, value);
    return Promise.resolve();
  }

  deleteAppDefault(udid: string, bundleId: string, key: string): Promise<void> {
    this.call('deleteAppDefault', udid, bundleId, key);
    const app = this.app(udid, bundleId);
    if (!this.faults.has('app-default')) app.defaults.delete(key);
    return Promise.resolve();
  }

  readPlistString(file: string, key: string): Promise<string | undefined> {
    this.call('readPlistString', file, key);
    return Promise.resolve(this.plists.get(file)?.get(key));
  }

  writePlistString(file: string, key: string, value: string): Promise<void> {
    this.call('writePlistString', file, key, value);
    if (this.faults.has('plist')) return Promise.resolve();
    const plist = this.plists.get(file) ?? new Map<string, string>();
    plist.set(key, value);
    this.plists.set(file, plist);
    return Promise.resolve();
  }

  launch(udid: string, bundleId: string, args: readonly string[]): Promise<void> {
    this.call('launch', udid, bundleId, args);
    const app = this.app(udid, bundleId);
    app.running = !this.crashesOnLaunch;
    app.launchArgs = [...args];
    return Promise.resolve();
  }

  terminate(udid: string, bundleId: string): Promise<void> {
    this.call('terminate', udid, bundleId);
    const app = this.booted(udid).apps.get(bundleId);
    if (app) app.running = false;
    return Promise.resolve();
  }

  openUrl(udid: string, url: string): Promise<void> {
    this.call('openUrl', udid, url);
    this.booted(udid);
    return Promise.resolve();
  }

  shutdown(udid: string): Promise<void> {
    this.call('shutdown', udid);
    const device = this.booted(udid);
    device.info.state = 'Shutdown';
    for (const app of device.apps.values()) app.running = false;
    return Promise.resolve();
  }

  boot(udid: string): Promise<void> {
    this.call('boot', udid);
    const device = this.get(udid);
    device.info.state = 'Booted';
    device.bootedAt = this.clock;
    delete device.location;
    device.statusBar = {};
    return Promise.resolve();
  }

  approvalFile(udid = UDID): string {
    return path.join(this.get(udid).info.dataPath, APPROVAL_FILE);
  }

  now(): Date {
    return new Date(this.clock);
  }

  sleep(ms: number): Promise<void> {
    this.calls.push(`sleep ${String(ms)}`);
    this.clock += ms;
    return Promise.resolve();
  }
}
