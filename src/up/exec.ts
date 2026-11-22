import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { laneBrowser, hasBrowser } from '../browser/lane-browser.ts';
import { keepFailureEvidence } from '../browser/evidence.ts';
import { realBrowserTools } from '../browser/tools.ts';
import { adbTools } from '../devices/adb.ts';
import { describeRestored, restoreReverse } from '../devices/android.ts';
import { laneEnvironment, webUrl } from '../hooks/env.ts';
import { CLI, TOOL } from '../name.ts';
import type { MobileConfig, ProjectConfig, ProjectPlatform } from '../project/config.ts';
import { asMobile, findProjectConfig, loadLaneConfig } from '../project/config.ts';
import type { ProcessIdentity } from '../processes.ts';
import { chainFrom } from '../processes.ts';
import { describeOwner, isProven, judgeProcess, resolveOwner } from '../registry/owner.ts';
import { stateDir } from '../registry/paths.ts';
import { NotClaimed, Refusal, UsageError } from '../registry/refusal.ts';
import { Registry } from '../registry/registry.ts';
import { keepTouching, recordCall, touchLane } from '../registry/touch.ts';
import { resolveFolder } from '../registry-cli.ts';
import type { LanePark } from '../registry/parks.ts';
import type { Lane } from '../registry/types.ts';
import type { ServiceSystem } from '../services/system.ts';
import { configPlatform, laneDir, readUpRecord } from './lane-files.ts';
import type { EnvDeps } from './deps.ts';
import { reversePorts } from './doctor.ts';
import { driverVariables } from './maestro-env.ts';
import { enterLane } from './wake.ts';
import { upWaker } from './waker.ts';

function lenientConfig(
  file: string | null,
  platform: ProjectPlatform | null | undefined,
  log: (line: string) => void,
): { config: ProjectConfig | null; problem: string | null } {
  if (!file) return { config: null, problem: null };
  try {
    return { config: loadLaneConfig(file, platform), problem: null };
  } catch (error) {
    const problem = (error as Error).message;
    log(`${TOOL} exec: only the lane's own variables are set, and maestro refuses to run, because ${problem}`);
    return { config: null, problem };
  }
}

/**
 * Puts back the adb reverse rules up set on the lane's emulator. A Maestro session's close can reset the emulator's adb
 * transport, so the next command would run against an app that can't reach its bundler or API.
 */
async function restoreDeviceNetwork(deps: EnvDeps, config: MobileConfig | null, lane: Lane, dir: string): Promise<void> {
  const serial = lane.device?.platform === 'android' ? lane.device.serial : null;
  if (!config || !serial || (readUpRecord(dir)?.reversed ?? []).length === 0) return;
  const wanted = reversePorts(config, lane);
  if (wanted.size === 0) return;
  try {
    const restored = await restoreReverse(adbTools(deps, serial), wanted, 'since the last command');
    if (restored.size > 0) deps.log(`${TOOL} exec: ${describeRestored(restored, serial, 'before the command')}`);
  } catch (error) {
    deps.log(
      `${TOOL} exec: could not restore adb reverse on ${serial} (${(error as Error).message.split('\n')[0] ?? ''}); ${CLI} doctor names the fix`,
    );
  }
}

export const CALLER_POLL_MS = 1000;
export const STOP_GRACE_MS = 5000;
const STOP_CHECK_MS = 100;
const CALLER_GONE_EXIT = 128 + os.constants.signals.SIGHUP;

interface Caller {
  gone(): boolean;
}

function callerOf(deps: EnvDeps): Caller {
  const parentPid = deps.parentPid ?? (() => process.ppid);
  const pid = parentPid();
  const above: ProcessIdentity[] = [...chainFrom(deps.system.processes, pid)].map(p => ({ pid: p.pid, start: p.start }));
  return { gone: () => parentPid() !== pid || anyGone(deps.system, above) };
}

function anyGone(system: ServiceSystem, processes: readonly ProcessIdentity[]): boolean {
  if (processes.length === 0) return false;
  const starts = system.running(processes.map(p => p.pid));
  return processes.some(p => isProven(judgeProcess(p, starts)));
}

type Ending = { kind: 'exited'; code: number } | { kind: 'caller-gone' };

/**
 * Runs a command with the lane's environment and returns its exit code. When the process that started exec, or any
 * process above it, goes away while the command runs, exec ends the command and every process below it, and returns
 * 129 as a hung-up command would.
 */
