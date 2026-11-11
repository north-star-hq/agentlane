import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FORMER, TOOL } from '../name.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { databasePath, lanesRoot, STATE_DIR_ENV } from '../registry/paths.ts';
import { bestEffort, tryLock, unlock } from './lock.ts';

/** Every running process's command line, or undefined when they can't be read. */
export type CommandLines = () => readonly string[] | undefined;

/** The command lines in `ps -o pid=,args=` output; undefined when it doesn't show pid 1, so it can't see every process. */
export function commandLinesOf(output: string): readonly string[] | undefined {
  const rows = output
    .split('\n')
    .map(line => /^\s*(\d+)\s?(.*)$/.exec(line))
    .filter(row => row !== null);
  if (!rows.some(([, pid]) => pid === '1')) return undefined;
  return rows.map(([, , args = '']) => args).filter(args => args.trim() !== '');
}

export const systemCommandLines: CommandLines = () => {
  const result = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], {
    encoding: 'utf8',
    env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  return commandLinesOf(result.stdout);
};

/** Every lane recorded in a registry: the text of its `bin/maestro`, or undefined when a registry can't be read. */
export type LaneMaestros = () => readonly string[] | undefined;

function registryDirs(env: NodeJS.ProcessEnv): string[] {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME ?? os.homedir(), '.local', 'state');
  const override = env[STATE_DIR_ENV];
  return [...new Set([...(override ? [path.resolve(override)] : []), path.join(base, TOOL), path.join(base, FORMER.tool)])];
}

function recordedLaneIds(dir: string): string[] | undefined {
  if (!fs.existsSync(databasePath(dir))) return [];
  try {
    const db = new DatabaseSync(databasePath(dir), { readOnly: true, timeout: 1000 });
    try {
      return db
        .prepare('SELECT id FROM claims')
        .all()
        .map(row => String(row.id));
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function readIfThere(file: string): string | null | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
}

/** The `bin/maestro` of every lane recorded in this version's registry or 0.2.x's, read without writing to either. */
export function laneMaestrosOf(env: NodeJS.ProcessEnv): LaneMaestros {
  return () => {
    const shims: string[] = [];
    for (const dir of registryDirs(env)) {
      const ids = recordedLaneIds(dir);
      if (ids === undefined) return undefined;
      for (const id of ids) {
        const shim = readIfThere(path.join(lanesRoot(dir), id, 'bin', 'maestro'));
        if (shim === undefined) return undefined;
        if (shim !== null) shims.push(shim);
      }
    }
    return shims;
  };
}

const BUILD_TAGS = [FORMER.tool.replaceAll('-', ''), TOOL];

interface Version {
  release: string[];
  prerelease: string[] | undefined;
  /** This toolkit's own build of the release: the tag's rank among the toolkit's names, then its number. */
  build: [number, string] | undefined;
}

function parseVersion(version: string): Version {
  const [plain = ''] = version.split('+');
  const tagged = new RegExp(`^(.*)-(${BUILD_TAGS.join('|')})\\.([0-9A-Za-z-]+)$`).exec(plain);
  const core = tagged?.[1] ?? plain;
  const dash = core.indexOf('-');
  return {
    release: (dash === -1 ? core : core.slice(0, dash)).split('.'),
    prerelease: dash === -1 ? undefined : core.slice(dash + 1).split('.'),
    build: tagged ? [BUILD_TAGS.indexOf(tagged[2] ?? ''), tagged[3] ?? ''] : undefined,
  };
}

function compareParts(x: string, y: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
  if (numeric.test(x)) return -1;
  if (numeric.test(y)) return 1;
  return x === y ? 0 : x < y ? -1 : 1;
}

function compareLists(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareParts(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Orders versions as semver does, a prerelease before its release, with this toolkit's own builds of a release after
 * it: 1.65.0-alpha < 1.65.0 < 1.65.0-agentenv.3 < 1.65.0-agentlane.1 < 1.65.0-agentlane.2 < 1.66.0.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const release = compareLists(left.release, right.release);
  if (release !== 0) return release;
  if (left.prerelease === undefined || right.prerelease === undefined) {
    if (left.prerelease !== right.prerelease) return left.prerelease === undefined ? 1 : -1;
  } else {
    const prerelease = compareLists(left.prerelease, right.prerelease);
    if (prerelease !== 0) return prerelease;
  }
  if (left.build === undefined || right.build === undefined) {
    return left.build === right.build ? 0 : left.build === undefined ? -1 : 1;
  }
  return left.build[0] - right.build[0] || compareParts(left.build[1], right.build[1]);
}

export interface OlderVersion {
  dir: string;
  /** The lock an install of this version holds; one held by another live process keeps the version. */
  lock?: string;
  /** Other candidates' folders this version runs, which stay while it does. */
  needs?: readonly string[];
}

export interface RemoveOptions {
  /** The folder every removal must sit inside; undefined when the environment doesn't name one, which removes nothing. */
  root: string | undefined;
  me: ProcessIdentity;
  processes: ProcessTable;
  commandLines: CommandLines;
  laneMaestros: LaneMaestros;
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
 * Removes the older versions that no running process names on its command line, no recorded lane's `maestro` names,
 * no other process is installing and no kept version needs. Returns the folders removed.
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
  const shims = options.laneMaestros();
  if (shims === undefined) {
    options.log(`kept ${older.map(v => v.dir).join(', ')}: a registry could not say whether a lane uses them`);
    return [];
  }
  const needed = new Set<string>();
  const keep = (version: OlderVersion, why: string) => {
    for (const dir of version.needs ?? []) needed.add(dir);
    options.log(`kept ${version.dir}, ${why}`);
  };
  const removed: string[] = [];
  for (const version of [...older.filter(v => v.needs), ...older.filter(v => !v.needs)]) {
    if (needed.has(version.dir)) {
      options.log(`kept ${version.dir}, which a kept version runs`);
      continue;
    }
    if (inUse(version.dir, commands)) {
      keep(version, 'which a running process uses');
      continue;
    }
    if (inUse(version.dir, shims)) {
      keep(version, 'which a lane that is up runs');
      continue;
    }
    if (version.lock !== undefined && !lockFor(version.lock, options)) {
      keep(version, 'which another process is installing');
      continue;
    }
    const aside = path.join(path.dirname(version.dir), `${REMOVING}${path.basename(version.dir)}-${String(process.pid)}`);
    const moved = bestEffort(() => {
      fs.renameSync(version.dir, aside);
    });
    if (version.lock !== undefined) unlock(version.lock, options.me);
    if (!moved) {
      for (const dir of version.needs ?? []) needed.add(dir);
      continue;
    }
    bestEffort(() => {
      fs.rmSync(aside, { recursive: true, force: true });
    });
    removed.push(version.dir);
    options.log(`removed ${version.dir}, which this version supersedes`);
  }
  return removed;
}
