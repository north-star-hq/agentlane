import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Platform } from '../src/devices/backend.ts';
import { EMULATOR_NAME_PREFIX, POOL_NAME_PREFIX } from '../src/name.ts';
import { identityOf, systemProcesses } from '../src/processes.ts';
import type { RegistryConfig } from '../src/registry/config.ts';
import { DEVICE_MEMORY_MB, poolCap } from '../src/registry/config.ts';
import type { Owner } from '../src/registry/owner.ts';
import { databasePath } from '../src/registry/paths.ts';
import type { Step } from '../src/registry/registry.ts';
import { Registry, STEPS } from '../src/registry/registry.ts';
import { FakeDevices, tempDir } from './support/fakes.ts';
import type { ClaimerPlan, StressOp } from './support/stress-plan.ts';
import { EXIT_REFUSED } from './support/stress-plan.ts';

const CLAIMER = path.join(import.meta.dirname, 'support', 'stress-claimer.ts');
const CLAIMERS = 16;
const SEEDS = Number(process.env.STRESS_SEEDS ?? 10);
const DEVICE_TYPES = { ios: ['iPhone 17', 'iPhone 17 Pro'], android: ['pixel_8', 'pixel_9'] } as const;
const THREAD = 'stress-thread';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(plan: ClaimerPlan): Promise<Exit> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLAIMER, JSON.stringify(plan)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function sleeper(): ChildProcess {
  return spawn('sleep', ['300'], { stdio: 'ignore' });
}

interface SeedResult {
  emulatorLanes: number;
  emulatorStops: number;
  reasons: Record<string, number>;
  crashes: Step[];
  reached: Partial<Record<Step, number>>;
  runs: number;
  ops: number;
  ended: number;
}

