import type { DeviceInfo, SimTools } from './tools.ts';

export class DeviceStateError extends Error {
  override name = 'DeviceStateError';
  readonly fix: string | undefined;

  constructor(message: string, fix?: string) {
    super(fix ? `${message}. ${fix}` : message);
    this.fix = fix;
  }
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

export function assertUdid(udid: string): void {
  if (!UDID.test(udid)) throw new DeviceStateError(`'${udid}' is not a simulator UDID`);
}

export function assertBundleId(bundleId: string): void {
  if (!BUNDLE_ID.test(bundleId)) throw new DeviceStateError(`'${bundleId}' is not a bundle id`);
}

export function assertScheme(scheme: string): void {
  if (!SCHEME.test(scheme)) throw new DeviceStateError(`'${scheme}' is not a URL scheme`);
}

export function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeviceStateError(`${String(port)} is not a TCP port`);
}

export function assertHost(host: string): void {
  if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^\[[0-9A-Fa-f:]+\]$/.test(host))
    throw new DeviceStateError(`'${host}' is not a host name`);
}

export async function requireDevice(tools: SimTools, udid: string): Promise<DeviceInfo> {
  assertUdid(udid);
  const device = await tools.device(udid);
  if (!device) throw new DeviceStateError(`no simulator has UDID ${udid}`, "List them with 'xcrun simctl list devices'");
  return device;
}

export async function requireBooted(tools: SimTools, udid: string): Promise<DeviceInfo> {
  const device = await requireDevice(tools, udid);
  if (device.state !== 'Booted') {
    throw new DeviceStateError(
      `simulator ${udid} ('${device.name}') is ${device.state}, not Booted`,
      `Boot it with 'xcrun simctl boot ${udid}' and wait with 'xcrun simctl bootstatus ${udid} -b'`,
    );
  }
  return device;
}

export async function requireInstalled(tools: SimTools, udid: string, bundleId: string): Promise<void> {
  assertBundleId(bundleId);
  if (!(await tools.appInstalled(udid, bundleId))) {
    throw new DeviceStateError(
      `${bundleId} is not installed on ${udid}`,
      `Install the build first ('xcrun simctl install ${udid} <app>'); its preferences live in the app's own container`,
    );
  }
}
