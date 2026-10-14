import { CLI } from '../name.ts';
import type { ServiceConfig } from '../project/config.ts';
import type { Registry } from '../registry/registry.ts';
import type { LaneInfo, LaneRef, ServiceProcess } from '../registry/types.ts';
import {
  describeListeners,
  describeStop,
  listenersOn,
  ServiceFailed,
  startService,
  stopService,
  waitForService,
} from '../services/services.ts';
import { serviceLog } from './lane-files.ts';
import type { EnvDeps } from './deps.ts';

export interface LaneServices {
  deps: Pick<EnvDeps, 'system' | 'clock'>;
  registry: Registry;
  ref: LaneRef;
  lane: LaneInfo;
  dir: string;
  env: NodeJS.ProcessEnv;
}

export function claimedPort(lane: LaneInfo, service: string): number | undefined {
  return lane.ports.find(p => p.service === service)?.port;
}

export function recordedProcess(lane: LaneInfo, service: string): ServiceProcess | null {
  return lane.processes.find(p => p.service === service) ?? null;
}

export async function stopClaimedService(c: LaneServices, recorded: ServiceProcess): Promise<string> {
  const outcome = await stopService(c.deps.system, recorded, c.deps.clock);
  const stopped = describeStop(recorded, outcome);
  if (outcome.kind !== 'stopped' && outcome.kind !== 'already-gone') {
    throw new ServiceFailed(recorded.service, `can't be restarted: ${stopped}`, null);
  }
  c.registry.forgetProcess(c.ref, recorded.service);
  return stopped;
}

export async function startClaimedService(c: LaneServices, service: ServiceConfig, port: number): Promise<string> {
  const { deps } = c;
  const log = serviceLog(c.dir, service.name);
  const foreign = listenersOn(deps.system, port, null);
  if (foreign && foreign.length > 0) {
    throw new ServiceFailed(
      service.name,
      `can't start: ${String(port)} is held by a process the toolkit did not start: ${describeListeners(foreign)}. Stop it, or run ${CLI} release and ${CLI} up for a fresh port`,
      null,
    );
  }
  const proc = startService(deps.system, service, c.env, log);
  c.registry.recordProcess(c.ref, proc);
  try {
    const ready = await waitForService(deps.system, service, port, proc, deps.clock, log);
    c.registry.recordProcess(c.ref, ready);
    return `started on ${String(port)} (pid ${String(proc.pid)}, log ${log})`;
  } catch (error) {
    await stopService(deps.system, proc, deps.clock);
    c.registry.forgetProcess(c.ref, service.name);
    throw error;
  }
}
