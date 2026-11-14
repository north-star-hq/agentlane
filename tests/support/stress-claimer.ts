import fs from 'node:fs';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import type { Owner } from '../../src/registry/owner.ts';
import { Refusal } from '../../src/registry/refusal.ts';
import type { Step } from '../../src/registry/registry.ts';
import { Registry } from '../../src/registry/registry.ts';
import type { Lane } from '../../src/registry/types.ts';
import { parkNow } from './world.ts';
import type { Platform } from '../../src/devices/backend.ts';
import type { SlowCall } from './fakes.ts';
import { FakeDevices } from './fakes.ts';
import type { ClaimerPlan } from './stress-plan.ts';
import { DEVICE_MEMORY_MB, poolCap } from '../../src/registry/config.ts';
import {
  EXIT_DEVICE_MISSING,
  EXIT_GATE_NEVER_OPENED,
  EXIT_HELD_IN_FLIGHT,
  EXIT_LIVE_LANE_FREED,
  EXIT_OVER_BUDGET,
  EXIT_REFUSED,
  gateEntered,
  gateOpen,
} from './stress-plan.ts';
import { openRegistryReadOnly, readRegistry } from './registry-read.ts';

const GATE_LIMIT_MS = 60_000;
const COMMITS: ReadonlySet<Step> = new Set([
  'claim:lease-committed',
  'claim:reserve-committed',
  'claim:committed',
  'release:committed',
  'park:committed',
]);

function fail(code: number, message: string): never {
  fs.writeSync(2, `${message}\n`);
  process.exit(code);
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4));

function pause(ms: number): void {
  Atomics.wait(pauseCell, 0, 0, ms);
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
  const journal = (line: string) => {
    if (plan.slow) fs.appendFileSync(plan.slow.journal, `${line} ${String(process.pid)} ${String(Date.now())}\n`);
  };
  const audit = (call: SlowCall, target: string) => {
    readRegistry(plan.stateDir, db => {
      if (call === 'create') {
        const row = db.prepare('SELECT device_id, creator_pid, creator_start FROM devices WHERE name = ?').get(target);
        if (row?.device_id !== null || row.creator_pid !== self.pid || row.creator_start !== self.start) {
          fail(EXIT_HELD_IN_FLIGHT, `creating ${target} without holding its reservation: ${JSON.stringify(row)}`);
        }
        return;
      }
      const holder = db.prepare('SELECT d.claim_id FROM devices d WHERE d.device_id = ? AND d.claim_id IS NOT NULL').get(target);
      if (holder) fail(EXIT_HELD_IN_FLIGHT, `${call} of ${target} while lane ${String(holder.claim_id)} holds it`);
      const lease = db
        .prepare('SELECT work FROM device_leases WHERE device_id = ? AND holder_pid = ? AND holder_start = ?')
        .get(target, self.pid, self.start);
      if (lease?.work !== call) fail(EXIT_HELD_IN_FLIGHT, `${call} of ${target} without a ${call} lease on it`);
    });
  };
  const during = (call: SlowCall, target: string) => {
    audit(call, target);
    journal(`start ${call}`);
    const gate = plan.gate;
    if (gate?.calls.includes(call)) {
      const entered = gateEntered(gate, call);
      fs.writeFileSync(`${entered}.tmp`, target);
      fs.renameSync(`${entered}.tmp`, entered);
      const deadline = Date.now() + GATE_LIMIT_MS;
      while (!fs.existsSync(gateOpen(gate, call))) {
        if (Date.now() > deadline) fail(EXIT_GATE_NEVER_OPENED, `the ${call} gate stayed shut`);
        pause(10);
      }
    }
    if (plan.slow) pause(plan.slow.ms[call]);
    journal(`end ${call}`);
    audit(call, target);
  };
  backends.ios.during = during;
  backends.android.during = during;
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
      if (COMMITS.has(step)) journal('commit');
      if (plan.crashAt.includes(step) && ++seen === plan.crashOccurrence) {
        fs.writeSync(1, `crash ${step}\n`);
        process.kill(process.pid, 'SIGKILL');
      }
    },
  });

  let held: Lane | null = null;
  const selfOwned = plan.ownerPid === null && plan.threadOwner === null;
  const verifyBudget = () => {
    const { rows, deleting, context } = readRegistry(plan.stateDir, db => {
      db.exec('BEGIN');
      try {
        return {
          rows: db.prepare('SELECT name, platform, device_id, claim_id, creator_pid FROM devices').all(),
          context: {
            leases: db.prepare('SELECT reservation, work, holder_pid FROM device_leases').all(),
            ended: db.prepare('SELECT claim_id, device, reason, by_label FROM history ORDER BY seq DESC LIMIT 6').all(),
            me: process.pid,
          },
          deleting: new Set(
            db
              .prepare("SELECT reservation FROM device_leases WHERE work = 'delete'")
              .all()
              .map(r => String(r.reservation)),
          ),
        };
      } finally {
        db.exec('COMMIT');
      }
    });
    let used = 0;
    for (const row of rows) {
      const busy = row.claim_id !== null || (row.device_id === null && !deleting.has(String(row.name)));
      if (busy) used += DEVICE_MEMORY_MB[row.platform as Platform];
    }
    if (used > plan.config.memoryBudgetMb)
      fail(EXIT_OVER_BUDGET, `devices in use take ${String(used)} MB: ${JSON.stringify({ rows, ...context })}`);
    for (const platform of ['ios', 'android'] as const) {
      const made = rows.filter(r => r.platform === platform && r.device_id !== null);
      if (made.length > poolCap(plan.config, platform)) {
        fail(EXIT_OVER_BUDGET, `${String(made.length)} ${platform} pool devices: ${JSON.stringify(rows)}`);
      }
    }
  };
  const verifyHeld = () => {
    if (!held) return;
    const current = registry.find(owner, held.worktree);
    if (current?.id !== held.id) {
      const db = openRegistryReadOnly(plan.stateDir);
      const ended = db.prepare('SELECT reason, last_used_at, ended_at FROM history WHERE claim_id = ?').get(held.id);
      db.close();
      const idle = ended ? Number(ended.ended_at) - Number(ended.last_used_at) : -1;
      if (selfOwned) {
        fail(
          EXIT_LIVE_LANE_FREED,
          `lane ${held.id} of live owner ${String(process.pid)} ended after ${String(idle)} ms: ${JSON.stringify(ended)}`,
        );
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
        fs.writeSync(
          1,
          `claimed ${JSON.stringify({ id: held.id, device: held.device?.id ?? null, serial: held.device?.serial ?? null })}\n`,
        );
        if (op.device !== null && !held.device) fail(1, `lane ${held.id} asked for a device and got none`);
        if (held.device?.platform === 'android' && held.device.serial === null) {
          fail(1, `lane ${held.id} holds emulator ${held.device.id} with no console port`);
        }
      } else if (op.kind === 'touch' && held) {
        held = registry.touch({ id: held.id, token: held.token }, 'stress touch');
      } else if (op.kind === 'park' && held) {
        const notes: string[] = [];
        const parked = parkNow(registry, held, notes);
        held = registry.touch({ id: held.id, token: held.token }, 'stress park');
        if (parked && selfOwned && held.device) fail(1, `lane ${held.id} still holds ${held.device.id} after it was parked`);
        fs.writeSync(1, `parked ${JSON.stringify({ id: held.id, parked, notes })}\n`);
      } else if (op.kind === 'release' && held) {
        const notes: string[] = [];
        registry.release({ id: held.id, token: held.token }, owner, notes);
        fs.writeSync(1, `released ${JSON.stringify({ id: held.id, notes })}\n`);
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
