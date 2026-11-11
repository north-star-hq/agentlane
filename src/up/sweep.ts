import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stopEndedBrowsers } from '../browser/lane-browser.ts';
import { realBrowserTools } from '../browser/tools.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { DeviceBackend, Platform } from '../devices/backend.ts';
import { rotateLog } from '../disk-limits.ts';
import { messageOf } from '../driver/errors.ts';
import { realEvidenceSystem } from '../evidence/device.ts';
import { laneEvidence } from '../evidence/evidence.ts';
import type { StrayRecorder } from '../evidence/strays.ts';
import { describeStray, stopStrayRecorder, strayDue } from '../evidence/strays.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { systemProcesses } from '../processes.ts';
import type { RegistryConfig } from '../registry/config.ts';
import { formatAge, formatTime } from '../registry/format.ts';
import type { ProvenState } from '../registry/owner.ts';
import { describeHostSession, describeState, isProven, judgeProcess, ownerState, worktreeState } from '../registry/owner.ts';
import { OWNER_CHECK_MS, REAP_RETRY_MS, RETURN_WINDOW_MS } from '../registry/owner-checks.ts';
import { describeRestarts } from '../registry/parks.ts';
import { databasePath } from '../registry/paths.ts';
import type { PortProbe } from '../registry/ports.ts';
import { tcpProbe } from '../registry/ports.ts';
import type { JudgedOwner, ParkCandidate, SweptLane } from '../registry/registry.ts';
import { Registry } from '../registry/registry.ts';
import { laneLastCall, TOUCH_WAIT_MS } from '../registry/touch.ts';
import { leadersAliveAt } from '../services/services.ts';
import { LANE_FILES_KEEP_MS, laneFolderIds, pruneEndedLaneFiles } from './lane-files.ts';
import type { ParkDeps, ParkOutcome } from './park.ts';
import { attemptId, deadHolder, PARK_RETRY_MS, parkLane } from './park.ts';
import { tearDownLane } from './release.ts';
import { tearDownEndedResources } from './resources.ts';

export const SWEEP_COMMAND = 'sweep';

/** How long after starting a sweeper the commands passing by leave the sweep to it. */
export const SWEEP_RESPAWN_MS = 2 * 60_000;
/** How often each running MCP server passes by, for every lane on the Mac. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;
export const SWEEP_LOG_MAX_BYTES = 1024 * 1024;
/**
 * How old the moment a lane's service leader was last seen running may grow before a sweep is due to look again. A stop
 * whose leader has exited proves ours only the processes of its group that started before that moment, so a longer
 * wait leaves more of them unproven; a shorter one starts a sweeper more often while the lanes are in use.
 */
export const ALIVE_REFRESH_MS = 10 * 60_000;

interface SweepMark {
  startedAt: number;
  finishedAt: number | null;
}

function markFile(dir: string): string {
  return path.join(dir, 'sweep.json');
}

export function sweepLog(dir: string): string {
  return path.join(dir, 'sweep.log');
}

function readMark(dir: string): SweepMark | null {
  try {
    const raw = JSON.parse(fs.readFileSync(markFile(dir), 'utf8')) as Partial<SweepMark>;
    if (typeof raw.startedAt !== 'number') return null;
    return { startedAt: raw.startedAt, finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null };
  } catch {
    return null;
  }
}

function writeMark(dir: string, mark: SweepMark): void {
  const file = markFile(dir);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(mark));
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

export interface SweepSite {
  dir: string;
  clock?: Clock;
  processes?: ProcessTable;
}

function unused(dir: string, candidate: ParkCandidate, idleSince: number): boolean {
  return laneLastCall(dir, { ...candidate.ref, lastUsedAt: candidate.lastUsedAt }) <= idleSince;
}

/** Whether no check or call has shown the lane's owner alive for OWNER_CHECK_MS, so the sweep asks the process table. */
function unseen(dir: string, lane: SweptLane, now: number): boolean {
  if (lane.gone || !lane.owner.process) return false;
  const since = now - OWNER_CHECK_MS;
  if (Math.max(lane.checkedAt ?? Number.NEGATIVE_INFINITY, lane.lastUsedAt) > since) return false;
  return laneLastCall(dir, { ...lane.ref, lastUsedAt: lane.lastUsedAt }) <= since;
}

