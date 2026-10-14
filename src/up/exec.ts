import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { laneBrowser, hasBrowser } from '../browser/lane-browser.ts';
import { keepFailureEvidence } from '../browser/evidence.ts';
import { realBrowserTools } from '../browser/tools.ts';
import { adbTools } from '../devices/adb.ts';
import { describeRestored, restoreReverse } from '../devices/android.ts';
import { laneEnvironment, webUrl } from '../hooks/env.ts';
import { CLI, TOOL } from '../name.ts';
import type { MobileConfig, ProjectConfig, ProjectPlatform } from '../project/config.ts';
import { asMobile, findProjectConfig, loadLaneConfig } from '../project/config.ts';
import { describeOwner, resolveOwner } from '../registry/owner.ts';
import { stateDir } from '../registry/paths.ts';
import { NotClaimed, UsageError } from '../registry/refusal.ts';
import { Registry } from '../registry/registry.ts';
import { resolveFolder } from '../registry-cli.ts';
import type { Lane } from '../registry/types.ts';
import { laneDir, readUpRecord } from './lane-files.ts';
import type { EnvDeps } from './deps.ts';
import { reversePorts } from './doctor.ts';
import { driverVariables } from './maestro-env.ts';

function lenientConfig(
  file: string | null,
  platform: ProjectPlatform | undefined,
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

export async function execInLane(deps: EnvDeps, argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) throw new UsageError('exec needs a command', `${CLI} exec -- <command> [args...]`);
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
  let lane;
  try {
    lane = registry.find(owner, folder.worktree);
    if (!lane) {
      throw new NotClaimed(`${describeOwner(owner)} holds no lane in ${folder.worktree}`, `${CLI} up   (or ${CLI} claim)`);
    }
    registry.touch({ id: lane.id, token: lane.token }, `exec: ${command}`);
  } finally {
    registry.close();
  }
  const dir = laneDir(state, lane.id);
  const record = readUpRecord(dir);
  const { config, problem } = lenientConfig(
    record?.config ?? findProjectConfig(deps.cwd),
    record?.platform ?? lane.device?.platform,
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

  const code = await run(deps, command, args, env);
  if (code !== 0 && browser && (await browser.control.isOpen().catch(() => false))) {
    const kept = await keepFailureEvidence(browser.control, browser.setting.paths.evidence, [command, ...args].join(' '));
    deps.log(
      `${TOOL} exec: ${command} exited ${String(code)}; kept the lane's browser as it was in ${kept.dir}: ${kept.files.map(f => path.basename(f)).join(', ') || 'nothing could be read'}${kept.problems.length > 0 ? ` (${kept.problems.join('; ')})` : ''}`,
    );
  }
  return code;
}

function run(deps: EnvDeps, command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: deps.cwd, env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const ignore = () => undefined;
    process.on('SIGINT', ignore);
    process.on('SIGTERM', forward);
    const done = () => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', forward);
    };
    child.once('error', error => {
      done();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        deps.log(`${TOOL} exec: ${command}: command not found`);
        resolve(127);
      } else reject(error);
    });
    child.once('close', (code, signal) => {
      done();
      resolve(code ?? 128 + (signal ? os.constants.signals[signal] : 0));
    });
  });
}
