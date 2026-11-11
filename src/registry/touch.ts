import type { Clock } from '../clock.ts';
import type { ProcessTable } from '../processes.ts';
import type { Owner } from './owner.ts';
import { tcpProbe } from './ports.ts';
import { Refusal } from './refusal.ts';
import { Registry } from './registry.ts';
import type { LaneRef } from './types.ts';

/** How long a lane call waits on a busy registry to record itself as the lane's last use before it goes on without. */
export const TOUCH_WAIT_MS = 250;
export const TOUCH_RETRY_MS = 500;

export interface TouchSite {
  dir: string;
  processes: ProcessTable;
  clock?: Clock;
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
      lockWaitMs: TOUCH_WAIT_MS,
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
 * Records a call as its lane's last use. False when the registry stayed busy for TOUCH_WAIT_MS, so the call goes on
 * unrecorded; a lane that has ended throws.
 */
export function touchLane(site: TouchSite, ref: LaneRef, action: string): boolean {
  return whenFree(site, registry => {
    registry.touch(ref, action);
  });
}

/** As touchLane, for the lane the owner holds in a folder; a folder with no lane of the owner's is left alone. */
export function touchOwnLane(site: TouchSite, owner: Owner, worktree: string, action: string): boolean {
  return whenFree(site, registry => {
    const lane = registry.find(owner, worktree);
    if (lane) registry.touch({ id: lane.id, token: lane.token }, action);
  });
}

/**
 * Touches for a long-lived caller, such as the MCP server: a touch the busy registry refused is tried again every
 * `retryMs` until it lands, the lane ends, or a later touch takes its place.
 */
export class LaneToucher {
  private readonly site: TouchSite;
  private readonly retryMs: number;
  private retry: NodeJS.Timeout | undefined;

  constructor(site: TouchSite, retryMs = TOUCH_RETRY_MS) {
    this.site = site;
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
        landed = touchLane(this.site, ref, action);
      } catch {
        return;
      }
      if (!landed) this.later(ref, action);
    }, this.retryMs);
    this.retry.unref();
  }
}
