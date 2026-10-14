import path from 'node:path';

import {
  assertBundleId,
  assertHost,
  assertPort,
  assertScheme,
  DeviceStateError,
  requireBooted,
  requireDevice,
  requireInstalled,
} from './common.ts';
import type { SimTools } from './tools.ts';

export const SCHEME_APPROVAL_PLIST = 'com.apple.launchservices.schemeapproval.plist';
export const SCHEME_APPROVAL_PREFIX = 'com.apple.CoreSimulator.CoreSimulatorBridge-->';

export interface DevClientLinkOptions {
  scheme: string;
  port: number;
  host?: string;
}

export interface SchemeApprovalOptions {
  udid: string;
  scheme: string;
  bundleId: string;
}

export interface SchemeApprovalReport {
  file: string;
  key: string;
  before: string | undefined;
  readBack: string;
  changed: boolean;
  needsReboot: boolean;
}

export interface LaunchAppOptions {
  udid: string;
  bundleId: string;
  launchArgs?: readonly string[];
  launchAttempts?: number;
  launchPollMs?: number;
}

export interface LaunchAppReport {
  bundleId: string;
  args: string[];
  running: true;
}

export interface LaunchDevClientOptions extends LaunchAppOptions {
  port: number;
  host?: string;
}

export interface LaunchDevClientReport extends LaunchAppReport {
  initialUrl: string;
}

export class DevClientError extends DeviceStateError {
  override name = 'DevClientError';
}

export function metroUrl(port: number, host = 'localhost'): string {
  assertPort(port);
  assertHost(host);
  return `http://${host}:${String(port)}`;
}

export function devClientLink({ scheme, port, host }: DevClientLinkOptions): string {
  assertScheme(scheme);
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl(port, host))}`;
}

export function schemeApprovalFile(dataPath: string): string {
  return path.join(dataPath, 'Library', 'Preferences', SCHEME_APPROVAL_PLIST);
}

export function schemeApprovalKey(scheme: string): string {
  assertScheme(scheme);
  return `${SCHEME_APPROVAL_PREFIX}${scheme}`;
}

export async function readSchemeApproval(tools: SimTools, udid: string, scheme: string): Promise<string | undefined> {
  const device = await requireDevice(tools, udid);
  return tools.readPlistString(schemeApprovalFile(device.dataPath), schemeApprovalKey(scheme));
}

export async function ensureSchemeApproval(tools: SimTools, options: SchemeApprovalOptions): Promise<SchemeApprovalReport> {
  const { udid, scheme, bundleId } = options;
  assertBundleId(bundleId);
  const device = await requireDevice(tools, udid);
  const file = schemeApprovalFile(device.dataPath);
  const key = schemeApprovalKey(scheme);
  const before = await tools.readPlistString(file, key);
  if (before === bundleId) return { file, key, before, readBack: before, changed: false, needsReboot: false };

  await tools.writePlistString(file, key, bundleId);
  const readBack = await tools.readPlistString(file, key);
  if (readBack !== bundleId) {
    throw new DevClientError(`the '${scheme}' scheme approval in ${file} reads back '${readBack ?? 'nothing'}', not ${bundleId}`);
  }
  return { file, key, before, readBack, changed: true, needsReboot: device.state !== 'Shutdown' };
}

export async function rebootDevice(tools: SimTools, udid: string, settleMs = 3000): Promise<void> {
  await tools.shutdown(udid);
  await tools.boot(udid);
  await tools.sleep(settleMs);
  await requireBooted(tools, udid);
}

async function waitRunning(tools: SimTools, options: LaunchAppOptions, what: string, fix?: string): Promise<void> {
  const attempts = options.launchAttempts ?? 20;
  const pollMs = options.launchPollMs ?? 500;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await tools.appRunning(options.udid, options.bundleId)) return;
    await tools.sleep(pollMs);
  }
  throw new DevClientError(`${options.bundleId} is not running on ${options.udid} after ${what}`, fix);
}

async function relaunch(tools: SimTools, options: LaunchAppOptions, args: string[]): Promise<void> {
  await tools.terminate(options.udid, options.bundleId);
  await tools.launch(options.udid, options.bundleId, args);
  await waitRunning(tools, options, `launching it with [${args.join(' ')}]`);
}

export async function launchApp(tools: SimTools, options: LaunchAppOptions): Promise<LaunchAppReport> {
  await requireBooted(tools, options.udid);
  await requireInstalled(tools, options.udid, options.bundleId);
  const args = [...(options.launchArgs ?? [])];
  await relaunch(tools, options, args);
  return { bundleId: options.bundleId, args, running: true };
}

export async function launchDevClient(tools: SimTools, options: LaunchDevClientOptions): Promise<LaunchDevClientReport> {
  const initialUrl = metroUrl(options.port, options.host);
  const report = await launchApp(tools, { ...options, launchArgs: ['--initialUrl', initialUrl, ...(options.launchArgs ?? [])] });
  return { ...report, initialUrl };
}
