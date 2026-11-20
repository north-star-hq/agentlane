import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import { rotateLog } from '../disk-limits.ts';
import { hookEnvironment } from '../hooks/env.ts';
import { describeExit, HookFailed, runCheck, runHook, tail } from '../hooks/run.ts';
import { CLI } from '../name.ts';
import type { SharedServiceConfig } from '../project/config.ts';
import { formatTime } from '../registry/format.ts';
import type { Registry } from '../registry/registry.ts';
import type { SharedCommands, SharedKey, SharedState } from '../registry/shared.ts';
import { SHARED_HOLD_TIMEOUTS } from '../registry/shared.ts';
import type { LaneRef, ResourceTeardown } from '../registry/types.ts';

/** How often a start polls `ready` while it waits for the server to answer. */
export const SHARED_READY_POLL_MS = 500;
/** How often a start looks again while another process starts or stops the shared service. */
export const SHARED_WAIT_POLL_MS = 250;
const READY_RUN_MAX_MS = 30_000;
const SHARED_LOG_MAX_BYTES = 1024 * 1024;

export class SharedServiceFailed extends Error {
  readonly service: string;

  constructor(service: string, problem: string) {
    super(`shared service ${service}: ${problem}`);
    this.name = 'SharedServiceFailed';
    this.service = service;
  }
}

export interface SharedRunDeps {
  /** The environment the commands run in, with the variables recorded at the last start set on top. */
  env: NodeJS.ProcessEnv;
  clock: Clock;
  log?: (line: string) => void;
}

/** `kept`: it was running and answers; `found-running`: its ready passed before any start ran; `started`: its start ran. */
export type SharedStartOutcome = 'kept' | 'found-running' | 'started';

export interface SharedStarted {
  name: string;
  outcome: SharedStartOutcome;
  /** The process this start took over from, which died while it started or stopped the shared service. */
  took: { state: SharedState; pid: number } | null;
}

export interface SharedStopped {
  repository: string;
  name: string;
  outcome: 'stopped' | 'failed';
  /** Since when nothing had needed it. */
  unneededSince: number;
  /** Its recorded folder was gone, so the stop ran in the shared service's log folder. */
  moved: boolean;
  /** Why the stop failed, with the end of its output; null once it stopped. */
  problem: string | null;
  took: { state: SharedState; pid: number } | null;
}

/** The folder of a repository's shared service logs, which is also where a command whose folder is gone runs. */
export function sharedDir(stateDir: string, repository: string): string {
  const hash = createHash('sha256').update(repository).digest('hex').slice(0, 10);
  return path.join(stateDir, 'shared', `${path.basename(repository) || 'root'}-${hash}`);
}

export function sharedLog(stateDir: string, key: SharedKey): string {
  return path.join(sharedDir(stateDir, key.repository), `${key.name}.log`);
}