async function runSeed(seed: number, idleMs: number, targets: readonly Step[], lead: Step | null): Promise<SeedResult> {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const root = tempDir(`stress-${String(seed)}`);
  const stateDir = path.join(root, 'state');
  const devicesDir = path.join(root, 'devices');
  const emulatorsDir = path.join(root, 'emulators');
  const config: RegistryConfig = {
    poolSize: 3,
    emulatorPoolSize: 2,
    memoryBudgetMb: 15_400,
    idleMs,
    blocks: { metro: { first: 48000, last: 48004 }, api: { first: 48100, last: 48104 } },
  };
  const immortal = [sleeper(), sleeper(), sleeper()];
  const mortal = [sleeper(), sleeper()];
  const killedAt = new Map<number, number>();
  const folders = new Map<number, string[]>();
  const folder = (name: string) => {
    const dir = path.join(root, 'worktrees', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  for (const owner of [...immortal, ...mortal]) {
    const pid = owner.pid ?? 0;
    folders.set(pid, [folder(`${String(pid)}-a`), folder(`${String(pid)}-b`)]);
  }
  try {
    const plans: ClaimerPlan[] = [];
    let ops = 0;
    const idleSeed = idleMs < 1000;
    const squat = (worktree: string, platform: Platform): StressOp => ({
      kind: 'claim',
      worktree,
      platform,
      device: DEVICE_TYPES[platform][0],
      strict: false,
      boot: false,
      waitMs: 0,
    });
    const squatters: ClaimerPlan[] = immortal.map(owner => ({
      stateDir,
      devicesDir,
      emulatorsDir,
      config,
      ownerPid: owner.pid ?? null,
      threadOwner: null,
      startMs: 0,
      ops: [squat(folders.get(owner.pid ?? 0)?.[0] ?? '', 'ios')],
      crashAt: [],
      crashOccurrence: 1,
    }));
    squatters.push({
      stateDir,
      devicesDir,
      emulatorsDir,
      config,
      ownerPid: null,
      threadOwner: THREAD,
      startMs: 0,
      ops: [squat(folder('thread'), 'android')],
      crashAt: [],
      crashOccurrence: 1,
    });
    for (let i = 0; i < CLAIMERS; i++) {
      const hunter = i % 4 === 3;
      const shared = i % 2 === 1 ? pick([...immortal, ...mortal]) : null;
      const worktree = shared ? pick(folders.get(shared.pid ?? 0)?.slice(1) ?? []) : folder(`self-${String(i)}`);
      let script: StressOp[] = [];
      let startMs = 30 + Math.floor(random() * 300);
      let crashAt: Step[] = [];
      if (hunter) {
        const platform: Platform = i % 8 === 7 ? 'android' : 'ios';
        script = [
          { kind: 'claim', worktree, platform, device: DEVICE_TYPES[platform][1], strict: true, boot: true, waitMs: 700 },
          { kind: 'touch' },
          { kind: 'release' },
        ];
        crashAt = [targets[(i >> 2) % targets.length] ?? 'claim:booted'];
        if (crashAt[0] === 'claim:took-over') startMs = 0;
      } else {
        const count = 2 + Math.floor(random() * 4);
        for (let k = 0; k < count; k++) {
          const roll = random();
          if (k === 0 || roll < 0.35) {
            const platform: Platform = random() < 0.35 ? 'android' : 'ios';
            script.push({
              kind: 'claim',
              worktree,
              platform,
              device: random() < 0.85 ? pick(DEVICE_TYPES[platform]) : null,
              strict: random() < 0.5,
              boot: random() < 0.3,
              waitMs: Math.floor(random() * 700),
            });
          } else if (roll < 0.55) script.push({ kind: 'touch' });
          else if (roll < 0.75) script.push({ kind: 'release' });
          else script.push({ kind: 'pause', ms: Math.floor(random() * 500) });
        }
        if (random() < 0.65) crashAt = [targets[(4 + i) % targets.length] ?? 'claim:locked'];
      }
      ops += script.length;
      plans.push({
        stateDir,
        devicesDir,
        emulatorsDir,
        config,
        ownerPid: shared ? (shared.pid ?? null) : null,
        threadOwner: null,
        startMs,
        ops: script,
        crashAt,
        crashOccurrence: hunter ? 1 : 1 + Math.floor(random() * 2),
      });
    }
    const squatted = idleSeed || lead !== null;
    if (squatted) {
      for (const exit of await Promise.all(squatters.map(run)))
        assert.equal(exit.code, 0, `squatter: ${exit.stdout}${exit.stderr}`);
    }
    if (idleSeed) await new Promise(resolve => setTimeout(resolve, idleMs + 50));
    const crashes: Step[] = [];
    if (lead !== null) {
      const exit = await run({
        stateDir,
        devicesDir,
        emulatorsDir,
        config,
        ownerPid: null,
        threadOwner: null,
        startMs: 0,
        ops: [
          {
            kind: 'claim',
            worktree: folder('lead'),
            platform: 'ios',
            device: DEVICE_TYPES.ios[1],
            strict: true,
            boot: true,
            waitMs: 700,
          },
          { kind: 'touch' },
          { kind: 'release' },
        ],
        crashAt: [lead],
        crashOccurrence: 1,
      });
      const crashed = /^crash (\S+)$/m.exec(exit.stdout)?.[1];
      assert.ok(
        exit.signal === 'SIGKILL' && crashed === lead,
        `seed ${String(seed)}: the lead claimer, alone on a full pool, never reached ${lead}: code ${String(exit.code)} signal ${String(exit.signal)}\n${exit.stdout}${exit.stderr}`,
      );
      crashes.push(lead);
    }
    const killer = (async () => {
      for (const owner of mortal) {
        await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(random() * 400)));
        killedAt.set(owner.pid ?? 0, Date.now());
        owner.kill('SIGKILL');
      }
    })();
    const exits = await Promise.all(plans.map(run));
    await killer;

    const reached: Partial<Record<Step, number>> = {};
    exits.forEach((exit, i) => {
      const counts = /^reached (.*)$/m.exec(exit.stdout)?.[1];
      for (const [step, n] of Object.entries(counts ? (JSON.parse(counts) as Record<Step, number>) : {})) {
        reached[step as Step] = (reached[step as Step] ?? 0) + n;
      }
      const detail = `seed ${String(seed)} claimer ${String(i)}: code ${String(exit.code)} signal ${String(exit.signal)}\n${exit.stdout}${exit.stderr}`;
      const crashed = /^crash (\S+)$/m.exec(exit.stdout)?.[1];
      if (exit.signal === 'SIGKILL') {
        assert.ok(crashed, `killed without an injected crash: ${detail}`);
        crashes.push(crashed as Step);
        return;
      }
      assert.ok(exit.code === 0 || exit.code === EXIT_REFUSED, detail);
    });

    const settler: Owner = {
      kind: 'process',
      process: identityOf(systemProcesses, process.pid) ?? null,
      sessionId: null,
      threadId: null,
    };
    const devices = new FakeDevices(devicesDir);
    const emulators = new FakeDevices(emulatorsDir, 'android');
    const registry = Registry.open({
      dir: stateDir,
      processes: systemProcesses,
      ports: { listening: () => Promise.resolve(new Set<number>()) },
      devices: { ios: devices, android: emulators },
      config,
    });
    try {
      const settled = await registry.claim({
        owner: settler,
        worktree: folder('settler'),
        projectRoot: root,
        services: [],
        device: null,
        waitMs: 0,
      });
      registry.release({ id: settled.lane.id, token: settled.lane.token }, settler);
      const status = registry.status();
      const immortalKeys = new Set(
        immortal.map(o => {
          const id = identityOf(systemProcesses, o.pid ?? 0);
          assert.ok(id, 'immortal owners are still running');
          return `process:${String(id.pid)}:${id.start}`;
        }),
      );

      const db = new DatabaseSync(databasePath(stateDir), { readOnly: true });
      const history = db.prepare('SELECT * FROM history').all();
      db.close();
      for (const h of history) {
        const where = `seed ${String(seed)}: ${JSON.stringify(h)}`;
        const reason = String(h.reason);
        const ownerKey = String(h.owner_key);
        if (reason === 'released') assert.equal(h.by_owner_key, ownerKey, `released by someone else: ${where}`);
        else if (reason === 'taken-over')
          assert.ok(Number(h.ended_at) - Number(h.last_used_at) >= idleMs, `taken over before it was idle: ${where}`);
        else if (reason === 'dead' || reason === 'pid-reused') {
          assert.notEqual(ownerKey, `codex:thread:${THREAD}`, `a can't-tell owner's lane was freed: ${where}`);
          assert.equal(immortalKeys.has(ownerKey), false, `a live owner's lane was freed: ${where}`);
          const pid = Number(ownerKey.split(':')[1]);
          const kill = killedAt.get(pid);
          if (kill !== undefined) assert.ok(Number(h.ended_at) >= kill, `freed before its owner was killed: ${where}`);
        } else assert.fail(`unexpected end: ${where}`);
      }

      assert.deepEqual(status.queue, [], `seed ${String(seed)}: queue tickets left behind`);
      for (const platform of ['ios', 'android'] as const) {
        const count = status.pool.filter(d => d.platform === platform).length;
        assert.ok(count <= poolCap(config, platform), `seed ${String(seed)}: ${String(count)} ${platform} pool devices`);
      }
      const claimedMb = status.pool.filter(d => d.laneId !== null).reduce((sum, d) => sum + DEVICE_MEMORY_MB[d.platform], 0);
      assert.ok(claimedMb <= config.memoryBudgetMb, `seed ${String(seed)}: claimed devices use ${String(claimedMb)} MB`);
      assert.ok(
        status.pool.length <= config.poolSize + config.emulatorPoolSize,
        `seed ${String(seed)}: pool grew to ${String(status.pool.length)}\npool ${JSON.stringify(status.pool, null, 1)}\ndevices ${JSON.stringify(devices.all(), null, 1)}\ncrashes ${crashes.join(' ')}\nnotes ${settled.notes.join(' | ')}\nhistory ${JSON.stringify(history.map(h => [h.reason, h.device, h.owner_label]))}`,
      );
      const listed = [...devices.list(), ...emulators.list()];
      for (const d of status.pool) {
        assert.notEqual(d.state, 'creating', `seed ${String(seed)}: reservation left behind: ${d.name}`);
        assert.ok(
          listed.some(x => x.id === d.id),
          `seed ${String(seed)}: pool row ${d.name} points at a missing device`,
        );
      }
      for (const d of listed.filter(x => x.name.startsWith(POOL_NAME_PREFIX) || x.name.startsWith(EMULATOR_NAME_PREFIX))) {
        assert.ok(
          status.pool.some(p => p.id === d.id),
          `seed ${String(seed)}: device ${d.name} was created but never recorded`,
        );
      }
      for (const d of listed) {
        const row = status.pool.find(p => p.id === d.id);
        if (row?.laneId === null) assert.equal(d.booted, false, `seed ${String(seed)}: unclaimed ${d.name} left booted`);
      }
      const serials = emulators.list().flatMap(d => (d.serial ? [d.serial] : []));
      assert.equal(new Set(serials).size, serials.length, `seed ${String(seed)}: two emulators on one port pair`);
      for (const c of status.lanes) {
        if (c.device?.platform === 'android') assert.ok(c.device.serial, `seed ${String(seed)}: lane ${c.id} has no port`);
      }
      const journal = fs.existsSync(emulators.journal) ? fs.readFileSync(emulators.journal, 'utf8').split('\n') : [];
      let emulatorStops = 0;
      journal.forEach((line, at) => {
        if (!line.startsWith('emu kill ')) return;
        emulatorStops++;
        const serial = line.slice('emu kill '.length);
        assert.equal(
          journal[at - 1],
          `force-stop dev.mobile.maestro ${serial}`,
          `seed ${String(seed)}: killed before force-stop`,
        );
      });
      const emulatorLanes = history.filter(h => String(h.device).startsWith(EMULATOR_NAME_PREFIX)).length;
      const ports = status.lanes.flatMap(c => c.ports.map(p => p.port));
      assert.equal(new Set(ports).size, ports.length, `seed ${String(seed)}: a port is held twice`);
      const held = status.lanes.flatMap(c => (c.device ? [c.device.id] : []));
      assert.equal(new Set(held).size, held.length, `seed ${String(seed)}: a device is held twice`);
      for (const c of status.lanes) {
        assert.ok(
          immortalKeys.has(c.ownerKey) || c.ownerKey === `codex:thread:${THREAD}`,
          `seed ${String(seed)}: lane ${c.id} of a gone owner survived the sweep (${c.ownerState})`,
        );
      }
      const reasons: Record<string, number> = {};
      for (const h of history) reasons[String(h.reason)] = (reasons[String(h.reason)] ?? 0) + 1;
      return {
        reasons,
        crashes,
        reached,
        runs: plans.length + (squatted ? squatters.length : 0) + (lead === null ? 0 : 1),
        ops,
        ended: history.length,
        emulatorLanes,
        emulatorStops,
      };
    } finally {
      registry.close();
    }
  } finally {
    for (const owner of [...immortal, ...mortal]) owner.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(`stress: ${String(CLAIMERS)} parallel claimers per seed with crashes injected at every step never double-allocate or free a live lane`, async () => {
  const started = Date.now();
  const crashes = new Map<Step, number>(STEPS.map(s => [s, 0]));
  const reached = new Map<Step, number>(STEPS.map(s => [s, 0]));
  const endings = new Map<string, number>();
  let runs = 0;
  let ops = 0;
  let ended = 0;
  let emulatorLanes = 0;
  let emulatorStops = 0;
  const seeds: number[] = [];
  const seed = async (n: number, lead: Step | null) => {
    seeds.push(n);
    const idleMs = lead === null ? (n % 2 === 0 ? 300 : 3_600_000) : lead === 'claim:waiting' ? 3_600_000 : 300;
    const targets = [...STEPS]
      .filter(step => idleMs < 1000 || step !== 'claim:took-over')
      .sort((a, b) => (crashes.get(a) ?? 0) - (crashes.get(b) ?? 0) || STEPS.indexOf(a) - STEPS.indexOf(b));
    const result = await runSeed(n, idleMs, targets, lead);
    for (const [reason, k] of Object.entries(result.reasons)) endings.set(reason, (endings.get(reason) ?? 0) + k);
    for (const step of result.crashes) crashes.set(step, (crashes.get(step) ?? 0) + 1);
    for (const [step, k] of Object.entries(result.reached)) reached.set(step as Step, (reached.get(step as Step) ?? 0) + k);
    runs += result.runs;
    ops += result.ops;
    ended += result.ended;
    emulatorLanes += result.emulatorLanes;
    emulatorStops += result.emulatorStops;
  };
  for (let n = 1; n <= SEEDS; n++) await seed(n, null);
  const leads = [...crashes].filter(([, k]) => k === 0).map(([s]) => s);
  for (const [k, lead] of leads.entries()) await seed(SEEDS + 1 + k, lead);
  const missed = [...crashes].filter(([, n]) => n === 0).map(([s]) => s);
  console.log(
    `stress seeds ${seeds.join(',')} (odd: no idle takeover, even: 300 ms idle; each seed past ${String(SEEDS)} first runs one claimer alone on a full pool, crashing at a step the others missed: ${leads.join(' ') || 'none'}); ${String(runs)} claimer processes, ${String(ops)} operations, ${String(ended)} lanes ended; ${String(Date.now() - started)} ms`,
  );
  console.log(`lanes ended by reason: ${[...endings].map(([r, n]) => `${r}=${String(n)}`).join(' ')}`);
  console.log(
    `emulator lanes ended: ${String(emulatorLanes)}; emulators stopped (each after a Maestro force-stop): ${String(emulatorStops)}`,
  );
  console.log(`crashes injected per step: ${[...crashes].map(([s, n]) => `${s}=${String(n)}`).join(' ')}`);
  console.log(
    `steps passed without a crash, by claimers that exited normally: ${[...reached].map(([s, n]) => `${s}=${String(n)}`).join(' ')}`,
  );
  assert.deepEqual(missed, [], 'every step had at least one injected crash');
  assert.ok(emulatorLanes > 0 && emulatorStops > 0, 'emulator lanes were in the mix');
});
