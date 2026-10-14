import { stopEndedBrowsers } from './browser/lane-browser.ts';
import type { EvidenceSystem } from './evidence/device.ts';
import { realBrowserTools, type BrowserTools } from './browser/tools.ts';
import type { AdbFactory } from './devices/adb.ts';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Clock } from './clock.ts';
import type { DeviceBackend, Platform } from './devices/backend.ts';
import { DeviceBackendError } from './devices/backend.ts';
import type { SimTools } from './devices/tools.ts';
import { laneVariables } from './hooks/env.ts';
import { CLI, TOOL } from './name.ts';
import { describeStart, type ProcessTable } from './processes.ts';
import { formatAge, formatTime, shellQuote } from './registry/format.ts';
import type { Owner } from './registry/owner.ts';
import { DEVICE_MEMORY_MB } from './registry/config.ts';
import { describeOwner, describeState, isProven, ownerKey, resolveOwner } from './registry/owner.ts';
import { databasePath, stateDir } from './registry/paths.ts';
import type { PortProbe } from './registry/ports.ts';
import type { PruneResult } from './registry/prune.ts';
import { describePruneResult, listPrunable, renderPruneListing } from './registry/prune.ts';
import { NotClaimed, Refusal, UsageError } from './registry/refusal.ts';
import { readRegistryStatus, Registry } from './registry/registry.ts';
import type { Lane, LaneOutcome, LaneStatus, EndedLane, ServiceRequest, StatusReport } from './registry/types.ts';
import type { ServiceSystem } from './services/system.ts';
import { realServiceSystem } from './services/system.ts';
import type { Teardown } from './up/release.ts';
import { pruneEndedLaneFiles } from './up/lane-files.ts';
import { stopEndedLanes, tearDownLane } from './up/release.ts';
import { tearDownEndedResources } from './up/resources.ts';
import { systemClock } from './clock.ts';
import { claudeSessionName } from './plugin/session-name.ts';
import { groupUsage, helpOf, type UsageGroup } from './usage.ts';

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  processes: ProcessTable;
  ports: PortProbe;
  devices: Partial<Record<Platform, DeviceBackend>>;
  clock?: Clock;
  pollMs?: number;
  selfPid?: number;
  onCancel?: (cancel: () => void) => () => void;
  sim?: SimTools | null;
  system?: ServiceSystem;
  adb?: AdbFactory;
  browser?: BrowserTools;
  evidence?: EvidenceSystem;
}

export const REGISTRY_COMMANDS = ['claim', 'release', 'status', 'lanes', 'touch', 'prune'] as const;

export const REGISTRY_HELP: UsageGroup<(typeof REGISTRY_COMMANDS)[number]> = {
  title: 'Lanes:',
  entries: {
    claim: `  claim      Claim a lane for this session and folder: ports, and a pool simulator or emulator.
             Prints shell exports on stdout: eval "$(${TOOL} claim)".
               --services <list>     comma-separated name[:type]; default metro,api,web; 'none' for no ports
               --no-device           claim ports only
               --platform <name>     ios (default) or android; an Android lane always boots its emulator
               --device-type <name>  default: the newest iPhone the runtime supports; on Android, pixel_8
               --runtime <name>      default: the newest installed iOS runtime; on Android, the newest
                                     installed Google APIs system image for this Mac's CPU
               --strict              take only the exact device type and runtime; without it, a full pool
                                     hands over a free device of another type
               --boot                boot the simulator and wait until it is ready
               --timeout <seconds>   how long to queue when the pool is full (default 600; 0 = don't wait)
               --worktree <dir>      the folder the lane is for (default: this git worktree)
               --json                print the lane as JSON instead of exports
`,
    release: `  release    Release this session's lane for this folder: stop the services up started
             (each verified by pid and start time), clear the bundler pin, run the teardown hook,
             then each resource's teardown. A teardown that fails is kept, and the next release
             or reap on this Mac tries it again.
             release <id> releases a lane by id: yours, or one whose owner is proven gone. For a
             lane that has ended, it runs the teardowns still pending for it.
               --worktree <dir>      the folder whose lane to release (default: this git worktree)
               --lane <id>           the same as release <id>
               --force               with an id: release it even if its owner is alive or can't be judged;
                                     for an ended lane, drop the record of a teardown that fails again
`,
    status: `  status     Every lane on this Mac: owner, folder, start, idle time, last action.
`,
    lanes: `  lanes      --json: the same as status, as JSON for tools.
`,
    touch: `  touch      Record activity on this session's lane (--action <text>).
`,
    prune: `  prune      List the pool simulators and emulators no lane holds, 0.2.x's included; --yes
             deletes them to free their disk. Each deletion takes the registry's lock and checks
             again that no lane holds the device, so one claimed meanwhile is kept. A device the
             registry has no record of is never deleted, even one named like a pool device.
               --yes                 delete them; without it, prune only lists
               --json                print the listing, and with --yes each result, as JSON
`,
  },
};

