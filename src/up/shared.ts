import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import { rotateLog } from '../disk-limits.ts';
import { hookEnvironment } from '../hooks/env.ts';
import { describeExit, HookFailed, runCheck, runHook, tail } from '../hooks/run.ts';
import { CLI } from '../name.ts';
import { killGroup } from '../processes.ts';
import type { SharedServiceConfig } from '../project/config.ts';
import { formatTime } from '../registry/format.ts';
import type { Registry } from '../registry/registry.ts';
import type { SharedCommands, SharedKey, SharedState } from '../registry/shared.ts';
import { SHARED_READY_RUN_MAX_MS, sharedHoldMs } from '../registry/shared.ts';
import type { LaneRef, ResourceTeardown } from '../registry/types.ts';

/** How often a start polls `ready` while it waits for the server to answer. */
export const SHARED_READY_POLL_MS = 500;
/** How often a start looks again while another process starts or stops the shared service. */
export const SHARED_WAIT_POLL_MS = 250;
const SHARED_LOG_MAX_BYTES = 1024 * 1024;

/**
 * The variables of a start's environment recorded with the shared service's commands: PATH, which finds the programs,
 * and those that choose the daemon, context and project a container tool talks to. Every later command of the shared
 * service runs with the start's values of them, and without those the start lacked.
 */
export const SHARED_START_VARIABLES = [
  'PATH',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'COMPOSE_FILE',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
] as const;

export class SharedServiceFailed extends Error {
  readonly service: string;

  constructor(service: string, problem: string) {
    super(`shared service ${service}: ${problem}`);
    this.name = 'SharedServiceFailed';
    this.service = service;
  }
}

