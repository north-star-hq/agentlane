import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clock } from '../../src/clock.ts';
import type { BackendDevice, DeviceBackend, DeviceSpec, Platform, SpecRequest } from '../../src/devices/backend.ts';
import { DeviceBackendError } from '../../src/devices/backend.ts';
import type { SystemImage } from '../../src/devices/emulator.ts';
import { MAESTRO_DRIVER_PACKAGE, resolveAndroidSpec } from '../../src/devices/emulator.ts';
import type { SimRuntime } from '../../src/devices/simctl.ts';
import { resolveSimSpec } from '../../src/devices/simctl.ts';
import type { ProcessIdentity, ProcessInfo, ProcessTable } from '../../src/processes.ts';
import type { Owner } from '../../src/registry/owner.ts';
import type { PortProbe } from '../../src/registry/ports.ts';

const iphone = (name: string) => ({
  identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replaceAll(' ', '-')}`,
  name,
  productFamily: 'iPhone',
});

export const CATALOG: SimRuntime[] = [
  {
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-1',
    name: 'iOS 26.1',
    version: '26.1',
    isAvailable: true,
    platform: 'iOS',
    supportedDeviceTypes: [iphone('iPhone 16'), iphone('iPhone 17')],
  },
  {
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    name: 'iOS 26.5',
    version: '26.5',
    isAvailable: true,
    platform: 'iOS',
    supportedDeviceTypes: [
      iphone('iPhone 17 Pro'),
      iphone('iPhone 17e'),
      iphone('iPhone Air'),
      iphone('iPhone 17'),
      iphone('iPhone 16'),
    ],
  },
];

export function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentlane-${label}-`));
}

export class FakeProcesses implements ProcessTable {
  private readonly table = new Map<number, { start: string; ppid: number; command: string }>();
  private nextPid = 40_000;
  private generation = 0;
  blind = false;

  spawn(command = 'fake', ppid = 1): ProcessIdentity {
    const pid = this.nextPid++;
    const start = `Mon Oct 12 00:00:00 2026 #${String(this.generation++)}`;
    this.table.set(pid, { start, ppid, command });
    return { pid, start };
  }

  tree(commands: readonly string[]): ProcessIdentity[] {
    const spawned: ProcessIdentity[] = [];
    for (const command of [...commands].reverse()) spawned.unshift(this.spawn(command, spawned[0]?.pid ?? 1));
    return spawned;
  }

  kill(pid: number): void {
    this.table.delete(pid);
  }

  recycle(pid: number): ProcessIdentity {
    const start = `Mon Oct 12 00:00:00 2026 #${String(this.generation++)}`;
    this.table.set(pid, { start, ppid: 1, command: 'fake' });
    return { pid, start };
  }

  startTimes(pids: readonly number[]): ReadonlyMap<number, string> | undefined {
    if (this.blind) return undefined;
    const found = new Map<number, string>();
    for (const pid of pids) {
      const entry = this.table.get(pid);
      if (entry !== undefined) found.set(pid, entry.start);
    }
    return found;
  }

  info(pid: number): ProcessInfo | undefined {
    const entry = this.table.get(pid);
    return entry === undefined ? undefined : { pid, ...entry };
  }

  cwd(): string | undefined {
    return undefined;
  }

  owner(): Owner {
    return { kind: 'process', process: this.spawn(), sessionId: null, threadId: null };
  }
}

export class FakeClock implements Clock {
  private t: number;
  private sleepers: { at: number; resolve: () => void }[] = [];

  constructor(start = Date.UTC(2026, 9, 12, 9, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => this.sleepers.push({ at: this.t + ms, resolve }));
  }

  get sleeping(): number {
    return this.sleepers.length;
  }

  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.sleepers.filter(s => s.at <= this.t);
    this.sleepers = this.sleepers.filter(s => s.at > this.t);
    for (const s of due) s.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

export class FakeProbe implements PortProbe {
  readonly busy = new Set<number>();
  gate: Promise<void> | null = null;

