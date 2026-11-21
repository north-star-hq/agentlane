import fs from 'node:fs';
import path from 'node:path';
import { LANE_TOKEN_ENV, laneVariables, hookEnvironment, resourceVariables } from '../hooks/env.ts';
import { describeExit, HookFailed, runHook, tail } from '../hooks/run.ts';
import { CLI, TOOL } from '../name.ts';
import type { ProjectConfig, ResourceConfig } from '../project/config.ts';
import { EXPORT_NAME_PATTERN, EXPORTS_FILE_ENV } from '../project/schema.ts';
import type { Registry } from '../registry/registry.ts';
import type { TeardownChoice } from '../registry/resources.ts';
import type { Lane, LaneRef, ResourceTeardown, ResourceValues } from '../registry/types.ts';
import { laneDir } from './lane-files.ts';
import type { EnvDeps } from './deps.ts';
import type { Teardown } from './release.ts';
import { SharedServiceFailed, startSharedForTeardown } from './shared.ts';

export class ResourceFailed extends Error {
  readonly resource: string;

  constructor(resource: string, problem: string) {
    super(`resource ${resource}: ${problem}`);
    this.name = 'ResourceFailed';
    this.resource = resource;
  }
}

export function resourceLog(dir: string, name: string): string {
  return path.join(dir, 'resources', `${name}.log`);
}

function exportsFile(dir: string, name: string): string {
  return path.join(dir, 'resources', `${name}.exports`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

const LINE = new RegExp(`^(${EXPORT_NAME_PATTERN.slice(1, -1)})=(.*)$`);

function unquote(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first) ? value.slice(1, -1) : value;
}

/** Reads the NAME=value lines a create wrote, and holds them to the names the resource declares. */
export function parseExports(text: string, declared: readonly string[]): ResourceValues {
  const found: ResourceValues = {};
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const [, name, value] = LINE.exec(line) ?? [];
    if (name === undefined || value === undefined) {
      throw new Error(`line ${String(i + 1)} of $${EXPORTS_FILE_ENV} is not NAME=value: ${JSON.stringify(line)}`);
    }
    found[name] = unquote(value);
  });
  const extra = Object.keys(found).filter(n => !declared.includes(n));
  if (extra.length > 0) {
    throw new Error(
      `create wrote ${extra.join(', ')}, which the resource does not declare in exports (it declares ${declared.join(', ') || 'none'})`,
    );
  }
  const missing = declared.filter(n => !(n in found));
  if (missing.length > 0) {
    throw new Error(
      `create exited 0 without writing ${missing.join(', ')} to $${EXPORTS_FILE_ENV}; write each as a NAME=value line, e.g. echo "${missing[0] ?? ''}=..." >> "$${EXPORTS_FILE_ENV}"`,
    );
  }
  return found;
}

function readExports(file: string, resource: ResourceConfig): ResourceValues {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return parseExports(text, resource.exports);
}

export interface ResourceRun {
  deps: Pick<EnvDeps, 'env' | 'log'>;
  registry: Registry;
  ref: LaneRef;
  config: ProjectConfig;
  dir: string;
}

export interface CreatedResources {
  lane: Lane;
  created: string[];
  kept: string[];
}

function recorded(vars: Readonly<Record<string, string>>): ResourceValues {
  return Object.fromEntries(Object.entries(vars).filter(([key]) => key !== LANE_TOKEN_ENV));
}

