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

/**
 * The command lines in `ps -o pid=,args=` output; undefined unless it shows pid 1's arguments, so it can't see every
 * process. macOS ps prints a process's name in parentheses in place of arguments it may not read.
 */
export function commandLinesOf(output: string): readonly string[] | undefined {
  const rows = output
    .split('\n')
    .map(line => /^\s*(\d+)\s?(.*)$/.exec(line))
    .filter(row => row !== null);
  if (!rows.some(([, pid, args = '']) => pid === '1' && args.startsWith('/'))) return undefined;
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

/**
 * What each lane recorded in a registry runs, one list a lane: the text, link target and real path of each file in its
 * `bin/`, and where its `browser/ffmpeg/ffmpeg` points; undefined when a registry or a lane's files can't be read.
 */
export type LaneTools = () => readonly (readonly string[])[] | undefined;

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

function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function linkTarget(link: string): string | undefined {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch (error) {
    if (absent(error) || (error as NodeJS.ErrnoException).code === 'EINVAL') return undefined;
    throw error;
  }
}

function realPath(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}

function targetsOf(file: string): string[] {
  return [linkTarget(file), realPath(file)].filter(target => target !== undefined);
}

function laneNames(lane: string): string[] {
  const names: string[] = [];
  const bin = path.join(lane, 'bin');
  let files: string[] = [];
  try {
    files = fs.readdirSync(bin);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  for (const name of files) {
    const file = path.join(bin, name);
    names.push(...targetsOf(file));
    try {
      names.push(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  names.push(...targetsOf(path.join(lane, 'browser', 'ffmpeg', 'ffmpeg')));
  return names;
}

/**
 * What every lane recorded in this version's registry or 0.2.x's runs. Each registry is opened read-only, which never
 * changes its data, though SQLite creates the database's `-shm` and `-wal` files beside it when they are missing.
 */
export function laneToolsOf(env: NodeJS.ProcessEnv): LaneTools {
  return () => {
    const lanes: string[][] = [];
    for (const dir of registryDirs(env)) {
      const ids = recordedLaneIds(dir);
      if (ids === undefined) return undefined;
      for (const id of ids) {
        try {
          lanes.push(laneNames(path.join(lanesRoot(dir), id)));
        } catch {
          return undefined;
        }
      }
    }
    return lanes;
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

/**
 * A tool whose versions find what they launch outside their command line and files, as agent-browser finds its browser
 * through a variable. A running process or recorded lane that names one of its versions and none of `launches` keeps
 * everything in `needs`.
 */
export interface Launcher {
  /** The folder the tool's versions are installed in. */
  dir: string;
  /** Folders the tool can launch; a user that names one of them has said what it runs. */
  launches: readonly string[];
  needs: readonly string[];
}

export interface RemoveOptions {
  /** The folder every removal must sit inside; undefined when the environment doesn't name one, which removes nothing. */
  root: string | undefined;
  me: ProcessIdentity;
  processes: ProcessTable;
  commandLines: CommandLines;
  laneTools: LaneTools;
  launchers?: readonly Launcher[];
  log: (line: string) => void;
}

const REMOVING = '.removing-';

function spellingsOf(dir: string): string[] {
  const names = new Set([dir]);
  bestEffort(() => {
    names.add(fs.realpathSync(dir));
  });
  return [...names];
}

function mentions(spellings: readonly string[], texts: readonly string[]): boolean {
  return texts.some(text => spellings.some(name => text.includes(`${name}${path.sep}`) || text.endsWith(name)));
}

function inUse(dir: string, texts: readonly string[]): boolean {
  return mentions(spellingsOf(dir), texts);
}

/** What the launchers' users that don't name what they launch keep, with why. */
function launched(launchers: readonly Launcher[], users: readonly (readonly string[])[]): Map<string, string> {
  const needed = new Map<string, string>();
  for (const launcher of launchers) {
    const tool = spellingsOf(launcher.dir);
    const launches = launcher.launches.map(spellingsOf);
    if (users.some(user => mentions(tool, user) && !launches.some(dir => mentions(dir, user)))) {
      for (const dir of launcher.needs) needed.set(dir, `which ${path.basename(launcher.dir)} may run`);
    }
  }
  return needed;
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
 * Removes the older versions that no running process names on its command line, no recorded lane's files name,
 * no other process is installing, no kept version needs and no launcher may run. Returns the folders removed.
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
  const lanes = options.laneTools();
  if (lanes === undefined) {
    options.log(`kept ${older.map(v => v.dir).join(', ')}: a registry could not say whether a lane uses them`);
    return [];
  }
  const needed = launched(options.launchers ?? [], [...commands.map(command => [command]), ...lanes]);
  const neededBy = (version: OlderVersion) => {
    for (const dir of version.needs ?? []) needed.set(dir, 'which a kept version runs');
  };
  const keep = (version: OlderVersion, why: string) => {
    neededBy(version);
    options.log(`kept ${version.dir}, ${why}`);
  };
  const laneTexts = lanes.flat();
  const removed: string[] = [];
  for (const version of [...older.filter(v => v.needs), ...older.filter(v => !v.needs)]) {
    const why = needed.get(version.dir);
    if (why !== undefined) {
      options.log(`kept ${version.dir}, ${why}`);
      continue;
    }
    if (inUse(version.dir, commands)) {
      keep(version, 'which a running process uses');
      continue;
    }
    if (inUse(version.dir, laneTexts)) {
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
      neededBy(version);
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
