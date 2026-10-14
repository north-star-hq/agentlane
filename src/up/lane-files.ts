import fs from 'node:fs';
import path from 'node:path';
import type { InstalledBuild } from '../devices/variant.ts';
import { sweepMaestroRunLinks } from '../driver/maestro-runs.ts';
import { pruneDriverFiles } from '../driver/paths.ts';
import type { LaunchMode, ProjectPlatform } from '../project/config.ts';
import { lanesRoot } from '../registry/paths.ts';
import { HISTORY_KEEP_MS } from '../registry/registry.ts';

export const LANE_FILES_KEEP_MS = HISTORY_KEEP_MS;

export interface UpRecord {
  version: 1;
  lane: string;
  config: string;
  /** The platform `up` ran for last. */
  platform: ProjectPlatform;
  /** Every platform `up` brought this lane up for: a lane can hold a device and a browser at once. */
  platforms?: ProjectPlatform[];
  /** The mobile app's; null for a web lane. */
  bundleId: string | null;
  launch: LaunchMode | null;
  pinned: boolean;
  /** The emulator ports `up` reverse-forwarded to the Mac, which release removes. */
  reversed?: number[];
  /** The iOS build `up` installed last, so doctor can tell when another build replaced it. */
  installed?: InstalledBuild;
  updatedAt: number;
}

export function laneDir(stateDir: string, laneId: string): string {
  if (!/^[0-9a-f]{8}$/.test(laneId)) throw new Error(`'${laneId}' is not a lane id`);
  return path.join(lanesRoot(stateDir), laneId);
}

export function serviceLog(dir: string, service: string): string {
  return path.join(dir, `${service}.log`);
}

export function hookLog(dir: string, hook: string): string {
  return path.join(dir, 'hooks', `${hook}.log`);
}

function recordFile(dir: string): string {
  return path.join(dir, 'up.json');
}

export function readUpRecord(dir: string): UpRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(recordFile(dir), 'utf8')) as Partial<UpRecord>;
    return raw.version === 1 ? (raw as UpRecord) : null;
  } catch {
    return null;
  }
}

export function writeUpRecord(dir: string, record: UpRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = recordFile(dir);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function pruneLaneDirs(stateDir: string, liveIds: ReadonlySet<string>, now: number): string[] {
  const root = lanesRoot(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{8}$/.test(name) || liveIds.has(name)) continue;
    const dir = path.join(root, name);
    try {
      if (now - fs.statSync(dir).mtimeMs < LANE_FILES_KEEP_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      continue;
    }
  }
  return removed;
}

/**
 * Prunes everything kept per ended lane (its lane folder and its driver files) after the registry's 7 days, and the
 * links to its Maestro runs that the lane's maestro made where Maestro writes them.
 */
export function pruneEndedLaneFiles(
  stateDir: string,
  liveIds: ReadonlySet<string>,
  now: number,
  env: NodeJS.ProcessEnv,
): string[] {
  const removed = new Set([
    ...pruneLaneDirs(stateDir, liveIds, now),
    ...pruneDriverFiles(stateDir, liveIds, now, LANE_FILES_KEEP_MS),
  ]);
  sweepMaestroRunLinks(env, lanesRoot(stateDir));
  return [...removed];
}