async function create(r: ResourceRun, lane: Lane, resource: ResourceConfig): Promise<ResourceValues> {
  const { name } = resource;
  const vars = laneVariables(lane, r.config, r.dir);
  const file = exportsFile(r.dir, name);
  const log = resourceLog(r.dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.rmSync(file, { force: true });
  r.deps.log(`${TOOL} up: resource ${name}: ${resource.create}   (log: ${log})`);
  try {
    await runHook(`resource ${name} create`, resource.create, {
      cwd: resource.cwd,
      env: hookEnvironment(r.deps.env, { ...vars, [EXPORTS_FILE_ENV]: file }, resourceVariables(r.config)),
      log,
    });
    return readExports(file, resource);
  } catch (error) {
    const problem =
      error instanceof HookFailed
        ? `create ${describeExit(error.run)}: ${resource.create}\n${tail(log)}\nfull log: ${log}`
        : `${message(error)}\nfull log: ${log}`;
    r.registry.failResource(lane.id, name, problem.split('\n')[0] ?? problem);
    throw new ResourceFailed(name, problem);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Runs each resource's create that this lane lacks, in the config's order, each with the values of the ones before it.
 * A resource the lane already has is kept as it is.
 */
export async function createResources(r: ResourceRun, lane: Lane): Promise<CreatedResources> {
  const result: CreatedResources = { lane, created: [], kept: [] };
  for (const resource of r.config.resources) {
    const start = r.registry.startResource(r.ref, {
      name: resource.name,
      cwd: resource.cwd,
      teardown: resource.teardown,
      timeoutMs: resource.teardownTimeoutMs,
      env: recorded(laneVariables(result.lane, r.config, r.dir)),
      cleared: resourceVariables(r.config),
      needs: resource.needs,
    });
    if (start.kind === 'kept') {
      result.kept.push(resource.name);
      continue;
    }
    if (start.retry !== null) r.deps.log(`${TOOL} up: resource ${resource.name}: creating it again: ${start.retry}`);
    const exports = await create(r, result.lane, resource);
    r.registry.finishResource(result.lane.id, resource.name, exports);
    result.lane = r.registry.touch(r.ref, `up: resource ${resource.name}`);
    result.created.push(resource.name);
  }
  return result;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export interface EndedResourceChoice extends TeardownChoice {
  /** Drop the record of a teardown that fails, leaving what it made. */
  force?: boolean;
}

async function tearDown(
  deps: Pick<EnvDeps, 'env'>,
  stateDir: string,
  t: ResourceTeardown,
): Promise<{ ms: number; moved: boolean }> {
  const dir = laneDir(stateDir, t.lane);
  const moved = !isDirectory(t.cwd);
  if (moved) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const run = await runHook(`resource ${t.name} teardown`, t.teardown, {
    cwd: moved ? dir : t.cwd,
    env: hookEnvironment(deps.env, { ...t.env, ...t.exports }, t.cleared),
    log: resourceLog(dir, t.name),
    timeoutMs: t.timeoutMs,
  });
  return { ms: run.ms, moved };
}

interface TeardownFailure {
  headline: string;
  movedNote: string;
  recordedAfterHeadline: string;
  detailAfterHeadline: string;
}

function sharedFailure(error: unknown): TeardownFailure {
  const didNotRun = 'teardown did not run, since';
  if (!(error instanceof SharedServiceFailed)) {
    const problem = message(error);
    return {
      headline: `${didNotRun} the shared services it needs could not be started`,
      movedNote: '',
      recordedAfterHeadline: problem,
      detailAfterHeadline: problem,
    };
  }
  const prefix = `shared service ${error.service}: `;
  const problem = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  return {
    headline: `${didNotRun} shared service ${error.service} did not start`,
    movedNote: '',
    recordedAfterHeadline: problem.split('\n')[0] ?? problem,
    detailAfterHeadline: problem,
  };
}

function commandFailure(error: unknown, t: ResourceTeardown, log: string): TeardownFailure {
  const moved = isDirectory(t.cwd) ? '' : ` (${movedNote(t)})`;
  if (error instanceof HookFailed) {
    return {
      headline: `teardown ${describeExit(error.run)}`,
      movedNote: moved,
      recordedAfterHeadline: t.teardown,
      detailAfterHeadline: `${t.teardown}\n${tail(log)}\nfull log: ${log}`,
    };
  }
  return {
    headline: `teardown could not run (${message(error)})`,
    movedNote: moved,
    recordedAfterHeadline: t.teardown,
    detailAfterHeadline: `full log: ${log}`,
  };
}

function movedNote(t: ResourceTeardown): string {
  return `${t.cwd} is gone, so it ran in the lane's log folder`;
}

/** The shared services whose start failed in this pass, by repository and name, so no later teardown of it tries again. */
class FailedStarts {
  private readonly failed = new Map<string, SharedServiceFailed>();

  private static key(repository: string, name: string): string {
    return JSON.stringify([repository, name]);
  }

  of(t: ResourceTeardown): SharedServiceFailed | undefined {
    const { repository } = t;
    if (repository === null) return undefined;
    return t.needs.map(name => this.failed.get(FailedStarts.key(repository, name))).find(failed => failed !== undefined);
  }

  remember(t: ResourceTeardown, error: unknown): void {
    if (t.repository !== null && error instanceof SharedServiceFailed) {
      this.failed.set(FailedStarts.key(t.repository, error.service), error);
    }
  }
}

async function tearDownOne(
  deps: Pick<EnvDeps, 'env' | 'clock'>,
  registry: Registry,
  stateDir: string,
  t: ResourceTeardown,
  notes: string[],
  failedStarts: FailedStarts,
): Promise<TeardownFailure | null> {
  const failedBefore = failedStarts.of(t);
  if (failedBefore) return sharedFailure(failedBefore);
  try {
    await startSharedForTeardown(
      {
        env: hookEnvironment(deps.env, {}, t.cleared),
        clock: deps.clock,
        log: line => notes.push(`resource ${t.name}: ${line}`),
      },
      registry,
      t,
    );
  } catch (error) {
    failedStarts.remember(t, error);
    return sharedFailure(error);
  }
  try {
    const done = await tearDown(deps, stateDir, t);
    registry.finishTeardown(t.lane, t.name);
    notes.push(`tore down resource ${t.name} (${seconds(done.ms)}${done.moved ? `; ${movedNote(t)}` : ''})`);
    return null;
  } catch (error) {
    return commandFailure(error, t, resourceLog(laneDir(stateDir, t.lane), t.name));
  }
}

/**
 * Tears down the resources of lanes that have ended, by release or by a reap, with what their create recorded, each
 * once the shared services it needs run. A failed teardown keeps its record, so a later pass tries again; a pass skips
 * one that failed in the last few minutes, unless it names that lane. A shared service that does not start fails the
 * teardown that needs it, which does not run, and every later teardown of the pass that needs it, without another start.
 */
export async function tearDownEndedResources(
  deps: Pick<EnvDeps, 'env' | 'clock'>,
  registry: Registry,
  stateDir: string,
  choice: EndedResourceChoice = {},
): Promise<Teardown[]> {
  const byLane = new Map<string, Teardown>();
  const failedStarts = new FailedStarts();
  for (const t of registry.takeTeardowns(choice.lane === undefined ? {} : { lane: choice.lane })) {
    const into = byLane.get(t.lane) ?? { lane: t.lane, notes: [], problems: [] };
    byLane.set(t.lane, into);
    const failure = await tearDownOne(deps, registry, stateDir, t, into.notes, failedStarts);
    if (failure === null) continue;
    const how = `${failure.headline}${failure.movedNote}`;
    const detail = failure.detailAfterHeadline;
    if (choice.force) {
      registry.finishTeardown(t.lane, t.name);
      into.problems.push(`forgot resource ${t.name}: ${how}, and --force drops its record, leaving what it made: ${detail}`);
    } else {
      registry.failTeardown(t.lane, t.name, `${failure.headline}: ${failure.recordedAfterHeadline}`);
      into.problems.push(
        `resource ${t.name}: ${how} (attempt ${String(t.attempts + 1)}): ${detail}\nits record is kept: the next release or reap tries again, and ${CLI} release ${t.lane} runs it now`,
      );
    }
  }
  return [...byLane.values()];
}
