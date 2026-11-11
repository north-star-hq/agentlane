import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { systemClock, type Clock } from '../clock.ts';
import type { ProcessTable } from '../processes.ts';
import { laneDir, lastCallFile } from '../up/lane-files.ts';
import type { Owner } from './owner.ts';
import { tcpProbe } from './ports.ts';
import { Refusal } from './refusal.ts';
import { Registry } from './registry.ts';
import type { LaneRef } from './types.ts';

/** How long a one-shot lane call waits on a busy registry to record itself as the lane's last use before it goes on without. */
export const TOUCH_WAIT_MS = 250;
export const TOUCH_RETRY_MS = 500;
/** How often a call that runs for long, such as `exec`'s command or an `up` hook, counts again while it runs. */
export const HEARTBEAT_MS = 60_000;

export interface TouchSite {
  dir: string;
  processes: ProcessTable;
  clock?: Clock;
  /** How long to wait on a busy registry; callers that try again later pass 0. */
  waitMs?: number;
}

interface CallRecord {
  lane: string;
  at: number;
}

function tagOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function readCall(file: string): CallRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CallRecord>;
    return typeof raw.lane === 'string' && typeof raw.at === 'number' && Number.isFinite(raw.at)
      ? { lane: raw.lane, at: raw.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * Records `at` as the time of the lane's latest call in a file in the lane's folder, without the registry's lock, so a
 * call counts even while the registry is busy. The record names the lane's token, so a later lane given the same id
 * never reads it as its own.
 */
export function recordCall(stateDir: string, ref: LaneRef, at: number): void {
  try {
    const dir = laneDir(stateDir, ref.id);
    const file = lastCallFile(dir);
    const lane = tagOf(ref.token);
    const known = readCall(file);
    if (known?.lane === lane && known.at >= at) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lane, at } satisfies CallRecord));
    fs.renameSync(tmp, file);
  } catch {
    return;
  }
}

/**
 * The time of a lane's last call: the later of the registry's `last_used_at` and the call recorded in the lane's folder
 * while the registry was busy.
 */
export function laneLastCall(stateDir: string, lane: LaneRef & { lastUsedAt: number }): number {
  let recorded: CallRecord | null;
  try {
    recorded = readCall(lastCallFile(laneDir(stateDir, lane.id)));
  } catch {
    return lane.lastUsedAt;
  }
  return recorded?.lane === tagOf(lane.token) ? Math.max(lane.lastUsedAt, recorded.at) : lane.lastUsedAt;
}

function isBusy(error: unknown): boolean {
  return error instanceof Refusal && error.code === 'registry-busy';
}

function whenFree(site: TouchSite, body: (registry: Registry) => void): boolean {
  let registry: Registry;
  try {
    registry = Registry.open({
      dir: site.dir,
      processes: site.processes,
      ports: tcpProbe,
      devices: {},
      lockWaitMs: site.waitMs ?? TOUCH_WAIT_MS,
      ...(site.clock ? { clock: site.clock } : {}),
    });
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
  try {
    body(registry);
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  } finally {
    registry.close();
  }
}

/**
 * Writes a touch to the registry alone, for a caller that has already recorded the call. False when the registry
 * stayed busy; a lane that has ended throws.
 */
export function landTouch(site: TouchSite, ref: LaneRef, action: string): boolean {
  return whenFree(site, registry => {
    registry.touch(ref, action);
  });
}

/**
 * Records a call as its lane's last use. False when the registry stayed busy for the site's wait, so only the lane's
 * folder holds the call; a lane that has ended throws.
 */
export function touchLane(site: TouchSite, ref: LaneRef, action: string): boolean {
  recordCall(site.dir, ref, (site.clock ?? systemClock).now());
  return landTouch(site, ref, action);
}

/** As touchLane, for the lane the owner holds in a folder; a folder with no lane of the owner's is left alone. */
export function touchOwnLane(site: TouchSite, owner: Owner, worktree: string, action: string): boolean {
  return whenFree(site, registry => {
    const lane = registry.find(owner, worktree);
    if (!lane) return;
    const ref = { id: lane.id, token: lane.token };
    recordCall(site.dir, ref, (site.clock ?? systemClock).now());
    registry.touch(ref, action);
  });
}

/**
 * Touches the lane every `everyMs` until the returned function is called, so a call that runs for long keeps counting
 * while it runs. It never waits on a busy registry, and stops once the lane has ended.
 */
export function keepTouching(site: TouchSite, ref: LaneRef, action: string, everyMs = HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    try {
      touchLane({ ...site, waitMs: 0 }, ref, action);
    } catch {
      clearInterval(timer);
    }
  }, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

/**
 * Touches for a long-lived caller, such as the MCP server: the call is recorded at once, and a touch the busy registry
 * refused is tried again every `retryMs`, never waiting on the lock, until it lands, the lane ends, or a later touch
 * takes its place.
 */
export class LaneToucher {
  private readonly site: TouchSite;
  private readonly retryMs: number;
  private retry: NodeJS.Timeout | undefined;

  constructor(site: TouchSite, retryMs = TOUCH_RETRY_MS) {
    this.site = { ...site, waitMs: 0 };
    this.retryMs = retryMs;
  }

  touch(ref: LaneRef, action: string): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    if (!touchLane(this.site, ref, action)) this.later(ref, action);
  }

  private later(ref: LaneRef, action: string): void {
    this.retry = setTimeout(() => {
      this.retry = undefined;
      let landed: boolean;
      try {
        landed = landTouch(this.site, ref, action);
      } catch {
        return;
      }
      if (!landed) this.later(ref, action);
    }, this.retryMs);
    this.retry.unref();
  }
}
