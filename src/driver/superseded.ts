import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { bestEffort, tryLock, unlock } from './lock.ts';

/** Every running process's command line, or undefined when they can't be read. */
export type CommandLines = () => readonly string[] | undefined;

export const systemCommandLines: CommandLines = () => {
  const result = spawnSync('ps', ['-A', '-ww', '-o', 'args='], {
    encoding: 'utf8',
    env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.split('\n').filter(line => line.trim() !== '');
};

/** Orders versions by their dot- or dash-separated parts, numbers as numbers: 2.9.0 < 2.11.0 < 2.11.0-x.1 < 2.11.0-x.2. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.\-+_]/);
  const right = b.split(/[.\-+_]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x)) return -1;
    if (numeric.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export interface OlderVersion {
  dir: string;
  /** The lock an install of this version holds; one held by another live process keeps the version. */
  lock?: string;
}

export interface RemoveOptions {
  /** The folder every removal must sit inside; undefined when the environment doesn't name one, which removes nothing. */
  root: string | undefined;
  me: ProcessIdentity;
  processes: ProcessTable;
  commandLines: CommandLines;
  log: (line: string) => void;
}

const REMOVING = '.removing-';

function inUse(dir: string, commands: readonly string[]): boolean {
  const names = new Set([dir]);
  bestEffort(() => {
    names.add(fs.realpathSync(dir));
  });
  return commands.some(command => [...names].some(name => command.includes(`${name}${path.sep}`) || command.endsWith(name)));
}

/** Folders a removal was interrupted in, under the folders the versions sit in. */
function sweepInterrupted(parents: ReadonlySet<string>): void {
  for (const parent of parents) {
    let names: string[];
    try {
      names = fs.readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names.filter(n => n.startsWith(REMOVING))) {
      bestEffort(() => {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      });
    }
  }
}

function lockFor(lock: string, options: RemoveOptions): boolean {
  try {
    return tryLock(lock, options.me, options.processes).acquired;
  } catch {
    return false;
  }
}

function realOrResolved(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function inside(root: string, dir: string): boolean {
  return [
    [path.resolve(root), path.resolve(dir)],
    [realOrResolved(root), realOrResolved(dir)],
  ].every(([r = '', d = '']) => {
    const relative = path.relative(r, d);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

/**
 * Removes the older versions no running process names on its command line and no other process is installing.
 * Moving each aside first means a reader sees the version whole or not at all. Returns the folders removed.
 */
export function removeOlderVersions(candidates: readonly OlderVersion[], options: RemoveOptions): string[] {
  if (candidates.length === 0) return [];
  const { root } = options;
  if (root === undefined) {
    options.log(`kept ${candidates.map(v => v.dir).join(', ')}: neither HOME nor XDG_DATA_HOME is set`);
    return [];
  }
  const older = candidates.filter(version => inside(root, version.dir));
  sweepInterrupted(new Set(older.map(version => path.dirname(version.dir))));
  if (older.length === 0) return [];
  const commands = options.commandLines();
  if (commands === undefined) {
    options.log(`kept ${older.map(v => v.dir).join(', ')}: ps could not say whether a running process uses them`);
    return [];
  }
  const removed: string[] = [];
  for (const version of older) {
    if (inUse(version.dir, commands)) {
      options.log(`kept ${version.dir}, which a running process uses`);
      continue;
    }
    if (version.lock !== undefined && !lockFor(version.lock, options)) {
      options.log(`kept ${version.dir}, which another process is installing`);
      continue;
    }
    const aside = path.join(path.dirname(version.dir), `${REMOVING}${path.basename(version.dir)}-${String(process.pid)}`);
    const moved = bestEffort(() => {
      fs.renameSync(version.dir, aside);
    });
    if (version.lock !== undefined) unlock(version.lock, options.me);
    if (!moved) continue;
    bestEffort(() => {
      fs.rmSync(aside, { recursive: true, force: true });
    });
    removed.push(version.dir);
    options.log(`removed ${version.dir}, which this version supersedes`);
  }
  return removed;
}
