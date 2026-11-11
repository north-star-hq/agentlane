import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { rotateLog } from '../disk-limits.ts';
import { messageOf } from '../driver/errors.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { systemProcesses } from '../processes.ts';
import type { RegistryConfig } from '../registry/config.ts';
import { isProven, judgeProcess, ownerState, worktreeState } from '../registry/owner.ts';
import { describeRestarts } from '../registry/parks.ts';
import { databasePath } from '../registry/paths.ts';
import type { PortProbe } from '../registry/ports.ts';
import { tcpProbe } from '../registry/ports.ts';
import type { ParkCandidate } from '../registry/registry.ts';
import { Registry } from '../registry/registry.ts';
import { laneLastCall, TOUCH_WAIT_MS } from '../registry/touch.ts';
import type { ParkDeps, ParkOutcome } from './park.ts';
import { PARK_RETRY_MS, parkLane } from './park.ts';

export const SWEEP_COMMAND = 'sweep';

/** How long after starting a sweeper the commands passing by leave the sweep to it. */
export const SWEEP_RESPAWN_MS = 2 * 60_000;
export const SWEEP_LOG_MAX_BYTES = 1024 * 1024;

interface SweepMark {
  startedAt: number;
  finishedAt: number | null;
  /** Lanes whose owner the last sweep found dead: the sweep that ends such lanes is a claim's, not this one. */
  leftAlone: string[];
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
    return {
      startedAt: raw.startedAt,
      finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
      leftAlone: Array.isArray(raw.leftAlone) ? raw.leftAlone.filter((id): id is string => typeof id === 'string') : [],
    };
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

/**
 * Whether the sweep has work: a lane to park, or one a park or wake left partway. One read of the registry, plus the
 * lane-folder call record of each lane the registry has as unused for the park window; no process starts.
 */
export function sweepDue(site: SweepSite): boolean {
  if (!fs.existsSync(databasePath(site.dir))) return false;
  const now = (site.clock ?? systemClock).now();
  const left = new Set(readMark(site.dir)?.leftAlone ?? []);
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
    return registry
      .parkCandidates(idleSince, now - PARK_RETRY_MS)
      .some(c => !left.has(c.ref.id) && unused(site.dir, c, idleSince));
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
    writeMark(site.dir, { startedAt: now, finishedAt: null, leftAlone: mark?.leftAlone ?? [] });
    start(site.dir);
    return true;
  } catch {
    return false;
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

export interface SweepReport {
  outcomes: ParkOutcome[];
  /** Lanes left to a claim's sweep because their owner is dead. */
  leftAlone: string[];
}

/** The sweep's work, in the process that does it: parks each lane whose owner is alive and left it unused. */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  const say = deps.log ?? (() => undefined);
  const report: SweepReport = { outcomes: [], leftAlone: [] };
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
    const idleSince = now - registry.config.parkMs;
    const candidates = registry.parkCandidates(idleSince, now - PARK_RETRY_MS).filter(c => unused(deps.dir, c, idleSince));
    const pids = candidates.flatMap(c => (c.owner.process ? [c.owner.process.pid] : []));
    const table = pids.length > 0 ? deps.processes.startTimes(pids) : new Map<number, string>();
    for (const candidate of candidates) {
      const state = ownerState(judgeProcess(candidate.owner.process, table), worktreeState(candidate.worktree));
      if (isProven(state)) {
        report.leftAlone.push(candidate.ref.id);
        continue;
      }
      try {
        const outcome = await parkLane(deps, registry, candidate, idleSince);
        report.outcomes.push(outcome);
        if (outcome.kind === 'parked') {
          say(`parked lane ${outcome.lane}; its next call brings back ${describeRestarts(outcome.restarts)}`);
          for (const line of outcome.notes) say(`lane ${outcome.lane}: ${line}`);
          for (const line of outcome.problems) say(`lane ${outcome.lane}: PROBLEM: ${line}`);
        } else say(`left lane ${outcome.lane} awake: ${outcome.reason}`);
      } catch (error) {
        say(`lane ${candidate.ref.id}: PROBLEM: parking stopped partway: ${messageOf(error)}`);
      }
    }
    return report;
  } finally {
    registry.close();
    writeMark(deps.dir, {
      startedAt: readMark(deps.dir)?.startedAt ?? deps.clock.now(),
      finishedAt: deps.clock.now(),
      leftAlone: report.leftAlone,
    });
  }
}
