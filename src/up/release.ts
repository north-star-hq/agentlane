import { browserOfLane, hasBrowser, stopLaneBrowser } from '../browser/lane-browser.ts';
import type { BrowserControl } from '../browser/control.ts';
import { realBrowserTools } from '../browser/tools.ts';
import { adbTools } from '../devices/adb.ts';
import { clearBundlerPin } from '../devices/bundler.ts';
import { stopLaneEngine } from '../driver/client.ts';
import { clearDialDefaults, dialDefaults } from '../devices/dial.ts';
import { realEvidenceSystem } from '../evidence/device.ts';
import { stopRecordings } from '../evidence/evidence.ts';
import { laneEnvironment } from '../hooks/env.ts';
import { runHook } from '../hooks/run.ts';
import { loadLaneConfig, loadProjectConfig } from '../project/config.ts';
import type { ClaimedBrowser, LaneInfo, EndedLane } from '../registry/types.ts';
import { describeStop, stopService } from '../services/services.ts';
import { laneDir, hookLog, readUpRecord } from './lane-files.ts';
import type { EnvDeps } from './deps.ts';
import { dialArguments } from './doctor.ts';

export interface Teardown {
  lane: string;
  notes: string[];
  problems: string[];
}

type TeardownDeps = Pick<EnvDeps, 'env' | 'sim' | 'system' | 'clock' | 'processes' | 'adb' | 'browser' | 'evidence'>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function stopDriver(deps: Pick<EnvDeps, 'processes'>, stateDir: string, laneId: string, into: Teardown): Promise<void> {
  try {
    if (await stopLaneEngine(stateDir, laneId, { processes: deps.processes, ending: true }))
      into.notes.push('stopped the driver');
  } catch (error) {
    into.problems.push(message(error));
  }
}

async function browserControl(
  deps: TeardownDeps,
  stateDir: string,
  lane: LaneInfo & { browser: ClaimedBrowser },
  into: Teardown,
): Promise<BrowserControl | null> {
  const tools = deps.browser ?? realBrowserTools;
  const state = tools.state(lane.browser.driver, deps.env);
  if (state.kind !== 'installed') return null;
  try {
    return (await browserOfLane(tools, stateDir, lane, deps.env, state.driver)).control;
  } catch (error) {
    into.notes.push(`could not reach the browser's driver (${message(error).split('\n')[0] ?? ''}); stopping its processes`);
    return null;
  }
}

async function stopBrowser(
  deps: TeardownDeps,
  stateDir: string,
  lane: LaneInfo & { browser: ClaimedBrowser },
  control: BrowserControl | null,
  into: Teardown,
): Promise<void> {
  const stopped = await stopLaneBrowser(
    deps.browser ?? realBrowserTools,
    stateDir,
    lane.id,
    lane.browser.session,
    deps.clock,
    control,
  );
  into.notes.push(...stopped.notes);
  into.problems.push(...stopped.problems);
}

export async function stopRecordedProcesses(
  deps: Pick<EnvDeps, 'system' | 'clock'>,
  processes: LaneInfo['processes'],
  into: Teardown,
): Promise<void> {
  for (const proc of processes) {
    const outcome = await stopService(deps.system, proc, deps.clock);
    const line = describeStop(proc, outcome);
    if (outcome.kind === 'stopped' || outcome.kind === 'already-gone') into.notes.push(line);
    else into.problems.push(line);
  }
}

export async function tearDownLane(deps: TeardownDeps, stateDir: string, lane: LaneInfo & { token?: string }): Promise<Teardown> {
  const result: Teardown = { lane: lane.id, notes: [], problems: [] };
  await stopDriver(deps, stateDir, lane.id, result);
  const dir = laneDir(stateDir, lane.id);
  const record = readUpRecord(dir);
  const control = hasBrowser(lane) ? await browserControl(deps, stateDir, lane, result) : null;
  const recordings = await stopRecordings(
    { stateDir, lane, env: deps.env, clock: deps.clock, system: deps.evidence ?? realEvidenceSystem },
    control,
  );
  result.notes.push(...recordings.notes);
  result.problems.push(...recordings.problems);
  if (hasBrowser(lane)) await stopBrowser(deps, stateDir, lane, control, result);
  await stopRecordedProcesses(deps, lane.processes, result);

  const udid = lane.device?.id;
  if (record?.pinned && record.bundleId !== null && udid && deps.sim) {
    try {
      const device = await deps.sim.device(udid);
      if (device?.state === 'Booted') {
        const cleared = await clearBundlerPin(deps.sim, udid, record.bundleId);
        result.notes.push(
          cleared.changed ? `cleared the bundler pin of ${record.bundleId}` : `${record.bundleId} had no bundler pin`,
        );
        const keys = dialDefaults(dialArguments(loadProjectConfig(record.config), lane)).map(d => d.key);
        const dials = await clearDialDefaults(deps.sim, udid, record.bundleId, keys);
        if (dials.length > 0) result.notes.push(`cleared ${dials.join(', ')} from the defaults of ${record.bundleId}`);
      } else {
        result.notes.push(`left the bundler pin of ${record.bundleId}: ${udid} is not booted`);
      }
    } catch (error) {
      result.problems.push(`could not clear the bundler pin of ${record.bundleId}: ${message(error)}`);
    }
  }

  const serial = lane.device?.platform === 'android' ? lane.device.serial : null;
  if (record?.reversed && record.reversed.length > 0 && serial) {
    const adb = adbTools(deps, serial);
    const removed: number[] = [];
    try {
      const rules = await adb.reverses();
      for (const port of record.reversed) {
        if (!rules.has(port)) continue;
        await adb.removeReverse(port);
        removed.push(port);
      }
      result.notes.push(
        removed.length > 0
          ? `removed adb reverse for emulator port${removed.length === 1 ? '' : 's'} ${removed.join(', ')}`
          : 'no adb reverse rule was left to remove',
      );
    } catch (error) {
      result.notes.push(`left the adb reverse rules on ${serial}: ${message(error)}`);
    }
  }

  if (record) {
    let teardown: { command: string; cwd: string; env: NodeJS.ProcessEnv } | null = null;
    try {
      const config = loadLaneConfig(record.config, record.platform);
      if (config.hooks.teardown) {
        teardown = {
          command: config.hooks.teardown,
          cwd: config.dir,
          env: laneEnvironment(deps.env, lane, config, dir),
        };
      }
    } catch (error) {
      result.problems.push(`skipped the teardown hook: ${message(error)}`);
    }
    if (teardown) {
      try {
        const run = await runHook('teardown', teardown.command, {
          cwd: teardown.cwd,
          env: teardown.env,
          log: hookLog(dir, 'teardown'),
        });
        result.notes.push(`ran the teardown hook (${(run.ms / 1000).toFixed(1)} s)`);
      } catch (error) {
        result.problems.push(message(error));
      }
    }
  }
  return result;
}

export async function stopEndedLanes(
  deps: Pick<EnvDeps, 'system' | 'clock' | 'processes'>,
  stateDir: string,
  ended: readonly EndedLane[],
): Promise<Teardown[]> {
  const results: Teardown[] = [];
  for (const e of ended) {
    const result: Teardown = { lane: e.id, notes: [], problems: [] };
    await stopDriver(deps, stateDir, e.id, result);
    await stopRecordedProcesses(deps, e.processes ?? [], result);
    if (result.notes.length > 0 || result.problems.length > 0) results.push(result);
  }
  return results;
}