/**
 * Whether a lane records a service whose leader no check has seen running for ALIVE_REFRESH_MS, and no sweep has
 * finished since then: one that did found that leader gone, or could not tell, and waits as long for the next look.
 */
function aliveRefreshDue(registry: Registry, mark: SweepMark | null, now: number): boolean {
  const since = now - ALIVE_REFRESH_MS;
  if ((mark?.finishedAt ?? Number.NEGATIVE_INFINITY) > since) return false;
  return registry.serviceProcesses().some(p => (p.process.aliveAt ?? Number.NEGATIVE_INFINITY) <= since);
}

/** The lane folders, listed before `lanes` was read, of lanes that have ended. */
function endedFolders(folders: readonly string[], lanes: readonly SweptLane[]): string[] {
  const live = new Set(lanes.map(l => l.ref.id));
  return folders.filter(id => !live.has(id));
}

/** Whether a lane whose owner is gone is still to be parked: never yet, or a park left it running or stopped partway. */
function goneParkDue(lane: SweptLane, now: number): boolean {
  const park = lane.park;
  if (!park) return true;
  if (park.since > now - PARK_RETRY_MS) return false;
  return park.state !== 'parked' || lane.running;
}

/** Whether a lane whose owner is gone has stayed gone through its window, and no process is ending it lately. */
function reapDue(lane: SweptLane, now: number): boolean {
  const gone = lane.gone;
  if (!gone || now < gone.foundAt + RETURN_WINDOW_MS || lane.running) return false;
  return gone.reapingSince === null || gone.reapingSince <= now - REAP_RETRY_MS;
}

/**
 * Whether the sweep has work: an owner no check or call has shown alive lately, a lane whose owner is gone to park or
 * end, a lane no hold keeps up to park, or one a park or wake left partway; a service leader not seen running lately;
 * a device recorder an ended lane left marked as running. One read of the registry, plus the lane-folder call record
 * of each lane the registry has as unused and the lane folders' list; no process starts.
 */
export function sweepDue(site: SweepSite): boolean {
  if (!fs.existsSync(databasePath(site.dir))) return false;
  const now = (site.clock ?? systemClock).now();
  const registry = Registry.open({
    dir: site.dir,
    processes: site.processes ?? systemProcesses,
    ports: tcpProbe,
    devices: {},
    lockWaitMs: TOUCH_WAIT_MS,
    ...(site.clock ? { clock: site.clock } : {}),
  });
  try {
    const idleSince = now - registry.config.parkMs;
    const folders = laneFolderIds(site.dir);
    const lanes = registry.sweepList();
    const gone = new Set(lanes.filter(l => l.gone).map(l => l.ref.id));
    if (lanes.some(l => (l.gone ? goneParkDue(l, now) || reapDue(l, now) : unseen(site.dir, l, now)))) return true;
    if (aliveRefreshDue(registry, readMark(site.dir), now)) return true;
    if (endedFolders(folders, lanes).some(id => strayDue(laneEvidence(site.dir, id), now))) return true;
    return registry
      .parkCandidates(idleSince, now - PARK_RETRY_MS)
      .some(c => c.hold === null && !gone.has(c.ref.id) && unused(site.dir, c, idleSince));
  } finally {
    registry.close();
  }
}

/**
 * The sweep every command runs as it passes by: when there is work and no sweeper started lately, it starts one with
 * `start`, which does the work in a process of its own, so the command never waits on it. It never fails the command.
 */