  async listening(ports: readonly number[]): Promise<ReadonlySet<number>> {
    if (this.gate) await this.gate;
    return new Set(ports.filter(p => this.busy.has(p)));
  }
}

interface StoredDevice extends BackendDevice {
  createdBy: 'registry' | 'hand';
  port?: number;
}

export const ANDROID_IMAGES: SystemImage[] = [
  {
    id: 'system-images;android-35;google_apis;arm64-v8a',
    api: '35',
    tag: 'google_apis',
    tagName: 'Google APIs',
    abi: 'arm64-v8a',
  },
  {
    id: 'system-images;android-36;google_apis;arm64-v8a',
    api: '36',
    tag: 'google_apis',
    tagName: 'Google APIs',
    abi: 'arm64-v8a',
  },
];

export class FakeDevices implements DeviceBackend {
  readonly platform: Platform;
  readonly dir: string;
  failCreate = false;
  failBoot = false;
  readonly calls: string[] = [];

  constructor(dir: string, platform: Platform = 'ios') {
    this.dir = dir;
    this.platform = platform;
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  get journal(): string {
    return path.join(this.dir, 'calls.log');
  }

  private record(...lines: string[]): void {
    this.calls.push(...lines);
    fs.appendFileSync(this.journal, `${lines.join('\n')}\n`);
  }

  private write(device: StoredDevice): void {
    const tmp = `${this.file(device.id)}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(device));
    fs.renameSync(tmp, this.file(device.id));
  }

  private read(id: string): StoredDevice | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as StoredDevice;
    } catch {
      return undefined;
    }
  }

  resolveSpec(request: SpecRequest): DeviceSpec {
    return this.platform === 'ios' ? resolveSimSpec(CATALOG, request) : resolveAndroidSpec(ANDROID_IMAGES, request, 'arm64-v8a');
  }

  all(): StoredDevice[] {
    return fs
      .readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => this.read(f.slice(0, -'.json'.length)))
      .filter((d): d is StoredDevice => d !== undefined);
  }

  list(): BackendDevice[] {
    return this.all().map(({ id, name, deviceType, runtime, booted, port }) => ({
      id,
      name,
      deviceType,
      runtime,
      booted,
      ...(booted && port !== undefined ? { serial: `emulator-${String(port)}` } : {}),
    }));
  }

  create(name: string, spec: DeviceSpec): string {
    this.record(`create ${name}`);
    if (this.failCreate) throw new DeviceBackendError('create failed (fake)');
    const id = this.platform === 'ios' ? randomUUID().toUpperCase() : name;
    this.write({ id, name, deviceType: spec.deviceType, runtime: spec.runtime, booted: false, createdBy: 'registry' });
    return id;
  }

  addByHand(name: string, booted: boolean, spec: DeviceSpec = this.resolveSpec({}), port?: number): string {
    const id = this.platform === 'ios' ? randomUUID().toUpperCase() : name;
    this.write({
      id,
      name,
      deviceType: spec.deviceType,
      runtime: spec.runtime,
      booted,
      createdBy: 'hand',
      ...(port ? { port } : {}),
    });
    return id;
  }

  delete(id: string): void {
    this.record(`delete ${id}`);
    fs.rmSync(this.file(id), { force: true });
  }

  shutdown(id: string): void {
    const device = this.read(id);
    if (this.platform === 'android') {
      if (!device?.booted) return;
      const serial = `emulator-${String(device.port)}`;
      this.record(`force-stop ${MAESTRO_DRIVER_PACKAGE} ${serial}`, `emu kill ${serial}`);
    } else {
      this.record(`shutdown ${id}`);
    }
    if (device) {
      const stopped: StoredDevice = { ...device, booted: false };
      delete stopped.port;
      this.write(stopped);
    }
  }

  async boot(id: string, consolePort?: number): Promise<void> {
    this.record(consolePort === undefined ? `boot ${id}` : `boot ${id} on ${String(consolePort)}`);
    await Promise.resolve();
    if (this.failBoot) throw new DeviceBackendError('boot failed (fake)');
    const device = this.read(id);
    if (!device) throw new DeviceBackendError(`no device ${id}`);
    if (this.platform === 'android') {
      if (consolePort === undefined) throw new DeviceBackendError(`no console port for ${id}`);
      if (device.booted && device.port !== consolePort) this.shutdown(id);
      this.write({ ...device, booted: true, port: consolePort });
      return;
    }
    this.write({ ...device, booted: true });
  }

  setBooted(id: string, booted: boolean): void {
    const device = this.read(id);
    if (device) this.write({ ...device, booted });
  }
}