/** What a lane's config says to run, with the PATH of this process, so a later stop finds the same programs. */
export function sharedCommands(spec: SharedServiceConfig, env: NodeJS.ProcessEnv): SharedCommands {
  return {
    start: spec.start,
    stop: spec.stop,
    ready: spec.ready,
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    env: env.PATH === undefined ? {} : { PATH: env.PATH },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  return `${String(Math.round(ms / 100) / 10)} s`;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

interface Place {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: string;
  moved: boolean;
}

function placeOf(deps: SharedRunDeps, stateDir: string, key: SharedKey, commands: SharedCommands): Place {
  const dir = sharedDir(stateDir, key.repository);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = sharedLog(stateDir, key);
  rotateLog(log, SHARED_LOG_MAX_BYTES);
  const moved = !isDirectory(commands.cwd);
  return { cwd: moved ? dir : commands.cwd, env: hookEnvironment(deps.env, commands.env), log, moved };
}

async function answers(commands: SharedCommands, place: Place): Promise<{ ok: boolean; output: string }> {
  try {
    const run = await runCheck(commands.ready, {
      cwd: place.cwd,
      env: place.env,
      timeoutMs: Math.min(commands.timeoutMs, READY_RUN_MAX_MS),
    });
    return { ok: run.code === 0, output: run.output };
  } catch (error) {
    return { ok: false, output: message(error) };
  }
}

function quoted(output: string): string {
  const lines = output.trimEnd().split('\n').slice(-30);
  return output.trim() === '' ? '  | (no output)' : lines.map(line => `  | ${line}`).join('\n');
}

async function undoStart(key: SharedKey, commands: SharedCommands, place: Place): Promise<string> {
  try {
    await runHook(`shared ${key.name} stop`, commands.stop, { ...place, timeoutMs: commands.timeoutMs });
    return '';
  } catch (error) {
    const how = error instanceof HookFailed ? `stop ${describeExit(error.run)}` : `stop could not run (${message(error)})`;
    return `\nits stop, run to undo the start, failed too: ${how}: ${commands.stop}`;
  }
}

/**
 * Runs the start this process holds: ready first, which passing means the server already runs, else start, then ready
 * until it passes or the timeout runs out. A failed start runs stop to undo what it began, records the service as
 * stopped with the problem, and throws. Null when this process lost the start to another meanwhile.
 */
async function attemptStart(
  deps: SharedRunDeps,
  registry: Registry,
  key: SharedKey,
  commands: SharedCommands,
  place: Place,
): Promise<'found-running' | 'started' | null> {
  if ((await answers(commands, place)).ok) return registry.finishSharedStart(key) ? 'found-running' : null;
  deps.log?.(`starting shared service ${key.name}: ${commands.start}   (log: ${place.log})`);
  let problem: string;
  let detail: string;
  try {
    await runHook(`shared ${key.name} start`, commands.start, { ...place, timeoutMs: commands.timeoutMs });
    const deadline = deps.clock.now() + commands.timeoutMs;
    for (;;) {
      const ready = await answers(commands, place);
      if (ready.ok) return registry.finishSharedStart(key) ? 'started' : null;
      if (deps.clock.now() >= deadline) {
        problem = `ready did not pass within ${seconds(commands.timeoutMs)} of its start: ${commands.ready}`;
        detail = quoted(ready.output);
        break;
      }
      await deps.clock.sleep(SHARED_READY_POLL_MS);
    }
  } catch (error) {
    problem =
      error instanceof HookFailed
        ? `start ${describeExit(error.run)}: ${commands.start}`
        : `start could not run (${message(error)})`;
    detail = tail(place.log);
  }
  const undone = await undoStart(key, commands, place);
  const where = place.moved ? `\nit ran in ${place.cwd}, since its folder ${commands.cwd} is gone` : '';
  registry.failSharedStart(key, problem);
  throw new SharedServiceFailed(key.name, `${problem}\n${detail}\nfull log: ${place.log}${where}${undone}`);
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    return;
  }
}

async function runStart(
  deps: SharedRunDeps,
  registry: Registry,
  key: SharedKey,
  commands: SharedCommands,
): Promise<'found-running' | 'started' | null> {
  const place = placeOf(deps, registry.dir, key, commands);
  try {
    return await attemptStart(deps, registry, key, commands, place);
  } catch (error) {
    if (!(error instanceof SharedServiceFailed)) {
      quietly(() => {
        registry.failSharedStart(key, `its start stopped partway: ${message(error)}`);
      });
    }
    throw error;
  }
}

function waitLimit(since: number, timeoutMs: number): number {
  return since + SHARED_HOLD_TIMEOUTS * timeoutMs;
}

async function bringUp(
  deps: SharedRunDeps,
  registry: Registry,
  need: { lane: LaneRef } | { repository: string },
  name: string,
  spec: SharedCommands | null,
): Promise<SharedStarted> {
  const say = deps.log ?? (() => undefined);
  let foundDown = false;
  let waitingOn: number | null = null;
  for (;;) {
    const claim = registry.beginSharedStart(need, name, spec, foundDown);
    if (claim.kind === 'unknown') {
      throw new SharedServiceFailed(
        name,
        `no start of it is recorded for ${claim.key.repository}, so its commands are unknown; ${CLI} up in a worktree of that repository starts it`,
      );
    }
    if (claim.kind === 'running') {
      const place = placeOf(deps, registry.dir, claim.key, claim.commands);
      if ((await answers(claim.commands, place)).ok) return { name, outcome: 'kept', took: null };
      say(`shared service ${name} is recorded as running, but its ready check fails: ${claim.commands.ready}`);
      foundDown = true;
      continue;
    }
    if (claim.kind === 'busy') {
      const { pid } = claim.holder;
      if (deps.clock.now() > waitLimit(claim.since, claim.timeoutMs)) {
        throw new SharedServiceFailed(
          name,
          `pid ${String(pid)} has been ${claim.state === 'starting' ? 'starting' : 'stopping'} it since ${formatTime(claim.since)}, longer than its commands may take; kill ${String(pid)} if that process is hung, then try again`,
        );
      }
      if (waitingOn !== pid) {
        waitingOn = pid;
        say(
          `waiting for pid ${String(pid)}, which is ${claim.state === 'starting' ? 'starting' : 'stopping'} shared service ${name}`,
        );
      }
      await deps.clock.sleep(SHARED_WAIT_POLL_MS);
      continue;
    }
    if (claim.took) {
      say(`taking shared service ${name} over from pid ${String(claim.took.pid)}, which died while ${claim.took.state} it`);
    }
    const outcome = await runStart(deps, registry, claim.key, claim.commands);
    if (outcome) return { name, outcome, took: claim.took };
  }
}

/**
 * Brings up the shared services a lane needs, as `up` and a wake do: records `specs`' names as exactly what the lane
 * needs, then, in order, keeps each one that runs and answers, waits for a start or stop another process is running,
 * and starts each one that is stopped, unless its ready already passes. Throws SharedServiceFailed, naming the service
 * and the end of the failed command's output, for the first that does not come up.
 */
export async function startSharedForLane(
  deps: SharedRunDeps,
  registry: Registry,
  ref: LaneRef,
  specs: readonly SharedServiceConfig[],
): Promise<SharedStarted[]> {
  registry.recordNeeds(
    ref,
    specs.map(s => s.name),
  );
  const started: SharedStarted[] = [];
  for (const spec of specs) started.push(await bringUp(deps, registry, { lane: ref }, spec.name, sharedCommands(spec, deps.env)));
  return started;
}

/**
 * Brings up the shared services a resource's teardown needs, with the commands recorded at their last start, for a
 * teardown this process holds (from `takeTeardowns`), so none stops while the teardown runs. Throws SharedServiceFailed
 * as `startSharedForLane` does.
 */
export async function startSharedForTeardown(
  deps: SharedRunDeps,
  registry: Registry,
  teardown: ResourceTeardown,
): Promise<SharedStarted[]> {
  const { repository } = teardown;
  if (repository === null) return [];
  const started: SharedStarted[] = [];
  for (const name of teardown.needs) started.push(await bringUp(deps, registry, { repository }, name, null));
  return started;
}

/**
 * The sweep's part: stops each shared service no active lane and no running teardown has needed for SHARED_IDLE_MS,
 * with the commands recorded at its last start. A stop whose folder is gone runs in the shared service's log folder. A
 * failed stop leaves it recorded as running with the problem, for a later sweep to try again.
 */
export async function stopUnneededShared(deps: SharedRunDeps, registry: Registry): Promise<SharedStopped[]> {
  const stopped: SharedStopped[] = [];
  for (const key of registry.sharedStopCandidates()) {
    const claim = registry.beginSharedStop(key);
    if (claim.kind === 'left') continue;
    const { commands } = claim;
    const place = placeOf(deps, registry.dir, key, commands);
    const done = { ...key, unneededSince: claim.unneededSince, moved: place.moved, took: claim.took };
    try {
      await runHook(`shared ${key.name} stop`, commands.stop, { ...place, timeoutMs: commands.timeoutMs });
      registry.finishSharedStop(key);
      stopped.push({ ...done, outcome: 'stopped', problem: null });
    } catch (error) {
      const how = error instanceof HookFailed ? `stop ${describeExit(error.run)}` : `stop could not run (${message(error)})`;
      registry.failSharedStop(key, `${how}: ${commands.stop}`);
      const where = place.moved ? ` (it ran in ${place.cwd}, since its folder ${commands.cwd} is gone)` : '';
      stopped.push({
        ...done,
        outcome: 'failed',
        problem: `${how}${where}: ${commands.stop}\n${tail(place.log)}\nfull log: ${place.log}`,
      });
    }
  }
  return stopped;
}
