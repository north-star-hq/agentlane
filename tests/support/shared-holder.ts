import fs from 'node:fs';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import type { SharedServiceConfig } from '../../src/project/config.ts';
import type { RegistryConfig } from '../../src/registry/config.ts';
import { Registry } from '../../src/registry/registry.ts';
import type { LaneRef } from '../../src/registry/types.ts';
import { startSharedForLane, stopUnneededShared } from '../../src/up/shared.ts';
import { dieMidCommand } from './die-mid-command.ts';

/** A process that starts a lane's shared service, or stops the unneeded ones as a sweep does, for a test to kill midway. */
export interface SharedHolderPlan {
  stateDir: string;
  config: RegistryConfig;
  /** How far ahead of the wall clock this process's clock runs, so a stop is already due. */
  aheadMs: number;
  action: { kind: 'start'; lane: LaneRef; spec: SharedServiceConfig } | { kind: 'stop' };
  /** Die by SIGKILL the moment the registry records a start or stop command of this process, which runs on. */
  dieMidCommand?: boolean;
}

async function main(): Promise<void> {
  const plan = JSON.parse(process.argv[2] ?? '{}') as SharedHolderPlan;
  const self = identityOf(systemProcesses, process.pid);
  if (!self) throw new Error('ps could not read this process');
  const clock = {
    now: () => Date.now() + plan.aheadMs,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  };
  const registry = Registry.open({
    dir: plan.stateDir,
    processes: systemProcesses,
    ports: { listening: () => Promise.resolve(new Set<number>()) },
    devices: {},
    config: plan.config,
    pollMs: 20,
    lockWaitMs: 30_000,
    self,
    clock,
  });
  if (plan.dieMidCommand) dieMidCommand(registry);
  const deps = { env: process.env, clock };
  const { action } = plan;
  const result =
    action.kind === 'start'
      ? await startSharedForLane(deps, registry, action.lane, [action.spec])
      : await stopUnneededShared(deps, registry);
  registry.close();
  fs.writeSync(1, `${JSON.stringify(result)}\n`);
}

await main();
