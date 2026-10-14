import { assertBundleId, DeviceStateError, requireBooted, requireInstalled } from './common.ts';
import type { SimTools } from './tools.ts';

export interface DialDefault {
  key: string;
  value: string;
}

export interface DialDefaultsReport {
  written: DialDefault[];
  unchanged: DialDefault[];
}

export class DialDefaultError extends DeviceStateError {
  override name = 'DialDefaultError';
}

/** `-apiBaseUrl http://localhost:41200` as the defaults key `apiBaseUrl`, which is how NSUserDefaults reads a launch argument. */
export function dialDefaults(launchArgs: readonly string[]): DialDefault[] {
  const dials: DialDefault[] = [];
  for (let i = 0; i + 1 < launchArgs.length; i += 2) {
    const flag = launchArgs[i] ?? '';
    const value = launchArgs[i + 1] ?? '';
    if (/^-[A-Za-z0-9_.-]+$/.test(flag)) dials.push({ key: flag.slice(1), value });
  }
  return dials;
}

/**
 * Writes each dial into the app's own defaults and reads it back. A test driver that relaunches the app, as Maestro's
 * launchApp does, passes only its own arguments; the app's defaults outlast that relaunch, the way the bundler pin does.
 */
export async function writeDialDefaults(
  tools: SimTools,
  options: { udid: string; bundleId: string; dials: readonly DialDefault[] },
): Promise<DialDefaultsReport> {
  const { udid, bundleId, dials } = options;
  assertBundleId(bundleId);
  await requireBooted(tools, udid);
  await requireInstalled(tools, udid, bundleId);
  const report: DialDefaultsReport = { written: [], unchanged: [] };
  for (const dial of dials) {
    if ((await tools.readAppDefault(udid, bundleId, dial.key))?.trim() === dial.value) {
      report.unchanged.push(dial);
      continue;
    }
    await tools.writeAppDefault(udid, bundleId, dial.key, dial.value);
    const readBack = (await tools.readAppDefault(udid, bundleId, dial.key))?.trim();
    if (readBack !== dial.value) {
      throw new DialDefaultError(
        `${dial.key} in the defaults of ${bundleId} on ${udid} reads back '${readBack ?? 'nothing'}', not '${dial.value}'`,
        `Check the simulator is booted and ${bundleId} is installed, then retry`,
      );
    }
    report.written.push(dial);
  }
  return report;
}

export async function readDialDefault(tools: SimTools, udid: string, bundleId: string, key: string): Promise<string | undefined> {
  const value = (await tools.readAppDefault(udid, bundleId, key))?.trim();
  return value === '' ? undefined : value;
}

export async function clearDialDefaults(
  tools: SimTools,
  udid: string,
  bundleId: string,
  keys: readonly string[],
): Promise<string[]> {
  const cleared: string[] = [];
  for (const key of keys) {
    if ((await readDialDefault(tools, udid, bundleId, key)) === undefined) continue;
    await tools.deleteAppDefault(udid, bundleId, key);
    if ((await readDialDefault(tools, udid, bundleId, key)) !== undefined) {
      throw new DialDefaultError(`${key} in the defaults of ${bundleId} on ${udid} is still set after deleting it`);
    }
    cleared.push(key);
  }
  return cleared;
}
