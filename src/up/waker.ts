import { stateDir } from '../registry/paths.ts';
import { Registry } from '../registry/registry.ts';
import type { EnvDeps } from './deps.ts';
import { laneDir, readUpRecord } from './lane-files.ts';
import { up } from './up.ts';
import type { LaneWaker } from './wake.ts';

/** How long waking a lane waits for a pool device, as `up` does by default. */
export const WAKE_WAIT_MS = 600_000;

/**
 * Wakes a lane through the steps `up` takes, minus setup and resource creation, for each platform `up` brought it up
 * for; a lane `up` never ran for gets its device back, booted if it was.
 */
export function upWaker(deps: EnvDeps): LaneWaker {
  return async (lane, park) => {
    const state = stateDir(deps.env);
    const record = readUpRecord(laneDir(state, lane.id));
    if (record) {
      for (const platform of record.platforms ?? [record.platform]) {
        await up(
          { ...deps, cwd: lane.worktree },
          { setup: false, cacheMode: 'use', waitMs: WAKE_WAIT_MS, worktree: lane.worktree, platform, waking: true },
        );
      }
      return;
    }
    const device = park.restarts.device;
    if (!device) return;
    const registry = Registry.open({
      dir: state,
      processes: deps.processes,
      ports: deps.ports,
      devices: deps.devices,
      clock: deps.clock,
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    });
    try {
      await registry.claim({
        owner: lane.owner,
        worktree: lane.worktree,
        projectRoot: lane.projectRoot,
        services: [],
        device: { platform: device.platform, deviceType: device.deviceType, runtime: device.runtime, prefer: device.name },
        waitMs: WAKE_WAIT_MS,
        boot: device.booted,
        action: 'wake',
      });
    } finally {
      registry.close();
    }
  };
}