export interface SharedRunDeps {
  /** The environment the commands run in, with the start's values of SHARED_START_VARIABLES in place of its own. */
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

/** What a lane's config says to run, with this process's values of SHARED_START_VARIABLES, so a later stop reaches the same server. */
export function sharedCommands(spec: SharedServiceConfig, env: NodeJS.ProcessEnv): SharedCommands {
  const recorded: Record<string, string> = {};
  for (const name of SHARED_START_VARIABLES) {
    const value = env[name];
    if (value !== undefined) recorded[name] = value;
  }
  return { start: spec.start, stop: spec.stop, ready: spec.ready, cwd: spec.cwd, timeoutMs: spec.timeoutMs, env: recorded };
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

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    return;
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
  const lacked = SHARED_START_VARIABLES.filter(name => commands.env[name] === undefined);
  return { cwd: moved ? dir : commands.cwd, env: hookEnvironment(deps.env, commands.env, lacked), log, moved };
}

/** Runs ready once, for at most `budgetMs` and at most SHARED_READY_RUN_MAX_MS. */
async function answers(commands: SharedCommands, place: Place, budgetMs: number): Promise<{ ok: boolean; output: string }> {
  try {
    const run = await runCheck(commands.ready, {
      cwd: place.cwd,
      env: place.env,
      timeoutMs: Math.min(budgetMs, SHARED_READY_RUN_MAX_MS),
    });
    return { ok: run.code === 0, output: run.output };
  } catch (error) {
    return { ok: false, output: message(error) };
  }
}

/**
 * Runs ready from now until it passes or `commands.timeoutMs` runs out. Each run gets what is left of that window, and
 * one that answers after the window ends doesn't count.
 */
async function readyWithin(
  deps: SharedRunDeps,
  commands: SharedCommands,
  place: Place,
): Promise<{ ok: boolean; output: string }> {
  const deadline = deps.clock.now() + commands.timeoutMs;
  let output = '';
  for (;;) {
    const left = deadline - deps.clock.now();
    if (left <= 0) return { ok: false, output };
    const ready = await answers(commands, place, left);
    if (deps.clock.now() > deadline) return { ok: false, output: ready.output };
    if (ready.ok) return ready;
    output = ready.output;
    const rest = deadline - deps.clock.now();
    if (rest <= 0) return { ok: false, output };
    await deps.clock.sleep(Math.min(SHARED_READY_POLL_MS, rest));
  }
}

function quoted(output: string): string {
  const lines = output.trimEnd().split('\n').slice(-30);
  return output.trim() === '' ? '  | (no output)' : lines.map(line => `  | ${line}`).join('\n');
}

/** Runs the start or stop command of a shared service this process holds, recording its shell while it runs. */
function runFenced(
  registry: Registry,
  key: SharedKey,
  what: 'start' | 'stop',
  command: string,
  place: Place,
  timeoutMs: number,
): Promise<unknown> {
  return runHook(`shared ${key.name} ${what}`, command, {
    ...place,
    timeoutMs,
    onSpawn: pid => {
      quietly(() => {
        registry.noteSharedCommand(key, pid);
      });
    },
  });
}

/**
 * Runs the start this process holds: ready first, which passing means the server already runs, else start, then ready
 * until it passes or the timeout runs out. A failed start records the problem, leaving the service recorded as running
 * for the sweep to stop once nothing needs it, and throws. Null when this process lost the start to another meanwhile.
 */
async function attemptStart(
  deps: SharedRunDeps,
  registry: Registry,
  key: SharedKey,
  commands: SharedCommands,
  place: Place,
): Promise<'found-running' | 'started' | null> {
  if ((await answers(commands, place, commands.timeoutMs)).ok) return registry.finishSharedStart(key) ? 'found-running' : null;
  deps.log?.(`starting shared service ${key.name}: ${commands.start}   (log: ${place.log})`);
  const where = place.moved ? `\nit ran in ${place.cwd}, since its folder ${commands.cwd} is gone` : '';
  const failed = (problem: string, detail: string): SharedServiceFailed => {
    registry.failSharedStart(key, problem);
    return new SharedServiceFailed(key.name, `${problem}\n${detail}\nfull log: ${place.log}${where}`);
  };
  try {
    await runFenced(registry, key, 'start', commands.start, place, commands.timeoutMs);
  } catch (error) {
    const how =
      error instanceof HookFailed
        ? `start ${describeExit(error.run)}: ${commands.start}`
        : `start could not run (${message(error)})`;
    throw failed(how, tail(place.log));
  }
  quietly(() => {
    registry.endSharedCommand(key);
  });
  const ready = await readyWithin(deps, commands, place);
  if (!ready.ok) {
    throw failed(
      `ready did not pass within ${seconds(commands.timeoutMs)} of its start: ${commands.ready}`,
      quoted(ready.output),
    );
  }
  return registry.finishSharedStart(key) ? 'started' : null;
}

async function runStart(
  deps: SharedRunDeps,
  registry: Registry,
  key: SharedKey,
  commands: SharedCommands,
): Promise<'found-running' | 'started' | null> {
  try {
    return await attemptStart(deps, registry, key, commands, placeOf(deps, registry.dir, key, commands));
  } catch (error) {
    if (error instanceof SharedServiceFailed) throw error;
    const problem = `its start stopped partway: ${message(error)}`;
    quietly(() => {
      registry.failSharedStart(key, problem);
    });
    throw new SharedServiceFailed(key.name, problem);
  }
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
      if ((await answers(claim.commands, place, claim.commands.timeoutMs)).ok) return { name, outcome: 'kept', took: null };
      say(`shared service ${name} is recorded as running, but its ready check fails: ${claim.commands.ready}`);
      foundDown = true;
      continue;
    }
    if (claim.kind === 'busy') {
      const { holder, orphan } = claim;
      const doing = claim.state === 'starting' ? 'starting' : 'stopping';
      const left = `the ${claim.state === 'starting' ? 'start' : 'stop'} of shared service ${name} that pid ${String(holder.pid)} left running when it died`;
      if (orphan?.overdue) {
        say(`ending ${left}, pid ${String(orphan.group.pid)}: it ran past its ${seconds(claim.timeoutMs)}`);
        killGroup(orphan.group.pid);
      } else {
        const pid = orphan ? orphan.group.pid : holder.pid;
        if (deps.clock.now() > claim.since + sharedHoldMs(claim.timeoutMs)) {
          throw new SharedServiceFailed(
            name,
            `pid ${String(pid)} has been ${doing} it since ${formatTime(claim.since)}, longer than its commands may take; kill ${String(pid)} if that process is hung, then try again`,
          );
        }
        if (waitingOn !== pid) {
          waitingOn = pid;
          say(
            orphan
              ? `waiting for ${left}, pid ${String(pid)}`
              : `waiting for pid ${String(pid)}, which is ${doing} shared service ${name}`,
          );
        }
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
 * and the end of the failed command's output, for the first that does not come up; a failed start runs no stop, and
 * leaves the service for the sweep to stop once nothing needs it.
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
 * failed stop leaves it recorded as running with the problem, for a later sweep to try again. The command of a start or
 * stop whose process died is waited for, and ended once it runs past its timeout.
 */
export async function stopUnneededShared(deps: SharedRunDeps, registry: Registry): Promise<SharedStopped[]> {
  const stopped: SharedStopped[] = [];
  for (const key of registry.sharedStopCandidates()) {
    let claim = registry.beginSharedStop(key);
    if (claim.kind === 'left' && claim.orphan?.overdue) {
      deps.log?.(`shared service ${key.name}: ending pid ${String(claim.orphan.group.pid)}: ${claim.reason}, past its timeout`);
      killGroup(claim.orphan.group.pid);
      claim = registry.beginSharedStop(key);
    }
    if (claim.kind === 'left') continue;
    const { commands } = claim;
    let place: Place | null = null;
    let how: string | null = null;
    try {
      place = placeOf(deps, registry.dir, key, commands);
      await runFenced(registry, key, 'stop', commands.stop, place, commands.timeoutMs);
    } catch (error) {
      how = error instanceof HookFailed ? `stop ${describeExit(error.run)}` : `stop could not run (${message(error)})`;
    }
    const done = { ...key, unneededSince: claim.unneededSince, moved: place?.moved ?? false, took: claim.took };
    if (how === null) {
      registry.finishSharedStop(key);
      stopped.push({ ...done, outcome: 'stopped', problem: null });
      continue;
    }
    registry.failSharedStop(key, `${how}: ${commands.stop}`);
    const where = place?.moved ? ` (it ran in ${place.cwd}, since its folder ${commands.cwd} is gone)` : '';
    const log = place?.log ?? sharedLog(registry.dir, key);
    stopped.push({
      ...done,
      outcome: 'failed',
      problem: `${how}${where}: ${commands.stop}\n${tail(log)}\nfull log: ${log}`,
    });
  }
  return stopped;
}
