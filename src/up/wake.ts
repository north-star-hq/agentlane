import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { DriverError, messageOf } from '../driver/errors.ts';
import { CLI, TOOL } from '../name.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { formatAge, formatTime } from '../registry/format.ts';
import type { LanePark } from '../registry/parks.ts';
import { describeRestarts } from '../registry/parks.ts';
import { tcpProbe } from '../registry/ports.ts';
import { NotClaimed, Refusal } from '../registry/refusal.ts';
import { Registry } from '../registry/registry.ts';
import type { Lane, LaneRef } from '../registry/types.ts';
import { wakeFolder } from './lane-files.ts';
import { attemptId, deadHolder } from './park.ts';

/** How long a call waits on another call parking or waking its lane. */
export const LANE_WAIT_MS = 30 * 60_000;

export interface LaneEntry {
  stateDir: string;
  processes: ProcessTable;
  clock?: Clock;
  pollMs?: number;
  waitMs?: number;
  /** This process's identity, for a process table that can't read it. */
  self?: ProcessIdentity;
}

export interface WakeHandle {
  ref: LaneRef;
  attempt: string;
  park: LanePark;
}

/** Brings a parked lane back: its device, its services, its app and its browser, as `park` says it had them. */
export type LaneWaker = (lane: Lane, park: LanePark) => Promise<void>;

function openRegistry(entry: LaneEntry): Registry {
  return Registry.open({
    dir: entry.stateDir,
    processes: entry.processes,
    ports: tcpProbe,
    devices: {},
    ...(entry.clock ? { clock: entry.clock } : {}),
    ...(entry.self ? { self: entry.self } : {}),
  });
}

function stillBusy(ref: LaneRef, worktree: string, park: LanePark, waitedMs: number): Refusal {
  const woken = park.state === 'waking';
  const pid = park.holder?.pid;
  return new Refusal(
    'lane-busy',
    `lane ${ref.id} is still being ${woken ? 'brought back' : 'parked'} by another call, ${formatAge(waitedMs)} after this one began waiting`,
    [
      {
        who: `a process ${woken ? 'bringing the lane back' : 'parking the lane'} (pid ${String(pid ?? 'unknown')})`,
        folder: worktree,
        since: formatTime(park.since),
      },
    ],
    [
      `retry the same ${TOOL} command once it finishes`,
      `${CLI} status   (the lane, and the process parking or waking it)`,
      ...(pid === undefined
        ? []
        : [`kill ${String(pid)}   (only if that process is hung; the next call then takes the lane over)`]),
    ],
  );
}

/**
 * For a call on a lane its owner holds, once the call is recorded: waits out a park or wake of the lane another call
 * runs, then takes the lane for waking if it is parked, so no other call wakes it meanwhile. Null when it is awake.
 */
export async function takeLane(entry: LaneEntry, ref: LaneRef): Promise<WakeHandle | null> {
  const clock = entry.clock ?? systemClock;
  const started = clock.now();
  const registry = openRegistry(entry);
  try {
    for (;;) {
      const seen = registry.parkOf(ref.id);
      if (!seen) return null;
      const attempt = attemptId();
      const start = registry.beginWake(ref, attempt, deadHolder(seen, entry.processes));
      if (start.kind === 'awake') return null;
      if (start.kind === 'taken') return { ref, attempt, park: start.park };
      const waited = clock.now() - started;
      if (waited >= (entry.waitMs ?? LANE_WAIT_MS)) throw stillBusy(ref, start.worktree, start.park, waited);
      await clock.sleep(entry.pollMs ?? 250);
    }
  } finally {
    registry.close();
  }
}

/** Ends a wake: the lane is awake when `failure` is null, and parked again with the failure otherwise. */
export function settleWake(entry: LaneEntry, handle: WakeHandle, failure: unknown): void {
  const registry = openRegistry(entry);
  try {
    if (failure === null) registry.finishWake(handle.ref, handle.attempt);
    else registry.giveUp(handle.ref, handle.attempt, [`the last call could not bring it back: ${messageOf(failure)}`]);
  } finally {
    registry.close();
  }
}

let waking: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = waking.then(work, work);
  waking = next.catch(() => undefined);
  return next;
}

/**
 * Makes sure a lane is awake before a call on it runs, the call having been recorded before `park` was read: waits out
 * a park or wake another call runs, and wakes the lane with `wake` if it is parked. Returns the lane as it is then.
 */
export async function enterLane(
  entry: LaneEntry,
  lane: Lane,
  park: LanePark | null,
  wake: LaneWaker | undefined,
  log: (line: string) => void = () => undefined,
): Promise<Lane> {
  if (!park) return lane;
  if (!wake) {
    throw new NotClaimed(
      `lane ${lane.id} is parked: it went unused, so its device went back to the pool and its services stopped, and this call can't bring them back`,
      `${CLI} up   (run in ${wakeFolder(entry.stateDir, lane)}; it brings back ${describeRestarts(park.restarts)})`,
    );
  }
  const handle = await takeLane(entry, { id: lane.id, token: lane.token });
  if (handle) {
    const since =
      handle.park.parkedAt === null ? '' : ` ${formatAge((entry.clock ?? systemClock).now() - handle.park.parkedAt)} ago`;
    log(`lane ${lane.id} was parked${since}; bringing back ${describeRestarts(handle.park.restarts)}`);
    let failure: unknown = null;
    try {
      await oneAtATime(() => wake(lane, handle.park));
    } catch (error) {
      failure = error;
    }
    settleWake(entry, handle, failure);
    if (failure !== null) {
      throw new DriverError(
        `could not bring lane ${lane.id} back: ${messageOf(failure)}`,
        `fix that and call again: the lane stays parked, and its next call tries again (${CLI} up in ${wakeFolder(entry.stateDir, lane)} shows each step)`,
      );
    }
  }
  const registry = openRegistry(entry);
  try {
    const now = registry.find(lane.owner, lane.worktree);
    if (now?.id !== lane.id) throw new NotClaimed(`lane ${lane.id} has ended`, `${CLI} up   (run in ${lane.worktree})`);
    return now;
  } finally {
    registry.close();
  }
}
