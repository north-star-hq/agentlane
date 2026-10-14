import { assertBundleId, assertHost, assertPort, DeviceStateError, requireBooted, requireInstalled } from './common.ts';
import type { SimTools } from './tools.ts';

export const BUNDLER_PIN_KEY = 'RCT_jsLocation';
export const REACT_NATIVE_DEFAULT_PORT = 8081;

export interface BundlerPinOptions {
  udid: string;
  bundleId: string;
  port: number;
  host?: string;
}

export interface BundlerPinReport {
  udid: string;
  bundleId: string;
  wanted: string;
  before: string | undefined;
  readBack: string;
  changed: boolean;
}

export class BundlerPinError extends DeviceStateError {
  override name = 'BundlerPinError';
}

export function bundlerLocation(port: number, host = 'localhost'): string {
  assertPort(port);
  assertHost(host);
  return `${host}:${String(port)}`;
}

export async function readBundlerPin(tools: SimTools, udid: string, bundleId: string): Promise<string | undefined> {
  assertBundleId(bundleId);
  const value = (await tools.readAppDefault(udid, bundleId, BUNDLER_PIN_KEY))?.replace(/\s+/g, '');
  return value === '' ? undefined : value;
}

export async function pinBundler(tools: SimTools, options: BundlerPinOptions): Promise<BundlerPinReport> {
  const { udid, bundleId, port } = options;
  const wanted = bundlerLocation(port, options.host);
  if (port === REACT_NATIVE_DEFAULT_PORT) {
    throw new BundlerPinError(
      `refusing to pin ${bundleId} to port ${String(REACT_NATIVE_DEFAULT_PORT)}`,
      "that is React Native's fallback, which every unpinned Debug app dials; pin the lane's own Metro port",
    );
  }
  await requireBooted(tools, udid);
  await requireInstalled(tools, udid, bundleId);

  const before = await readBundlerPin(tools, udid, bundleId);
  if (before === wanted) return { udid, bundleId, wanted, before, readBack: before, changed: false };

  await tools.writeAppDefault(udid, bundleId, BUNDLER_PIN_KEY, wanted);
  const readBack = await readBundlerPin(tools, udid, bundleId);
  if (readBack !== wanted) {
    throw new BundlerPinError(
      `the bundler pin did not take on ${udid}: ${BUNDLER_PIN_KEY} for ${bundleId} reads back '${readBack ?? 'nothing'}', not '${wanted}'`,
      `Without it a Debug build dials port ${String(REACT_NATIVE_DEFAULT_PORT)}. Check the simulator is booted and ${bundleId} is installed, then retry`,
    );
  }
  return { udid, bundleId, wanted, before, readBack, changed: true };
}

export async function clearBundlerPin(tools: SimTools, udid: string, bundleId: string): Promise<{ changed: boolean }> {
  await requireBooted(tools, udid);
  const before = await readBundlerPin(tools, udid, bundleId);
  if (before === undefined) return { changed: false };
  await tools.deleteAppDefault(udid, bundleId, BUNDLER_PIN_KEY);
  const after = await readBundlerPin(tools, udid, bundleId);
  if (after !== undefined) {
    throw new BundlerPinError(`the bundler pin for ${bundleId} on ${udid} still reads '${after}' after deleting it`);
  }
  return { changed: true };
}
