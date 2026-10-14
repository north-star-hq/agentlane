import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { diskNames, lanesRoot } from '../registry/paths.ts';
import { DriverError } from './errors.ts';
import { isAlive } from './exec.ts';
import { lockHolder } from './lock.ts';

export interface EnginePaths {
  dir: string;
  socket: string;
  /** Where a stopping engine moves its socket while it accepts the calls already queued on it. */
  stoppingSocket: string;
  lock: string;
  log: string;
  steps: string;
  work: string;
  /** Held by a release in progress: no engine starts for the lane while its holder lives. */
  releasing: string;
  /** The labels the diff learned tick on their own, kept across engine restarts until the lane ends. */
  volatile: string;
  /** Written by an engine that stopped for lack of calls, so the next call can say it started cold. */
  idle: string;
  /** Screenshots kept with the lane's logs, which outlive the lane; `work` goes when the engine stops. */
  shots: string;
}

// sockaddr_un.sun_path holds 104 bytes on macOS and 108 on Linux, terminator included.
export const SUN_PATH_LIMIT = 100;

let cachedTemp: string | undefined;

export function perUserTemp(): string {
  if (cachedTemp !== undefined) return cachedTemp;
  let dir = '/tmp';
  if (process.platform === 'darwin') {
    const result = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
    const found = result.status === 0 ? result.stdout.trim() : '';
    if (found) dir = found;
  }
  cachedTemp = dir;
  return dir;
}

export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new DriverError(
      `${dir} holds the driver's sockets, so it must be a directory only you can open (mode 700, owned by you)`,
      `remove ${dir} and retry`,
    );
  }
  return dir;
}

/**
 * Where a lane's driver engine keeps its socket, lock, log and recorded steps. Everything sits in the registry's
 * state dir, except a socket whose path there would be too long for a Unix socket: that goes in a per-user temp
 * folder named by a hash of the state dir, so each registry still gets its own sockets.
 */
export function enginePaths(stateDir: string, laneId: string, temp: string = perUserTemp()): EnginePaths {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(laneId)) throw new Error(`'${laneId}' is not a lane id`);
  const dir = path.join(stateDir, 'driver');
  let sockets = dir;
  if (Buffer.byteLength(path.join(sockets, `${laneId}.sock`)) > SUN_PATH_LIMIT) {
    const digest = crypto.createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 16);
    sockets = path.join(temp, `${diskNames(stateDir).tool}-${digest}`);
  }
  return {
    dir,
    socket: path.join(sockets, `${laneId}.sock`),
    stoppingSocket: path.join(sockets, `${laneId}.stop`),
    lock: path.join(dir, `${laneId}.lock`),
    log: path.join(dir, `${laneId}.log`),
    steps: path.join(dir, `${laneId}.steps.jsonl`),
    work: path.join(dir, laneId),
    releasing: path.join(dir, `${laneId}.releasing`),
    volatile: path.join(dir, `${laneId}.volatile.json`),
    idle: path.join(dir, `${laneId}.idle.json`),
    shots: path.join(lanesRoot(stateDir), laneId, 'shots'),
  };
}

const LANE_FILE = /^([0-9a-f]{8})(?:\.[A-Za-z0-9.]+)?$/;

/**
 * Removes the driver files of lanes that are no longer live (logs, recorded steps, learned labels, stale locks
 * and working folders) once none of a lane's files has changed for `keepMs`. A lane whose engine still holds
 * its lock is left alone.
 */
export function pruneDriverFiles(stateDir: string, liveIds: ReadonlySet<string>, now: number, keepMs: number): string[] {
  const dir = path.join(stateDir, 'driver');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const byLane = new Map<string, string[]>();
  for (const name of names) {
    const id = LANE_FILE.exec(name)?.[1];
    if (id === undefined || liveIds.has(id)) continue;
    byLane.set(id, [...(byLane.get(id) ?? []), name]);
  }
  const removed: string[] = [];
  for (const [id, files] of byLane) {
    let newest = 0;
    try {
      for (const name of files) newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      continue;
    }
    if (now - newest < keepMs) continue;
    const lock = path.join(dir, `${id}.lock`);
    const holder = lockHolder(lock);
    if (holder && isAlive(holder.pid)) continue;
    for (const name of files) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}
