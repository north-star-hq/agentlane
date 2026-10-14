import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import type { Owner } from '../../src/registry/owner.ts';
import { databasePath } from '../../src/registry/paths.ts';
import { Refusal } from '../../src/registry/refusal.ts';
import type { Step } from '../../src/registry/registry.ts';
import { Registry } from '../../src/registry/registry.ts';
import type { Lane } from '../../src/registry/types.ts';
import { FakeDevices } from './fakes.ts';
import type { ClaimerPlan } from './stress-plan.ts';
import { DEVICE_MEMORY_MB, poolCap } from '../../src/registry/config.ts';
import { EXIT_DEVICE_MISSING, EXIT_LIVE_LANE_FREED, EXIT_OVER_BUDGET, EXIT_REFUSED } from './stress-plan.ts';

function fail(code: number, message: string): never {
  fs.writeSync(2, `${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const plan = JSON.parse(process.argv[2] ?? '{}') as ClaimerPlan;
  const self = identityOf(systemProcesses, process.pid);
  if (!self) fail(1, 'ps could not read this process');
  const ownerIdentity = plan.ownerPid === null ? self : identityOf(systemProcesses, plan.ownerPid);
  if (!ownerIdentity) fail(EXIT_REFUSED, `owner ${String(plan.ownerPid)} already gone`);
  const owner: Owner = plan.threadOwner
    ? { kind: 'codex', process: null, sessionId: null, threadId: plan.threadOwner }
    : { kind: 'process', process: ownerIdentity, sessionId: null, threadId: null };
  const backends = {
    ios: new FakeDevices(plan.devicesDir),
    android: new FakeDevices(plan.emulatorsDir, 'android'),
  };
  let seen = 0;
  const reached: Partial<Record<Step, number>> = {};
  const registry = Registry.open({
    dir: plan.stateDir,
    processes: systemProcesses,
    ports: { listening: () => Promise.resolve(new Set<number>()) },
    devices: backends,
    config: plan.config,
    pollMs: 20,
    lockWaitMs: 30_000,
    self,
    onStep: step => {
      reached[step] = (reached[step] ?? 0) + 1;
      if (plan.crashAt.includes(step) && ++seen === plan.crashOccurrence) {
        fs.writeSync(1, `crash ${step}\n`);
        process.kill(process.pid, 'SIGKILL');
      }
    },
  });

  let held: Lane | null = null;
  const selfOwned = plan.ownerPid === null && plan.threadOwner === null;
  const verifyBudget = () => {
    const pool = registry.status().pool;
    let used = 0;
    for (const d of pool) if (d.laneId !== null || d.state === 'creating') used += DEVICE_MEMORY_MB[d.platform];
    if (used > plan.config.memoryBudgetMb)
      fail(EXIT_OVER_BUDGET, `claimed devices use ${String(used)} MB: ${JSON.stringify(pool)}`);
    for (const platform of ['ios', 'android'] as const) {
      const made = pool.filter(d => d.platform === platform && d.state !== 'creating');
      if (made.length > poolCap(plan.config, platform)) {
        fail(EXIT_OVER_BUDGET, `${String(made.length)} ${platform} pool devices: ${JSON.stringify(pool)}`);
      }
    }
  };
  const verifyHeld = () => {
    if (!held) return;
    const current = registry.find(owner, held.worktree);
    if (current?.id !== held.id) {
      const db = new DatabaseSync(databasePath(plan.stateDir), { readOnly: true });
      const ended = db.prepare('SELECT reason, last_used_at, ended_at FROM history WHERE claim_id = ?').get(held.id);
      db.close();
      const idle = ended ? Number(ended.ended_at) - Number(ended.last_used_at) : -1;
      if (selfOwned && !(ended?.reason === 'taken-over' && idle >= plan.config.idleMs)) {
        fail(EXIT_LIVE_LANE_FREED, `lane ${held.id} of live owner ${String(process.pid)} ended: ${JSON.stringify(ended)}`);
      }
      held = null;
      return;
    }
    const device = current.device;
    if (device && !backends[device.platform].list().some(d => d.id === device.id)) {
      fail(EXIT_DEVICE_MISSING, `lane ${held.id} holds ${device.id}, which no longer exists`);
    }
  };

  let refused = false;
  await new Promise(resolve => setTimeout(resolve, plan.startMs));
  for (const op of plan.ops) {
    try {
      if (op.kind === 'pause') {
        await new Promise(resolve => setTimeout(resolve, op.ms));
      } else if (op.kind === 'claim') {
        const outcome = await registry.claim({
          owner,
          worktree: op.worktree,
          projectRoot: op.worktree,
          services: [
            { name: 'metro', type: 'metro' },
            { name: 'api', type: 'api' },
          ],
          device: op.device === null ? null : { platform: op.platform, deviceType: op.device, strict: op.strict },
          waitMs: op.waitMs,
          boot: op.boot,
        });
        held = outcome.lane;
        if (op.device !== null && !held.device) fail(1, `lane ${held.id} asked for a device and got none`);
        if (held.device?.platform === 'android' && held.device.serial === null) {
          fail(1, `lane ${held.id} holds emulator ${held.device.id} with no console port`);
        }
      } else if (op.kind === 'touch' && held) {
        held = registry.touch({ id: held.id, token: held.token }, 'stress touch');
      } else if (op.kind === 'release' && held) {
        registry.release({ id: held.id, token: held.token }, owner);
        held = null;
      }
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      if (error.code === 'lane-gone') {
        verifyHeld();
        held = null;
      } else if (error.code === 'pool-busy' || error.code === 'ports-exhausted') {
        refused = true;
      } else {
        throw error;
      }
    }
    verifyHeld();
    verifyBudget();
  }
  registry.close();
  fs.writeSync(1, `reached ${JSON.stringify(reached)}\n`);
  process.exit(refused ? EXIT_REFUSED : 0);
}

await main();