export function passBy(site: SweepSite, start: (dir: string) => void): boolean {
  try {
    const now = (site.clock ?? systemClock).now();
    const mark = readMark(site.dir);
    if (mark?.finishedAt === null && now - mark.startedAt < SWEEP_RESPAWN_MS) return false;
    if (!sweepDue(site)) return false;
    writeMark(site.dir, { startedAt: now, finishedAt: null });
    start(site.dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a running MCP server does every SWEEP_INTERVAL_MS: it lands the device work its own calls could not record as
 * done, then passes by. Neither waits on a teardown, so the server's tool calls never wait on its sweep.
 */
export function sweepTick(
  site: SweepSite,
  devices: Partial<Record<Platform, DeviceBackend>>,
  start: (dir: string) => void,
): boolean {
  settleLeftovers(site, devices);
  return passBy(site, start);
}

function settleLeftovers(site: SweepSite, devices: Partial<Record<Platform, DeviceBackend>>): void {
  if (!Registry.holdsLeftovers(site.dir)) return;
  try {
    const registry = Registry.open({
      dir: site.dir,
      processes: site.processes ?? systemProcesses,
      ports: tcpProbe,
      devices,
      lockWaitMs: TOUCH_WAIT_MS,
      ...(site.clock ? { clock: site.clock } : {}),
    });
    try {
      registry.settleOwn();
    } finally {
      registry.close();
    }
  } catch {
    return;
  }
}

/** Starts `<cli> sweep` detached, appending to the state folder's sweep log. */
export function sweeper(cli: string, env: NodeJS.ProcessEnv): (dir: string) => void {
  return dir => {
    const log = sweepLog(dir);
    rotateLog(log, SWEEP_LOG_MAX_BYTES);
    const fd = fs.openSync(log, 'a');
    try {
      const child = spawn(process.execPath, [cli, SWEEP_COMMAND], { env, detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
    } finally {
      fs.closeSync(fd);
    }
  };
}

export interface SweepDeps extends ParkDeps {
  dir: string;
  ports: PortProbe;
  log?: (line: string) => void;
  /** The registry's settings when not its config.json's, and this process's identity when the process table can't read it. */
  config?: RegistryConfig;
  self?: ProcessIdentity;
}

export interface FoundGone {
  lane: string;
  state: ProvenState;
}

export type ReapOutcome =
  | { kind: 'ended'; lane: string; state: ProvenState; foundAt: number; notes: string[]; problems: string[] }
  | { kind: 'left'; lane: string; reason: string };

export interface LeaderSeen {
  lane: string;
  service: string;
  aliveAt: number;
}

export interface SweepReport {
  /** Lanes whose owner this sweep asked the process table about, since no check or call had shown it alive lately. */
  checked: string[];
  /** Lanes whose owner this sweep found gone: each is parked now and ended RETURN_WINDOW_MS later, unless its session comes back. */
  found: FoundGone[];
  outcomes: ParkOutcome[];
  /** Lanes left up because their owner holds them. */
  held: string[];
  /** Lanes whose owner stayed gone through its window, ended as a release ends a lane. */
  reaps: ReapOutcome[];
  /** The service leaders this sweep saw running, whose recorded moment it moved on so a later stop can prove their groups. */
  alive: LeaderSeen[];
  /** The device recorders of ended lanes this sweep looked at: stopped, found gone, or left running unproven. */
  recorders: StrayRecorder[];
  /** The ended lanes whose files this sweep removed, LANE_FILES_KEEP_MS after they ended. */
  pruned: string[];
  /** What the sweep could not do, each line naming its lane. */
  problems: string[];
}

/** Records the moment each service leader the lanes record was seen running, as `waitForService` does at its start. */
function refreshLeaders(deps: SweepDeps, registry: Registry, say: (line: string) => void): LeaderSeen[] {
  const leaders = registry.serviceProcesses();
  const seen = leadersAliveAt(deps.system, leaders, deps.clock);
  if (!seen) {
    say(`could not read whether the services of lanes ${[...new Set(leaders.map(l => l.lane))].join(', ')} run`);
    return [];
  }
  return registry
    .recordLeadersAlive(seen.alive, seen.at)
    .map(l => ({ lane: l.lane, service: l.process.service, aliveAt: seen.at }));
}

function judged(lane: SweptLane): JudgedOwner {
  return { id: lane.ref.id, ownerKey: lane.ownerKey, process: lane.owner.process };
}

function untilEnd(lane: SweptLane, foundAt: number): string {
  const session = describeHostSession(lane.owner);
  const ends = `ends at ${formatTime(foundAt + RETURN_WINDOW_MS)}`;
  return session ? `${ends} unless ${session} comes back` : `${ends}; nothing can take it back`;
}

async function reapLane(
  deps: SweepDeps,
  registry: Registry,
  lane: SweptLane,
  dead: readonly ProcessIdentity[],
): Promise<ReapOutcome> {
  const { ref } = lane;
  const attempt = attemptId();
  const start = registry.beginReap(ref, attempt, dead);
  if (start.kind === 'left') return { kind: 'left', lane: ref.id, reason: start.reason };
  try {
    const teardown = await tearDownLane(
      { ...deps, sim: deps.sim ?? null, browser: deps.browser ?? realBrowserTools },
      deps.dir,
      start.lane,
    );
    const notes = [...teardown.notes];
    const ended = registry.endReaped(ref, attempt, notes);
    if (!ended) return { kind: 'left', lane: ref.id, reason: 'another call took it while it was being ended' };
    const after = [
      ...(await stopEndedBrowsers(deps.browser ?? realBrowserTools, registry, deps.dir, deps.clock)).filter(
        t => t.lane === ref.id,
      ),
      ...(await tearDownEndedResources(deps, registry, deps.dir, { lane: ref.id })),
    ];
    return {
      kind: 'ended',
      lane: ref.id,
      state: start.gone.state,
      foundAt: start.gone.foundAt,
      notes: [...notes, ...after.flatMap(t => t.notes)],
      problems: [...teardown.problems, ...after.flatMap(t => t.problems)],
    };
  } catch (error) {
    registry.abortReap(ref, attempt);
    throw error;
  }
}

/**
 * The sweep's work, in the process that does it, for every lane on the Mac. It asks the process table once about the
 * owners no check or call has shown alive lately. A lane whose owner it finds gone is parked at once, and ended with
 * what a release does RETURN_WINDOW_MS after it was found gone, unless a process of its owner's session takes it back
 * first. It parks each lane whose owner left it unused for the park window and holds it no more.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  const say = deps.log ?? (() => undefined);
  const report: SweepReport = {
    checked: [],
    found: [],
    outcomes: [],
    held: [],
    reaps: [],
    alive: [],
    recorders: [],
    pruned: [],
    problems: [],
  };
  const problem = (lane: string, line: string) => {
    report.problems.push(`lane ${lane}: ${line}`);
    say(`lane ${lane}: PROBLEM: ${line}`);
  };
  const registry = Registry.open({
    dir: deps.dir,
    processes: deps.processes,
    ports: deps.ports,
    devices: deps.devices,
    clock: deps.clock,
    ...(deps.config ? { config: deps.config } : {}),
    ...(deps.self ? { self: deps.self } : {}),
  });
  try {
    const now = deps.clock.now();
    const lanes = registry.sweepList();
    report.alive = refreshLeaders(deps, registry, say);
    const unseenLanes = new Set(lanes.filter(l => unseen(deps.dir, l, now)));
    const stuckReapers = lanes.flatMap(l => (l.gone?.reaper && reapDue(l, now) ? [l.gone.reaper] : []));
    const pids = [
      ...[...unseenLanes].flatMap(l => (l.owner.process ? [l.owner.process.pid] : [])),
      ...stuckReapers.map(r => r.pid),
    ];
    const table = pids.length > 0 ? deps.processes.startTimes(pids) : new Map<number, string>();
    report.checked = [...unseenLanes].map(l => l.ref.id);

    const seen: JudgedOwner[] = [];
    const gone: (JudgedOwner & { state: ProvenState })[] = [];
    for (const lane of lanes) {
      if (lane.gone) continue;
      const verdict = unseenLanes.has(lane)
        ? judgeProcess(lane.owner.process, table)
        : lane.owner.process
          ? 'alive'
          : 'cant-tell';
      const state = ownerState(verdict, worktreeState(lane.worktree));
      if (isProven(state)) gone.push({ ...judged(lane), state });
      else if (unseenLanes.has(lane)) seen.push(judged(lane));
    }
    const found = new Set(registry.noteOwners(seen, gone));
    for (const g of gone) {
      const lane = lanes.find(l => l.ref.id === g.id);
      if (!found.has(g.id) || !lane) continue;
      report.found.push({ lane: g.id, state: g.state });
      say(
        `found the owner of lane ${g.id} gone (${describeState(g.state)}): the lane is parked now, and it ${untilEnd(lane, now)}`,
      );
      if (lane.hold) say(`ended the hold on lane ${g.id}, "${lane.hold.reason}": ${describeState(g.state)}`);
    }

    const goneLanes = (found.size > 0 ? registry.sweepList() : lanes).filter(l => l.gone !== null);
    for (const lane of goneLanes) {
      if (!lane.gone || !goneParkDue(lane, now)) continue;
      try {
        const outcome = await parkLane(deps, registry, lane, 'owner-gone');
        report.outcomes.push(outcome);
        if (outcome.kind === 'parked') {
          say(`parked lane ${outcome.lane}, whose owner is gone; it ${untilEnd(lane, lane.gone.foundAt)}`);
          for (const line of outcome.problems) problem(outcome.lane, line);
        } else say(`left lane ${outcome.lane} as it was: ${outcome.reason}`);
      } catch (error) {
        problem(lane.ref.id, `parking stopped partway: ${messageOf(error)}`);
      }
    }

    const idleSince = now - registry.config.parkMs;
    const goneIds = new Set(goneLanes.map(l => l.ref.id));
    for (const candidate of registry.parkCandidates(idleSince, now - PARK_RETRY_MS)) {
      if (goneIds.has(candidate.ref.id) || !unused(deps.dir, candidate, idleSince)) continue;
      if (candidate.hold) {
        report.held.push(candidate.ref.id);
        continue;
      }
      try {
        const outcome = await parkLane(deps, registry, candidate, idleSince);
        report.outcomes.push(outcome);
        if (outcome.kind === 'parked') {
          say(`parked lane ${outcome.lane}; its next call brings back ${describeRestarts(outcome.restarts)}`);
          for (const line of outcome.notes) say(`lane ${outcome.lane}: ${line}`);
          for (const line of outcome.problems) problem(outcome.lane, line);
        } else say(`left lane ${outcome.lane} awake: ${outcome.reason}`);
      } catch (error) {
        problem(candidate.ref.id, `parking stopped partway: ${messageOf(error)}`);
      }
    }

    for (const lane of goneIds.size > 0 ? registry.sweepList() : []) {
      const reaper = lane.gone?.reaper ?? null;
      if (!reapDue(lane, now)) continue;
      const dead = [
        ...(reaper && isProven(judgeProcess(reaper, table)) ? [reaper] : []),
        ...[deadHolder(lane.park, deps.processes)].filter((p): p is ProcessIdentity => p !== null),
      ];
      try {
        const outcome = await reapLane(deps, registry, lane, dead);
        report.reaps.push(outcome);
        if (outcome.kind === 'ended') {
          say(
            `ended lane ${outcome.lane}: its owner was found gone (${describeState(outcome.state)}) at ${formatTime(outcome.foundAt)}, ${formatAge(now - outcome.foundAt)} ago, and did not come back`,
          );
          for (const line of outcome.notes) say(`lane ${outcome.lane}: ${line}`);
          for (const line of outcome.problems) problem(outcome.lane, line);
        } else say(`did not end lane ${outcome.lane} yet: ${outcome.reason}`);
      } catch (error) {
        problem(lane.ref.id, `ending it stopped partway: ${messageOf(error)}`);
      }
    }

    const folders = laneFolderIds(deps.dir);
    for (const id of endedFolders(folders, registry.sweepList())) {
      const evidence = laneEvidence(deps.dir, id);
      if (!strayDue(evidence, now)) continue;
      try {
        const stray = await stopStrayRecorder(deps.evidence ?? realEvidenceSystem, evidence, id, deps.clock);
        if (!stray) continue;
        report.recorders.push(stray);
        if (stray.kind === 'cant-tell' || stray.kind === 'survived') problem(id, describeStray(stray));
        else say(`lane ${id}: ${describeStray(stray)}`);
        if (stray.kind === 'stopped' || stray.kind === 'survived') for (const line of stray.problems) problem(id, line);
      } catch (error) {
        problem(id, `stopping the recorder it left stopped partway: ${messageOf(error)}`);
      }
    }

    report.pruned = pruneEndedLaneFiles(deps.dir, registry.keptLaneIds(now - LANE_FILES_KEEP_MS), now, deps.env);
    if (report.pruned.length > 0) say(`removed the files of ended lanes ${report.pruned.join(', ')}`);
    return report;
  } finally {
    registry.close();
    writeMark(deps.dir, { startedAt: readMark(deps.dir)?.startedAt ?? deps.clock.now(), finishedAt: deps.clock.now() });
  }
}
