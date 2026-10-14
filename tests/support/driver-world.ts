import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineTarget, Toolchain } from '../../src/driver/client.ts';
import { stopEngine } from '../../src/driver/client.ts';
import { identityOf, systemProcesses, type ProcessIdentity } from '../../src/processes.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import type { Owner } from '../../src/registry/owner.ts';
import { Registry } from '../../src/registry/registry.ts';
import type { Lane } from '../../src/registry/types.ts';
import { FakeDevices, FakeProbe, tempDir } from './fakes.ts';

export const FAKE_MAESTRO = path.join(import.meta.dirname, 'fake-maestro.ts');

export interface FakeEvent {
  pid: number;
  event: string;
  [key: string]: unknown;
}

export interface DriverWorld {
  root: string;
  /** The fake Android SDK's adb log: one line of arguments per call. */
  adbLog: string;
  stateDir: string;
  worktree: string;
  owner: ChildProcess;
  ownerIdentity: ProcessIdentity;
  lane: Lane;
  devices: FakeDevices;
  toolchain: Toolchain;
  env: NodeJS.ProcessEnv;
  events(): FakeEvent[];
  spawns(): FakeEvent[];
  target(): EngineTarget;
  registry(): Registry;
  close(): Promise<void>;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function commandOf(pid: number): string {
  const result = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function isFake(pid: number): boolean {
  return /fake-(maestro|driver)\.ts/.test(commandOf(pid));
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
}

export function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
}

export function writeFakeToolchain(root: string): Toolchain {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const maestro = path.join(bin, 'maestro');
  fs.writeFileSync(maestro, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_MAESTRO}" "$@"\n`, { mode: 0o755 });
  const javaHome = path.join(root, 'jdk');
  fs.mkdirSync(path.join(javaHome, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(javaHome, 'bin', 'java'),
    `#!/bin/sh\necho "    java.specification.version = 17" >&2\necho "    java.home = ${javaHome}" >&2\n`,
    { mode: 0o755 },
  );
  return { maestro, javaHome };
}

/** A fake Android SDK: an adb that logs its arguments and exits 0, and an emulator binary the SDK lookup needs. */
export function writeFakeAndroidSdk(root: string): { sdk: string; log: string } {
  const sdk = path.join(root, 'android-sdk');
  const log = path.join(root, 'adb.log');
  for (const [dir, name] of [
    ['platform-tools', 'adb'],
    ['emulator', 'emulator'],
  ] as const) {
    fs.mkdirSync(path.join(sdk, dir), { recursive: true });
    fs.writeFileSync(path.join(sdk, dir, name), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
  }
  return { sdk, log };
}

export interface WorldOptions {
  platform?: 'ios' | 'android';
  tuning?: EngineTarget['tuning'];
  start?: string;
  taps?: Record<string, string>;
  env?: Record<string, string>;
}

export async function driverWorld(options: WorldOptions = {}): Promise<DriverWorld> {
  const root = fs.realpathSync(tempDir('driver'));
  const stateDir = path.join(root, 'state');
  const worktree = path.join(root, 'work');
  fs.mkdirSync(worktree, { recursive: true });
  const owner = sleeper();
  let ownerIdentity: ProcessIdentity | undefined;
  await until(() => (ownerIdentity = identityOf(systemProcesses, owner.pid ?? 0)) !== undefined, 5000, 'the owner process');
  if (!ownerIdentity) throw new Error('no owner identity');
  const platform = options.platform ?? 'ios';
  const devices = new FakeDevices(path.join(root, 'devices'), platform);
  const fakeSdk = writeFakeAndroidSdk(root);
  const open: Registry[] = [];
  const registry = () => {
    const opened = Registry.open({
      dir: stateDir,
      processes: systemProcesses,
      ports: new FakeProbe(),
      devices: platform === 'ios' ? { ios: devices } : { android: devices },
      config: { ...DEFAULT_CONFIG, blocks: { metro: { first: 47900, last: 47903 } } },
    });
    open.push(opened);
    return opened;
  };
  const ownerRecord: Owner = { kind: 'process', process: ownerIdentity, sessionId: null, threadId: null };
  const outcome = await registry().claim({
    owner: ownerRecord,
    worktree,
    projectRoot: worktree,
    services: [],
    device: { platform },
    waitMs: 0,
  });
  const toolchain = writeFakeToolchain(root);
  const log = path.join(root, 'maestro-events.jsonl');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FAKE_LOG: log,
    FAKE_STATE: path.join(root, 'screen.txt'),
    FAKE_START: options.start ?? 'settings',
    FAKE_TAPS: JSON.stringify(options.taps ?? {}),
    ANDROID_HOME: fakeSdk.sdk,
    ...options.env,
  };
  const events = (): FakeEvent[] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as FakeEvent)
      : [];
  const world: DriverWorld = {
    root,
    adbLog: fakeSdk.log,
    stateDir,
    worktree,
    owner,
    ownerIdentity,
    lane: outcome.lane,
    devices,
    toolchain,
    env,
    events,
    spawns: () => events().filter(e => e.event === 'spawn'),
    target: () => ({
      stateDir,
      lane: world.lane,
      env,
      toolchain,
      tuning: {
        lanePollMs: 100,
        ownerPollMs: 200,
        touchEveryMs: 0,
        runnerWatchMs: 100,
        idleSampleMs: 3_600_000,
        ...options.tuning,
      },
    }),
    registry,
    async close() {
      await stopEngine(stateDir, world.lane, 15_000).catch(() => false);
      owner.kill('SIGKILL');
      for (const r of open) r.close();
      for (const event of events()) {
        for (const pid of [event.pid, event.child]) {
          if (typeof pid === 'number' && isFake(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
          }
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}
