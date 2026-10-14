import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { UsageError } from '../registry/refusal.ts';
import type { BackendDevice, DeviceBackend, DeviceSpec, SpecRequest } from './backend.ts';
import { DeviceBackendError } from './backend.ts';

export interface SimDeviceType {
  identifier: string;
  name: string;
  productFamily?: string;
}

export interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
  isAvailable: boolean;
  platform?: string;
  supportedDeviceTypes?: SimDeviceType[];
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  deviceTypeIdentifier?: string;
  isAvailable?: boolean;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const execFileAsync = promisify(execFile);

function simctl(args: string[], timeoutMs = 60_000): string {
  try {
    return execFileSync('xcrun', ['simctl', ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new UsageError(
        'xcrun is not on PATH, so iOS simulators are unavailable',
        'install Xcode, or claim without a device (--no-device)',
      );
    }
    throw new DeviceBackendError(`xcrun simctl ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function newestIphone(types: readonly SimDeviceType[]): SimDeviceType | undefined {
  const iphones = types.filter(t => t.productFamily === 'iPhone' || t.name.startsWith('iPhone'));
  const generation = (t: SimDeviceType) => Number(/^iPhone (\d+)/.exec(t.name)?.[1] ?? -1);
  const newest = Math.max(...iphones.map(generation));
  const candidates = iphones.filter(t => generation(t) === newest);
  return candidates.find(t => t.name === `iPhone ${String(newest)}`) ?? candidates[0];
}

function matches(wanted: string, ...names: string[]): boolean {
  const w = wanted.trim().toLowerCase();
  return names.some(n => n.toLowerCase() === w);
}

export function resolveSimSpec(runtimes: readonly SimRuntime[], request: SpecRequest): DeviceSpec {
  const ios = runtimes.filter(r => r.isAvailable && (r.platform === 'iOS' || r.identifier.includes('SimRuntime.iOS-')));
  if (ios.length === 0) {
    throw new UsageError('no iOS simulator runtime is installed', 'install one with: xcodebuild -downloadPlatform iOS');
  }
  const runtime = request.runtime
    ? ios.find(r => matches(request.runtime ?? '', r.identifier, r.name, r.version))
    : [...ios].sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!runtime) {
    throw new UsageError(
      `no installed iOS runtime matches '${request.runtime ?? ''}'`,
      `pass --runtime with one of: ${ios.map(r => r.name).join(', ')}`,
    );
  }
  const types = runtime.supportedDeviceTypes ?? [];
  const deviceType = request.deviceType
    ? types.find(t => matches(request.deviceType ?? '', t.identifier, t.name))
    : newestIphone(types);
  if (!deviceType) {
    const iphones = types.filter(t => t.productFamily === 'iPhone').map(t => t.name);
    throw new UsageError(
      `${runtime.name} has no device type '${request.deviceType ?? 'iPhone'}'`,
      `pass --device-type with one of: ${iphones.join(', ') || '(none listed)'}`,
    );
  }
  return {
    deviceType: deviceType.identifier,
    deviceTypeName: deviceType.name,
    runtime: runtime.identifier,
    runtimeName: runtime.name,
  };
}

export function parseDeviceList(json: string): BackendDevice[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, SimDevice[]> };
  const devices: BackendDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    if (!runtime.includes('SimRuntime.iOS-')) continue;
    for (const d of list) {
      devices.push({ id: d.udid, name: d.name, deviceType: d.deviceTypeIdentifier ?? '', runtime, booted: d.state === 'Booted' });
    }
  }
  return devices;
}

export const simctlBackend: DeviceBackend = {
  platform: 'ios',

  resolveSpec(request) {
    const parsed = JSON.parse(simctl(['list', '-j', 'runtimes'])) as { runtimes?: SimRuntime[] };
    return resolveSimSpec(parsed.runtimes ?? [], request);
  },

  list() {
    return parseDeviceList(simctl(['list', '-j', 'devices']));
  },

  create(name, spec) {
    const udid = simctl(['create', name, spec.deviceType, spec.runtime], 120_000).trim();
    if (!UDID.test(udid)) throw new DeviceBackendError(`xcrun simctl create printed '${udid}', not a UDID`);
    return udid;
  },

  delete(id) {
    simctl(['delete', id], 120_000);
  },

  shutdown(id) {
    try {
      simctl(['shutdown', id], 120_000);
    } catch (error) {
      if (error instanceof DeviceBackendError && error.message.includes('current state: Shutdown')) return;
      throw error;
    }
  },

  async boot(id) {
    try {
      await execFileAsync('xcrun', ['simctl', 'bootstatus', id, '-b'], { timeout: 300_000 });
    } catch (error) {
      const e = error as Error & { stderr?: string };
      throw new DeviceBackendError(`xcrun simctl bootstatus ${id} -b failed: ${(e.stderr ?? e.message).trim()}`);
    }
  },
};
