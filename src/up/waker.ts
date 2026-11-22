import { stateDir } from '../registry/paths.ts';
import { Registry } from '../registry/registry.ts';
import type { EnvDeps } from './deps.ts';
import { laneDir, readUpRecord, upPlatforms, wakeFolder } from './lane-files.ts';
import { up, type UpOptions } from './up.ts';
import { WAKE_WAIT_MS, type LaneWaker } from './wake.ts';

/**
 * Wakes a lane through the steps `up` takes, minus setup and resource creation, for each platform `up` brought it up
 * for; a lane with the project's data only gets the shared services its resources need back, and nothing else; a lane
 * `up` never ran for gets its device back, booted if it was.
 */
export function upWaker(deps: EnvDeps): LaneWaker {
  return async (lane, park) => {
    const state = stateDir(deps.env);
    const record = readUpRecord(laneDir(state, lane.id));
    if (record) {
      const folder = wakeFolder(state, lane);
      const wake: UpOptions = { setup: false, cacheMode: 'use', waitMs: WAKE_WAIT_MS, worktree: folder, waking: true };
      const platforms = upPlatforms(record);
      if (platforms.length === 0) await up({ ...deps, cwd: folder }, { ...wake, app: false });
      for (const platform of platforms) await up({ ...deps, cwd: folder }, { ...wake, platform });
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
