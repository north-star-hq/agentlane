import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { envName, FORMER } from '../../src/name.ts';

/** The temp root this process and the processes it starts keep every home-derived folder in. */
export const ROOT_ENV = 'LANE_TESTS_ROOT';
/** The temp folder the test run started with, where the roots live; shared by every test process on the host. */
export const HOST_TEMP_ENV = 'LANE_TESTS_HOST_TEMP';

const OWNER_FILE = '.owner';
const ROOT_PREFIX = 'lt';
const ROOT_NAME = /^lt[A-Za-z0-9]{6}$/;

const REDIRECTED = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  envName('STATE_DIR'),
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'TMPDIR',
  envName('USER_TEMP'),
];

const CLEARED = [
  'ANDROID_USER_HOME',
  'ANDROID_AVD_HOME',
  'ANDROID_SDK_HOME',
  'ANDROID_EMULATOR_HOME',
  `${FORMER.envPrefix}_STATE_DIR`,
];

const INHERITED = ['HOME', 'TMPDIR', envName('USER_TEMP'), ROOT_ENV, HOST_TEMP_ENV];

const ownerEnvironment: NodeJS.ProcessEnv = { ...process.env };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerPid(root: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, OWNER_FILE), 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function removeRootOwnerFileLast(root: string): void {
  for (const name of fs.readdirSync(root)) {
    if (name !== OWNER_FILE) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function sweepDeadRoots(host: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(host);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!ROOT_NAME.test(name)) continue;
    const root = path.join(host, name);
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      const pid = ownerPid(root);
      if (pid !== null && !isAlive(pid)) removeRootOwnerFileLast(root);
    } catch {
      continue;
    }
  }
}

function isDirectory(dir: string | undefined): dir is string {
  try {
    return dir !== undefined && path.isAbsolute(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function createRoot(): string {
  const inherited = process.env[HOST_TEMP_ENV];
  const host = isDirectory(inherited) ? inherited : os.tmpdir();
  sweepDeadRoots(host);
  const root = fs.mkdtempSync(path.join(host, ROOT_PREFIX));
  fs.writeFileSync(path.join(root, OWNER_FILE), JSON.stringify({ pid: process.pid }));
  const home = path.join(root, 'home');
  const folders: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_RUNTIME_DIR: path.join(root, 'run'),
    [envName('STATE_DIR')]: path.join(root, 'state'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    TMPDIR: path.join(root, 'tmp'),
    [envName('USER_TEMP')]: root,
  };
  for (const [name, dir] of Object.entries(folders)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    process.env[name] = dir;
  }
  for (const name of CLEARED) Reflect.deleteProperty(process.env, name);
  process.env[ROOT_ENV] = root;
  process.env[HOST_TEMP_ENV] = host;
  process.on('exit', () => {
    try {
      removeRootOwnerFileLast(root);
    } catch {
      return;
    }
  });
  return root;
}

function rootOfParent(): string | null {
  const root = process.env[ROOT_ENV];
  return root !== undefined && path.isAbsolute(root) && ownerPid(root) !== null ? root : null;
}

type Launcher = ((...args: unknown[]) => unknown) & { [promisify.custom]?: (...args: unknown[]) => unknown };

function withInheritedFolders(args: unknown[]): unknown[] {
  const at = args.findIndex((arg, i) => i > 0 && typeof arg === 'object' && arg !== null && !Array.isArray(arg));
  if (at === -1) return args;
  const options = args[at] as { env?: unknown };
  if (typeof options.env !== 'object' || options.env === null) return args;
  const env: NodeJS.ProcessEnv = { ...(options.env as NodeJS.ProcessEnv) };
  for (const name of INHERITED) if (!(name in env)) env[name] = process.env[name];
  return args.with(at, { ...options, env });
}

function guardChildEnvironments(): void {
  const launchers = childProcess as unknown as Record<string, Launcher>;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = launchers[name];
    if (original === undefined) continue;
    const guarded: Launcher = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, withInheritedFolders(args));
    };
    const promised = original[promisify.custom];
    if (promised !== undefined) guarded[promisify.custom] = (...args: unknown[]) => promised(...withInheritedFolders(args));
    launchers[name] = guarded;
  }
  syncBuiltinESMExports();
}

const root = rootOfParent() ?? createRoot();
guardChildEnvironments();

export function testRoot(): string {
  return root;
}

/** The temp folder the test run started with, for what every test process on the host shares, such as port locks. */
export function hostTemp(): string {
  return process.env[HOST_TEMP_ENV] ?? os.tmpdir();
}

/** The environment this process started with, before its folders moved under the temp root. Only live tests use it. */
export function ownerEnv(): NodeJS.ProcessEnv {
  return { ...ownerEnvironment };
}

/** Points this process's home-derived folders back at the owner's until the test ends. Only live tests use it. */
export function useOwnerFolders(t: TestContext): void {
  const saved = Object.fromEntries([...REDIRECTED, ...CLEARED].map(name => [name, process.env[name]]));
  const restore = (values: NodeJS.ProcessEnv) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
  restore(Object.fromEntries([...REDIRECTED, ...CLEARED].map(name => [name, ownerEnvironment[name]])));
  t.after(() => {
    restore(saved);
  });
}
