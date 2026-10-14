import { laneEnvironment } from '../hooks/env.ts';
import { CLI, CONFIG_FILE, TOOL } from '../name.ts';
import type { ServiceConfig } from '../project/config.ts';
import { findProjectConfig, loadLaneConfig } from '../project/config.ts';
import { describeOwner, resolveOwner } from '../registry/owner.ts';
import { stateDir } from '../registry/paths.ts';
import { NotClaimed, UsageError } from '../registry/refusal.ts';
import { Registry } from '../registry/registry.ts';
import type { ServiceProcess } from '../registry/types.ts';
import { resolveFolder } from '../registry-cli.ts';
import { ServiceFailed } from '../services/services.ts';
import { laneDir, readUpRecord } from './lane-files.ts';
import type { LaneServices } from './lane-services.ts';
import { claimedPort, recordedProcess, startClaimedService, stopClaimedService } from './lane-services.ts';
import type { EnvDeps } from './deps.ts';

export interface RestartedService {
  service: string;
  port: number;
  stopped: string;
  started: string;
  ms: number;
}

export interface RestartResult {
  lane: string;
  services: RestartedService[];
}

interface Target {
  service: ServiceConfig;
  port: number;
  recorded: ServiceProcess;
}

export async function restart(deps: EnvDeps, names: readonly string[], worktree?: string): Promise<RestartResult> {
  if (names.length === 0) {
    throw new UsageError('restart needs the name of a service', `${CLI} restart <service>, e.g. KEY=value ${CLI} restart api`);
  }
  const folder = resolveFolder(worktree ?? deps.cwd);
  const owner = resolveOwner(deps.env, deps.processes, deps.selfPid);
  const state = stateDir(deps.env);
  const registry = Registry.open({
    dir: state,
    processes: deps.processes,
    ports: deps.ports,
    devices: deps.devices,
    clock: deps.clock,
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
  });
  try {
    const lane = registry.find(owner, folder.worktree);
    if (!lane) {
      throw new NotClaimed(
        `${describeOwner(owner)} holds no lane in ${folder.worktree}, so there is no service to restart`,
        `${CLI} up   (it claims a lane, starts every service and launches the app)`,
      );
    }
    const dir = laneDir(state, lane.id);
    const record = readUpRecord(dir);
    const file = record?.config ?? findProjectConfig(folder.worktree);
    if (!file) {
      throw new UsageError(
        `no ${CONFIG_FILE} in ${folder.worktree} or above it, so its services are unknown`,
        `write one at the project's root; '${CLI} schema' prints its JSON Schema`,
      );
    }
    const config = loadLaneConfig(file, record?.platform ?? lane.device?.platform);
    const platforms = record?.platforms ?? [config.platform];
    const own = config.allServices.filter(s => s.platforms === null || s.platforms.some(p => platforms.includes(p)));

    const targets: Target[] = [...new Set(names)].map(name => {
      const service = own.find(s => s.name === name);
      if (!service) {
        const other = config.allServices.find(s => s.name === name);
        throw new UsageError(
          other
            ? `'${name}' runs only for ${other.platforms?.join(', ') ?? ''}, and lane ${lane.id} was brought up for ${platforms.join(', ')}`
            : `'${name}' is not a service in ${config.file}`,
          `${CLI} restart ${own.map(s => s.name).join(' | ') || '(the config names no services)'}`,
        );
      }
      const port = claimedPort(lane, name);
      if (port === undefined) {
        throw new UsageError(
          `lane ${lane.id} has no port for ${name}: ${config.file} named it after this lane was made`,
          `${CLI} release, then ${CLI} up, to claim a port for it`,
        );
      }
      const recorded = recordedProcess(lane, name);
      if (!recorded) {
        throw new ServiceFailed(
          name,
          `is not running under lane ${lane.id}: up never started it, or its start failed\nto fix: ${CLI} up   (it starts ${name} on ${String(port)} and keeps the healthy services, the device and the app)`,
          null,
        );
      }
      return { service, port, recorded };
    });

    const ref = { id: lane.id, token: lane.token };
    const services: LaneServices = {
      deps,
      registry,
      ref,
      lane,
      dir,
      env: laneEnvironment(deps.env, lane, config, dir),
    };
    const done: RestartedService[] = [];
    for (const { service, port, recorded } of targets) {
      const started = deps.clock.now();
      registry.touch(ref, `restart: ${service.name}`);
      const stopped = await stopClaimedService(services, recorded);
      try {
        const detail = await startClaimedService(services, service, port);
        done.push({ service: service.name, port, stopped, started: detail, ms: deps.clock.now() - started });
      } catch (error) {
        deps.log(
          `${TOOL} restart: ${service.name} is stopped; lane ${lane.id} keeps port ${String(port)}, the device, the app and every other service. Fix the cause above, then run ${CLI} restart ${service.name} again (or ${CLI} up)`,
        );
        throw error;
      }
    }
    return { lane: lane.id, services: done };
  } finally {
    registry.close();
  }
}