export const REGISTRY_USAGE = groupUsage(REGISTRY_HELP);

const EXIT_REFUSED = 3;
const EXIT_USAGE = 2;

interface Folder {
  worktree: string;
  projectRoot: string;
}

function git(dir: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function resolveFolder(start: string): Folder {
  let dir: string;
  try {
    dir = fs.realpathSync(start);
  } catch {
    throw new UsageError(`${start} does not exist`, 'pass --worktree with an existing folder');
  }
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  const worktree = top ? fs.realpathSync(top) : dir;
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return { worktree, projectRoot: worktree };
  const real = fs.realpathSync(common);
  return { worktree, projectRoot: path.basename(real) === '.git' ? path.dirname(real) : real };
}

function parseServices(raw: string): ServiceRequest[] {
  if (raw.trim() === 'none') return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(entry => {
      const [name = '', type = name] = entry.split(':');
      if (!/^[a-z][a-z0-9-]*$/.test(name) || !/^[a-z][a-z0-9-]*$/.test(type)) {
        throw new UsageError(`'${entry}' is not a service`, 'write services as name[:type], e.g. --services metro,api,admin:web');
      }
      return { name, type };
    });
}

function parseSeconds(raw: string, flag: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new UsageError(`${flag} ${raw} is not a number of seconds`, `pass ${flag} 600`);
  return seconds * 1000;
}

export function laneEnv(lane: Lane): Record<string, string> {
  return laneVariables(lane, null, null);
}

function describeEnded(e: EndedLane, now: number): string {
  const where = `${e.owner} in ${e.worktree}`;
  switch (e.reason) {
    case 'taken-over':
      return `took over idle lane ${e.id} of ${where}: last used ${formatTime(e.lastUsedAt)} (${formatAge(now - e.lastUsedAt)} ago, ${e.lastAction})`;
    case 'released':
    case 'forced':
      return `${e.reason} lane ${e.id} of ${where}`;
    default:
      return `freed lane ${e.id} of ${where}: ${describeState(e.reason)}`;
  }
}

function describeLane(lane: Lane): string {
  const parts: string[] = [];
  if (lane.device)
    parts.push(
      `${lane.device.name} (${lane.device.deviceTypeName}, ${lane.device.runtimeName}, ${lane.device.serial ?? lane.device.id})`,
    );
  if (lane.browser) parts.push(`a ${lane.browser.driver} browser (session ${lane.browser.session})`);
  if (lane.ports.length > 0) parts.push(`ports ${lane.ports.map(p => `${p.service} ${String(p.port)}`).join(', ')}`);
  return parts.join('; ') || 'nothing';
}

function renderOutcome(outcome: LaneOutcome, now: number, deps: CliDeps, json: boolean): void {
  const { lane } = outcome;
  if (json) {
    deps.stdout(`${JSON.stringify({ ...outcome, env: laneEnv(lane) }, null, 2)}\n`);
    return;
  }
  for (const e of outcome.freed) deps.stderr(`${TOOL}: ${describeEnded(e, now)}\n`);
  for (const e of outcome.tookOver) deps.stderr(`${TOOL}: ${describeEnded(e, now)}\n`);
  for (const note of outcome.notes) deps.stderr(`${TOOL}: ${note}\n`);
  const verb = outcome.created ? 'claimed lane' : 'reusing lane';
  deps.stderr(`${TOOL}: ${verb} ${lane.id} for ${describeOwner(lane.owner)} in ${lane.worktree}: ${describeLane(lane)}\n`);
  for (const [key, value] of Object.entries(laneEnv(lane))) deps.stdout(`export ${key}=${shellQuote(value)}\n`);
}

export type SessionNames = (lane: LaneStatus) => string | null;

function laneLines(c: LaneStatus, sessionName: SessionNames): string[] {
  const state = c.ownerState === 'alive' ? 'alive' : describeState(c.ownerState).toUpperCase();
  const name = sessionName(c);
  const lines = [
    `  ${c.id}  ${describeOwner(c.owner)}${name ? ` "${name}"` : ''}  [${state}]`,
    `      folder       ${c.worktree}${c.projectRoot !== c.worktree ? `  (project ${c.projectRoot})` : ''}`,
    `      started      ${formatTime(c.createdAt)}   idle ${formatAge(c.idleMs)}   last action: ${c.lastAction}`,
  ];
  if (c.device) {
    lines.push(
      `      device       ${c.device.name} (${c.device.deviceTypeName}, ${c.device.runtimeName}) ${c.device.serial ?? c.device.id}  ${c.deviceState ?? ''}`,
    );
  }
  if (c.browser) {
    lines.push(
      `      browser      ${c.browser.driver}, session ${c.browser.session}, debugging port ${String(c.browser.debugPort)}${c.browser.streamPort === null ? '' : `, stream port ${String(c.browser.streamPort)}`}`,
    );
  }
  if (c.ports.length > 0) lines.push(`      ports        ${c.ports.map(p => `${p.service} ${String(p.port)}`).join(', ')}`);
  if (c.resources.length > 0) {
    const shown = c.resources.map(r =>
      r.exports === null
        ? `${r.name} (create did not finish)`
        : `${r.name}${Object.keys(r.exports).length > 0 ? ` (${Object.keys(r.exports).join(', ')})` : ''}`,
    );
    lines.push(`      resources    ${shown.join(', ')}`);
  }
  for (const p of c.processes)
    lines.push(`      process      ${p.service} pid ${String(p.pid)} (started ${describeStart(p.start)})`);
  if (c.ownerState === 'cant-tell')
    lines.push(`      left alone: its owner can't be judged; ${CLI} release --lane ${c.id} --force frees it`);
  return lines;
}

function poolLine(report: StatusReport): string {
  const { config } = report;
  const count = (platform: Platform) => report.pool.filter(d => d.platform === platform).length;
  const claimed = report.lanes.flatMap(c => (c.device ? [c.device.platform] : []));
  const used = claimed.reduce((sum, platform) => sum + DEVICE_MEMORY_MB[platform], 0);
  return `${String(count('ios'))} of ${String(config.poolSize)} simulators, ${String(count('android'))} of ${String(config.emulatorPoolSize)} emulators; claimed devices use ${String(used / 1000)} of ${String(config.memoryBudgetMb / 1000)} GB`;
}

export function renderStatus(report: StatusReport, sessionName: SessionNames = () => null): string {
  const { config } = report;
  const lines = [
    `${TOOL} registry: ${report.stateDir}`,
    `pool: ${poolLine(report)}; idle lanes are reclaimable after ${formatAge(config.idleMs)} when the pool is full`,
    `ports: ${Object.entries(config.blocks)
      .map(([type, b]) => `${type} ${String(b.first)}-${String(b.last)}`)
      .join(', ')}`,
    '',
  ];
  if (report.lanes.length === 0) lines.push('no lanes');
  else {
    lines.push(`lanes (${String(report.lanes.length)}):`);
    for (const c of report.lanes) lines.push(...laneLines(c, sessionName));
  }
  if (report.queue.length > 0) {
    lines.push('', 'queue:');
    for (const q of report.queue)
      lines.push(
        `  ${String(q.ticket)}  ${q.owner} in ${q.worktree}, waiting since ${formatTime(q.enqueuedAt)} (pid ${String(q.waiterPid)})`,
      );
  }
  if (report.pool.length > 0) {
    lines.push('', 'pool devices:');
    for (const d of report.pool) {
      lines.push(
        `  ${d.name}  ${d.deviceTypeName}, ${d.runtimeName}  ${d.id ?? ''}  ${d.laneId ? `lane ${d.laneId}` : 'free'}  ${d.state}`,
      );
    }
  }
  if (report.teardowns.length > 0) {
    lines.push('', `teardowns pending (${CLI} release <id> runs them now):`);
    for (const t of report.teardowns) {
      const tried =
        t.attempts === 0
          ? 'not tried yet'
          : `failed ${String(t.attempts)} time${t.attempts === 1 ? '' : 's'}, last at ${formatTime(t.lastAttemptAt ?? 0)}: ${t.problem ?? ''}`;
      lines.push(`  ${t.lane}  resource ${t.name} of ${t.worktree}, created ${formatTime(t.createdAt)}; ${tried}`);
    }
  }
  if (report.recent.length > 0) {
    lines.push('', 'ended in the last day:');
    for (const e of report.recent) {
      lines.push(`  ${formatTime(e.endedAt)}  ${describeEnded(e, report.now)}${e.by === e.owner ? '' : ` (by ${e.by})`}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function reportError(error: unknown, deps: CliDeps): number {
  if (error instanceof Refusal || error instanceof NotClaimed) {
    deps.stderr(`${TOOL}: ${error.message}\n`);
    return EXIT_REFUSED;
  }
  if (error instanceof UsageError) {
    deps.stderr(`${TOOL}: ${error.message}\n`);
    return EXIT_USAGE;
  }
  if (error instanceof DeviceBackendError) {
    deps.stderr(`${TOOL}: ${error.message}\n`);
    return 1;
  }
  throw error;
}

export async function runRegistryCommand(command: string, args: string[], deps: CliDeps): Promise<number> {
  try {
    return await dispatch(command, args, deps);
  } catch (error) {
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      deps.stderr(`${TOOL} ${command}: ${error.message}\n\n${helpOf(REGISTRY_HELP, command) ?? REGISTRY_USAGE}`);
      return EXIT_USAGE;
    }
    return reportError(error, deps);
  }
}

function open(deps: CliDeps): Registry {
  return Registry.open({
    dir: stateDir(deps.env),
    processes: deps.processes,
    ports: deps.ports,
    devices: deps.devices,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
  });
}

function teardownDeps(deps: CliDeps) {
  return {
    env: deps.env,
    sim: deps.sim ?? null,
    system: deps.system ?? realServiceSystem,
    clock: deps.clock ?? systemClock,
    processes: deps.processes,
    browser: deps.browser ?? realBrowserTools,
    ...(deps.evidence ? { evidence: deps.evidence } : {}),
    ...(deps.adb ? { adb: deps.adb } : {}),
  };
}

interface ReleaseTarget {
  id: string | null;
  force: boolean;
  folder: string | null;
}

async function tearDownTargets(deps: CliDeps, who: Owner, target: ReleaseTarget): Promise<Teardown[]> {
  const dir = stateDir(deps.env);
  const report = readRegistryStatus({
    dir,
    processes: deps.processes,
    devices: deps.devices,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  const key = ownerKey(who);
  const targets = report.lanes.filter(c => {
    if (target.id !== null) return c.id === target.id && (c.ownerKey === key || isProven(c.ownerState) || target.force);
    return c.ownerKey === key && (target.folder === null || c.worktree === target.folder);
  });
  const teardowns: Teardown[] = [];
  for (const lane of targets) teardowns.push(await tearDownLane(teardownDeps(deps), dir, lane));
  return teardowns;
}

function merged(teardowns: readonly Teardown[]): Teardown[] {
  const byLane = new Map<string, Teardown>();
  for (const t of teardowns) {
    const into = byLane.get(t.lane) ?? { lane: t.lane, notes: [], problems: [] };
    into.notes.push(...t.notes);
    into.problems.push(...t.problems);
    byLane.set(t.lane, into);
  }
  return [...byLane.values()];
}

function printTeardowns(deps: CliDeps, teardowns: readonly Teardown[], own: (lane: string) => boolean): void {
  for (const t of teardowns) {
    const which = own(t.lane) ? `lane ${t.lane}` : `ended lane ${t.lane}`;
    for (const line of t.notes) deps.stderr(`${TOOL}: ${which}: ${line}\n`);
    for (const line of t.problems) deps.stderr(`${TOOL}: ${which}: PROBLEM: ${line}\n`);
  }
}

async function pendingRelease(deps: CliDeps, registry: Registry, target: ReleaseTarget, json: boolean): Promise<number> {
  const teardowns = await tearDownEndedResources(teardownDeps(deps), registry, stateDir(deps.env), {
    ...(target.id !== null ? { lane: target.id } : {}),
    force: target.force,
  });
  if (json) deps.stdout(`${JSON.stringify({ released: [], notes: [], teardowns }, null, 2)}\n`);
  else {
    printTeardowns(deps, teardowns, () => true);
    if (teardowns.length === 0) {
      deps.stderr(`${TOOL}: lane ${target.id ?? ''} has ended, and another ${TOOL} run is tearing down its resources now\n`);
    }
  }
  return teardowns.some(t => t.problems.length > 0 && !target.force) ? 1 : 0;
}

async function releaseLanes(deps: CliDeps, who: Owner, target: ReleaseTarget, json: boolean): Promise<number> {
  const teardowns = await tearDownTargets(deps, who, target);
  const registry = open(deps);
  const notes: string[] = [];
  try {
    if (target.id !== null && registry.pendingTeardowns().some(t => t.lane === target.id)) {
      return await pendingRelease(deps, registry, target, json);
    }
    const ended =
      target.id !== null
        ? [registry.releaseById(target.id, who, target.force, notes)]
        : registry.releaseOwn(who, target.folder, notes);
    const at = now(deps);
    const released = new Set(ended.map(e => e.id));
    const own = (lane: string) => released.has(lane);
    const all = merged([
      ...teardowns,
      ...(await stopEndedBrowsers(teardownDeps(deps).browser, registry, stateDir(deps.env), teardownDeps(deps).clock)),
      ...(await tearDownEndedResources(teardownDeps(deps), registry, stateDir(deps.env))),
    ]);
    const problems = all.filter(t => own(t.lane)).flatMap(t => t.problems);
    if (json) deps.stdout(`${JSON.stringify({ released: ended, notes, teardowns: all }, null, 2)}\n`);
    else {
      printTeardowns(deps, all, own);
      for (const note of notes) deps.stderr(`${TOOL}: ${note}\n`);
      if (ended.length === 0) deps.stderr(`${TOOL}: ${describeOwner(who)} holds no lane here; nothing to release\n`);
      for (const e of ended) deps.stderr(`${TOOL}: ${describeEnded(e, at)}\n`);
    }
    return problems.length > 0 ? 1 : 0;
  } finally {
    registry.close();
  }
}

export function releaseEveryLaneOf(deps: CliDeps, who: Owner): Promise<number> {
  return releaseLanes(deps, who, { id: null, force: false, folder: null }, false);
}

function releaseId(positionals: readonly string[], flag: string | undefined): string | null {
  const [bare, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected ${extra.join(' ')}`, `pass one lane id: ${CLI} release <id>`);
  if (bare !== undefined && flag !== undefined && bare !== flag)
    throw new UsageError(`release ${bare} and --lane ${flag} name two lanes`, `pass one: ${CLI} release <id>`);
  return bare ?? flag ?? null;
}

function prune(deps: CliDeps, yes: boolean, json: boolean): number {
  const dir = stateDir(deps.env);
  const registry = fs.existsSync(databasePath(dir)) ? open(deps) : null;
  try {
    const listing = registry ? registry.prunable() : listPrunable(null, dir, deps.devices);
    if (!json) deps.stdout(renderPruneListing(listing, yes));
    const results: PruneResult[] = [];
    if (yes && registry) {
      for (const device of listing.free) {
        const result = registry.pruneDevice(device);
        results.push(result);
        if (json) continue;
        if (result.outcome === 'failed') deps.stderr(`${TOOL}: ${describePruneResult(result)}\n`);
        else deps.stdout(`${describePruneResult(result)}\n`);
      }
    }
    if (json) deps.stdout(`${JSON.stringify({ ...listing, ...(yes ? { results } : {}) }, null, 2)}\n`);
    return results.some(r => r.outcome === 'failed') ? 1 : 0;
  } finally {
    registry?.close();
  }
}

function now(deps: CliDeps): number {
  return deps.clock ? deps.clock.now() : Date.now();
}

async function dispatch(command: string, args: string[], deps: CliDeps): Promise<number> {
  const owner = (): Owner => resolveOwner(deps.env, deps.processes, deps.selfPid);
  switch (command) {
    case 'claim': {
      const { values } = parseArgs({
        args,
        strict: true,
        options: {
          services: { type: 'string', default: 'metro,api,web' },
          'no-device': { type: 'boolean', default: false },
          platform: { type: 'string', default: 'ios' },
          'device-type': { type: 'string' },
          runtime: { type: 'string' },
          strict: { type: 'boolean', default: false },
          boot: { type: 'boolean', default: false },
          timeout: { type: 'string', default: '600' },
          worktree: { type: 'string' },
          json: { type: 'boolean', default: false },
        },
      });
      if (values.platform !== 'ios' && values.platform !== 'android') {
        throw new UsageError(`--platform ${values.platform} is not a platform`, 'pass --platform ios or --platform android');
      }
      const folder = resolveFolder(values.worktree ?? deps.cwd);
      const who = owner();
      const registry = open(deps);
      const stop = deps.onCancel?.(() => registry.cancelPending());
      try {
        const outcome = await registry.claim({
          owner: who,
          worktree: folder.worktree,
          projectRoot: folder.projectRoot,
          services: parseServices(values.services),
          device: values['no-device']
            ? null
            : {
                platform: values.platform,
                deviceType: values['device-type'],
                runtime: values.runtime,
                strict: values.strict,
              },
          waitMs: parseSeconds(values.timeout, '--timeout'),
          boot: values.boot,
        });
        renderOutcome(outcome, now(deps), deps, values.json);
        const state = stateDir(deps.env);
        const stopped = [
          ...(await stopEndedLanes(teardownDeps(deps), state, [...outcome.freed, ...outcome.tookOver])),
          ...(await stopEndedBrowsers(teardownDeps(deps).browser, registry, state, teardownDeps(deps).clock)),
          ...(await tearDownEndedResources(teardownDeps(deps), registry, state)),
        ];
        for (const t of stopped)
          for (const line of [...t.notes, ...t.problems]) deps.stderr(`${TOOL}: lane ${t.lane}: ${line}\n`);
        pruneEndedLaneFiles(
          state,
          new Set([...registry.status().lanes.map(c => c.id), ...registry.pendingTeardowns().map(t => t.lane)]),
          now(deps),
          deps.env,
        );
        return 0;
      } finally {
        stop?.();
        registry.close();
      }
    }
    case 'release': {
      const { values, positionals } = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          lane: { type: 'string' },
          force: { type: 'boolean', default: false },
          worktree: { type: 'string' },
          json: { type: 'boolean', default: false },
        },
      });
      const id = releaseId(positionals, values.lane);
      if (values.force && id === null) throw new UsageError('--force needs a lane id', `pass ${CLI} release <id> --force`);
      const who = owner();
      const folder = id === null ? resolveFolder(values.worktree ?? deps.cwd).worktree : null;
      return releaseLanes(deps, who, { id, force: values.force, folder }, values.json);
    }
    case 'status':
    case 'lanes': {
      const { values } = parseArgs({ args, strict: true, options: { json: { type: 'boolean', default: false } } });
      if (command === 'lanes' && !values.json) {
        throw new UsageError(`'${CLI} lanes' is for tools`, `run '${CLI} lanes --json', or '${CLI} status' for people`);
      }
      const report = readRegistryStatus({
        dir: stateDir(deps.env),
        processes: deps.processes,
        devices: deps.devices,
        ...(deps.clock ? { clock: deps.clock } : {}),
      });
      const names: SessionNames = c => claudeSessionName(c.owner, deps.env);
      deps.stdout(
        values.json
          ? `${JSON.stringify({ version: 2, ...report, lanes: report.lanes.map(c => ({ ...c, sessionName: names(c) })) }, null, 2)}\n`
          : renderStatus(report, names),
      );
      return 0;
    }
    case 'touch': {
      const { values } = parseArgs({
        args,
        strict: true,
        options: { action: { type: 'string', default: 'touch' }, worktree: { type: 'string' } },
      });
      const who = owner();
      const registry = open(deps);
      try {
        const lane = registry.touchOwn(who, resolveFolder(values.worktree ?? deps.cwd).worktree, values.action);
        deps.stderr(`${TOOL}: touched lane ${lane.id} (${lane.lastAction})\n`);
        return 0;
      } finally {
        registry.close();
      }
    }
    case 'prune': {
      const { values } = parseArgs({
        args,
        strict: true,
        options: { yes: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
      });
      return prune(deps, values.yes, values.json);
    }
    default:
      throw new UsageError(`'${command}' is not a lanes command`, `run ${TOOL} --help`);
  }
}
