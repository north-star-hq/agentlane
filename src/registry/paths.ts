import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Platform } from '../devices/backend.ts';
import { EMULATOR_NAME_PREFIX, envName, FORMER, POOL_NAME_PREFIX, TOOL } from '../name.ts';

export const STATE_DIR_ENV = envName('STATE_DIR');

/**
 * The registry's folder. On a Mac where 0.2.x keeps its registry and this version has none of its own, it is 0.2.x's
 * folder, because 0.2.x reads only that one: both versions then hand out ports, devices and browsers from one registry.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_DIR_ENV];
  if (override) return path.resolve(override);
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'state');
  const own = path.join(base, TOOL);
  const former = path.join(base, FORMER.tool);
  return !fs.existsSync(databasePath(own)) && fs.existsSync(databasePath(former)) ? former : own;
}

export interface DiskNames {
  /** The folder of per-lane folders. */
  lanes: string;
  /** The prefix of the driver's socket folder, when it moves to the temp folder. */
  tool: string;
  /** The prefix of the pool devices this version creates. */
  pool: Readonly<Record<Platform, string>>;
}

/** The names this version writes in a state folder: in 0.2.x's folder, 0.2.x's names, because 0.2.x reads them there. */
export function diskNames(dir: string): DiskNames {
  if (path.basename(dir) === FORMER.tool) {
    return {
      lanes: FORMER.lanesFolder,
      tool: FORMER.tool,
      pool: { ios: FORMER.poolNamePrefix, android: FORMER.emulatorNamePrefix },
    };
  }
  return { lanes: 'lanes', tool: TOOL, pool: { ios: POOL_NAME_PREFIX, android: EMULATOR_NAME_PREFIX } };
}

const POOL_NAMES: Readonly<Record<Platform, RegExp>> = {
  ios: new RegExp(`^(?:${POOL_NAME_PREFIX}|${FORMER.poolNamePrefix})[0-9a-f]{6}$`),
  android: new RegExp(`^(?:${EMULATOR_NAME_PREFIX}|${FORMER.emulatorNamePrefix})[0-9a-f]{6}$`),
};

/** Whether a device of this platform has a name the registry gives pool devices, in this version or 0.2.x. */
export function isPoolName(platform: Platform, name: string): boolean {
  return POOL_NAMES[platform].test(name);
}

export function lanesRoot(dir: string): string {
  return path.join(dir, diskNames(dir).lanes);
}

export function databasePath(dir: string): string {
  return path.join(dir, 'registry.sqlite');
}

export function configPath(dir: string): string {
  return path.join(dir, 'config.json');
}

export function lockHolderPath(dir: string): string {
  return path.join(dir, 'lock-holder.json');
}