export async function execInLane(deps: EnvDeps, argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) throw new UsageError('exec needs a command', `${CLI} exec -- <command> [args...]`);
  const caller = callerOf(deps);
  const folder = resolveFolder(deps.cwd);
  const owner = resolveOwner(deps.env, deps.processes, deps.selfPid);
  const state = stateDir(deps.env);
  const registry = Registry.open({
    dir: state,
    processes: deps.processes,
    ports: deps.ports,
    devices: deps.devices,
    clock: deps.clock,
  });
  let lane: Lane | null;
  let park: LanePark | null;
  try {
    lane = registry.takeBack(owner, folder.worktree);
    if (!lane) {
      throw new NotClaimed(`${describeOwner(owner)} holds no lane in ${folder.worktree}`, `${CLI} up   (or ${CLI} claim)`);
    }
    recordCall(state, { id: lane.id, token: lane.token }, deps.clock.now());
    park = registry.parkOf(lane.id);
  } finally {
    registry.close();
  }
  lane = await enterLane({ stateDir: state, processes: deps.processes, clock: deps.clock }, lane, park, upWaker(deps), line => {
    deps.log(`${TOOL} exec: ${line}`);
  });
  const site = { dir: state, processes: deps.processes, clock: deps.clock };
  const ref = { id: lane.id, token: lane.token };
  touchLane(site, ref, `exec: ${command}`);
  const dir = laneDir(state, lane.id);
  const record = readUpRecord(dir);
  const { config, problem } = lenientConfig(
    record?.config ?? findProjectConfig(deps.cwd),
    configPlatform(record, lane),
    deps.log,
  );
  let env = laneEnvironment(deps.env, lane, config, dir, await driverVariables(deps, config, lane, dir, problem));
  await restoreDeviceNetwork(deps, config && asMobile(config), lane, dir);
  const browser = hasBrowser(lane)
    ? await laneBrowser({
        tools: deps.browser ?? realBrowserTools,
        stateDir: state,
        lane,
        config,
        url: webUrl(config, lane),
        env: deps.env,
        laneEnv: env,
        cwd: config?.dir ?? deps.cwd,
        log: line => {
          deps.log(`${TOOL} exec: ${line}`);
        },
      })
    : null;
  if (browser) env = { ...env, ...browser.vars };

  const stopTouching = keepTouching(site, ref, `exec: ${command}`, deps.heartbeatMs);
  let ending: Ending;
  try {
    ending = await run(deps, caller, command, args, env);
  } finally {
    stopTouching();
  }
  if (ending.kind === 'caller-gone') return CALLER_GONE_EXIT;
  const { code } = ending;
  try {
    touchLane(site, ref, `exec: ${command}`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
  }
  if (code !== 0 && browser && (await browser.control.isOpen().catch(() => false))) {
    const kept = await keepFailureEvidence(browser.control, browser.setting.paths.evidence, [command, ...args].join(' '));
    deps.log(
      `${TOOL} exec: ${command} exited ${String(code)}; kept the lane's browser as it was in ${kept.dir}: ${kept.files.map(f => path.basename(f)).join(', ') || 'nothing could be read'}${kept.problems.length > 0 ? ` (${kept.problems.join('; ')})` : ''}`,
    );
  }
  return code;
}

function run(deps: EnvDeps, caller: Caller, command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Ending> {
  if (caller.gone()) return Promise.resolve({ kind: 'caller-gone' });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: deps.cwd, env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const ignore = () => undefined;
    process.on('SIGINT', ignore);
    process.on('SIGTERM', forward);
    let stopping: Promise<void> | null = null;
    const watch = setInterval(() => {
      if (!caller.gone()) return;
      clearInterval(watch);
      stopping = stopTree(deps.system, child, deps.stopGraceMs ?? STOP_GRACE_MS);
    }, deps.callerPollMs ?? CALLER_POLL_MS);
    const done = () => {
      clearInterval(watch);
      process.off('SIGINT', ignore);
      process.off('SIGTERM', forward);
    };
    child.once('error', error => {
      done();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        deps.log(`${TOOL} exec: ${command}: command not found`);
        resolve({ kind: 'exited', code: 127 });
      } else reject(error);
    });
    child.once('close', (code, signal) => {
      done();
      if (stopping) {
        stopping.then(() => {
          resolve({ kind: 'caller-gone' });
        }, reject);
        return;
      }
      resolve({ kind: 'exited', code: code ?? 128 + (signal ? os.constants.signals[signal] : 0) });
    });
  });
}

interface Tracked {
  pid: number;
  start: string | null;
}

function track(system: ServiceSystem, pids: readonly number[]): Tracked[] {
  const starts = system.running(pids);
  if (!starts) return pids.map(pid => ({ pid, start: null }));
  return pids.flatMap(pid => {
    const start = starts.get(pid);
    return start === undefined ? [] : [{ pid, start }];
  });
}

function stillRunning(system: ServiceSystem, tracked: readonly Tracked[]): Tracked[] {
  if (tracked.length === 0) return [];
  const starts = system.running(tracked.map(p => p.pid));
  if (!starts) return [...tracked];
  return tracked.filter(p => {
    const start = starts.get(p.pid);
    return start !== undefined && (p.start === null || start === p.start);
  });
}

async function stopTree(system: ServiceSystem, child: ChildProcess, graceMs: number): Promise<void> {
  const root = child.pid;
  if (root === undefined) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const below = track(
    system,
    (system.descendants(root) ?? []).map(d => d.pid),
  );
  child.kill('SIGTERM');
  for (const p of below) system.signal(p.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  let left = stillRunning(system, below);
  while ((left.length > 0 || !exited()) && Date.now() < deadline) {
    await sleep(Math.min(STOP_CHECK_MS, Math.max(0, deadline - Date.now())));
    left = stillRunning(system, left);
  }
  if (left.length === 0 && exited()) return;
  const doomed = new Set(left.map(p => p.pid));
  for (const pid of exited() ? [...doomed] : [root, ...doomed]) {
    for (const d of system.descendants(pid) ?? []) doomed.add(d.pid);
  }
  child.kill('SIGKILL');
  for (const pid of doomed) system.signal(pid, 'SIGKILL');
}
