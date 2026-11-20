import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { systemClock } from '../../src/clock.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import type { SharedServiceConfig } from '../../src/project/config.ts';
import type { RegistryConfig } from '../../src/registry/config.ts';
import type { Owner } from '../../src/registry/owner.ts';
import { Registry } from '../../src/registry/registry.ts';
import { startSharedForLane } from '../../src/up/shared.ts';
import { parkNow } from './world.ts';

export interface SharedClaimerPlan {
  stateDir: string;
  repository: string;
  worktree: string;
  config: RegistryConfig;
  spec: SharedServiceConfig;
  /** The file the fixture's start creates and its stop removes: the service runs while it exists. */
  up: string;
  startMs: number;
  /** For each round: how long the lane stays up after its start returns, then how long it stays parked. */
  rounds: { upMs: number; parkedMs: number }[];
}

export const EXIT_NOT_RUNNING = 12;
export const EXIT_NOT_TAKEN = 13;

function fail(code: number, message: string): never {
  fs.writeSync(2, `${message}\n`);
  process.exit(code);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const plan = JSON.parse(process.argv[2] ?? '{}') as SharedClaimerPlan;
  const self = identityOf(systemProcesses, process.pid);
  if (!self) fail(1, 'ps could not read this process');
  const owner: Owner = { kind: 'process', process: self, sessionId: null, threadId: null };
  const registry = Registry.open({
    dir: plan.stateDir,
    processes: systemProcesses,
    ports: { listening: () => Promise.resolve(new Set<number>()) },
    devices: {},
    config: plan.config,
    pollMs: 20,
    lockWaitMs: 30_000,
    self,
  });
  const waited = { stopping: 0, starting: 0 };
  const deps = {
    env: process.env,
    clock: systemClock,
    log: (line: string) => {
      if (line.includes('which is stopping')) waited.stopping++;
      if (line.includes('which is starting')) waited.starting++;
    },
  };
  const running = (when: string) => {
    const state = registry.sharedServices().find(s => s.name === plan.spec.name)?.state;
    if (!fs.existsSync(plan.up) || state !== 'running') {
      fail(EXIT_NOT_RUNNING, `pid ${String(process.pid)}: the shared service is not running ${when} (recorded ${String(state)})`);
    }
  };
  await delay(plan.startMs);
  const { lane } = await registry.claim({
    owner,
    worktree: plan.worktree,
    projectRoot: plan.repository,
    services: [],
    device: null,
    waitMs: 0,
  });
  const ref = { id: lane.id, token: lane.token };
  let starts = 0;
  for (const [i, round] of plan.rounds.entries()) {
    const attempt = randomBytes(4).toString('hex');
    if (i > 0 && registry.beginWake(ref, attempt, null).kind !== 'taken') fail(EXIT_NOT_TAKEN, `lane ${lane.id}: no wake taken`);
    const started = await startSharedForLane(deps, registry, ref, [plan.spec]);
    starts += started.filter(s => s.outcome === 'started').length;
    running('as its start returns');
    if (i > 0) registry.finishWake(ref, attempt);
    await delay(round.upMs);
    running('while its lane is up');
    if (!parkNow(registry, ref)) fail(EXIT_NOT_TAKEN, `lane ${lane.id}: no park taken`);
    await delay(round.parkedMs);
  }
  registry.release(ref, owner);
  registry.close();
  fs.writeSync(1, `starts ${String(starts)}\nwaited ${String(waited.stopping)} ${String(waited.starting)}\n`);
  process.exit(0);
}

await main();
