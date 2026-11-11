import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { systemClock } from '../../src/clock.ts';
import { runDriverCommand, type DriverCliDeps } from '../../src/driver-cli.ts';
import { callEngine } from '../../src/driver/client.ts';
import { createToolHandler } from '../../src/mcp/tools.ts';
import { systemProcesses } from '../../src/processes.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import { databasePath } from '../../src/registry/paths.ts';
import { laneLastCall } from '../../src/registry/touch.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import type { LaneStatus } from '../../src/registry/types.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { laneDir, lastCallFile } from '../../src/up/lane-files.ts';
import { runSweep, type SweepReport } from '../../src/up/sweep.ts';
import { upWaker } from '../../src/up/waker.ts';
import { FakeProbe } from '../support/fakes.ts';
import { driverWorld, until, type DriverWorld, type WorldOptions } from '../support/driver-world.ts';
import { toolchain } from '../support/up-world.ts';

const CONFIG = { ...DEFAULT_CONFIG, blocks: { metro: { first: 47900, last: 47903 } } };

function age(w: DriverWorld): void {
  const db = new DatabaseSync(databasePath(w.stateDir), { timeout: 5000 });
  try {
    db.prepare("UPDATE claims SET last_used_at = ?, last_action = 'aged' WHERE id = ?").run(
      Date.now() - CONFIG.parkMs - 60_000,
      w.lane.id,
    );
  } finally {
    db.close();
  }
  fs.rmSync(lastCallFile(laneDir(w.stateDir, w.lane.id)), { force: true });
}

function sweep(w: DriverWorld): Promise<SweepReport> {
  return runSweep({
    dir: w.stateDir,
    env: callerEnv(w),
    processes: systemProcesses,
    system: realServiceSystem,
    clock: systemClock,
    devices: { [w.lane.device?.platform ?? 'ios']: w.devices },
    ports: new FakeProbe(),
    config: CONFIG,
  });
}

function laneOf(w: DriverWorld): LaneStatus {
  const lane = readRegistryStatus({ dir: w.stateDir, processes: systemProcesses }).lanes.find(c => c.id === w.lane.id);
  assert.ok(lane, `lane ${w.lane.id} is gone`);
  return lane;
}

function callerEnv(w: DriverWorld): NodeJS.ProcessEnv {
  return {
    ...w.env,
    AGENTLANE_STATE_DIR: w.stateDir,
    AGENTLANE_OWNER_PID: String(w.owner.pid),
    AGENTLANE_MAESTRO: w.toolchain.maestro,
    JAVA_HOME: w.toolchain.javaHome,
  };
}

function wakeDeps(w: DriverWorld): EnvDeps {
  return {
    env: callerEnv(w),
    cwd: w.worktree,
    log: () => undefined,
    processes: systemProcesses,
    ports: new FakeProbe(),
    devices: { [w.lane.device?.platform ?? 'ios']: w.devices },
    sim: null,
    system: realServiceSystem,
    toolchain: toolchain(),
    startDriver: () => Promise.resolve(),
    clock: systemClock,
  };
}

function booted(w: DriverWorld, id: string): boolean | undefined {
  return w.devices.all().find(d => d.id === id)?.booted;
}

function lastUse(w: DriverWorld): { at: number; action: string } {
  const db = new DatabaseSync(databasePath(w.stateDir), { readOnly: true, timeout: 5000 });
  try {
    const row = db.prepare('SELECT last_used_at AS at, last_action AS action FROM claims WHERE id = ?').get(w.lane.id);
    return { at: Number(row?.at), action: String(row?.action) };
  } finally {
    db.close();
  }
}

/** After a look, waits until the registry holds a touch as late as the last call the lane's folder records. */
async function parked(w: DriverWorld, looked = true): Promise<void> {
  if (looked) {
    const called = laneLastCall(w.stateDir, { ...w.lane, lastUsedAt: 0 });
    await until(
      () => lastUse(w).at >= called && lastUse(w).action === 'look',
      5000,
      `the engine's touch of the look at ${String(called)} (the registry has ${JSON.stringify(lastUse(w))})`,
    );
  }
  age(w);
  const report = await sweep(w);
  assert.deepEqual(
    report.outcomes.map(o => [o.kind, o.lane]),
    [['parked', w.lane.id]],
    JSON.stringify(report),
  );
  const lane = laneOf(w);
  assert.equal(lane.park?.state, 'parked');
  assert.equal(lane.device, null);
}

async function withLane(body: (w: DriverWorld) => Promise<void>, options: WorldOptions = {}): Promise<void> {
  const w = await driverWorld(options);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

test('a look from the CLI and from MCP on a parked device lane gets its simulator back, booted, and a new engine on it', () =>
  withLane(async w => {
    const udid = w.lane.device?.id ?? '';
    await w.devices.boot(udid);
    assert.equal((await callEngine(w.target(), { op: 'look', args: {} })).ok, true, 'the engine did not start');
    const spawned = w.spawns().length;

    await parked(w);
    assert.equal(booted(w, udid), false, 'the park left the simulator running');
    assert.equal(laneOf(w).park?.restarts.device?.booted, true);

    const out: string[] = [];
    const err: string[] = [];
    const deps: DriverCliDeps = {
      env: callerEnv(w),
      cwd: w.worktree,
      stdout: text => out.push(text),
      stderr: text => err.push(text),
      stdin: new PassThrough(),
      output: new PassThrough(),
      processes: systemProcesses,
      wake: upWaker(wakeDeps(w)),
    };
    assert.equal(await runDriverCommand('look', [], deps), 0, err.join(''));
    assert.match(
      err.join(''),
      new RegExp(
        `lane ${w.lane.id} was parked \\d+s ago; bringing back an iOS simulator agentlane-pool-\\w+ \\(iPhone 17, iOS 26\\.5\\)`,
      ),
    );
    assert.match(out.join(''), /General/);
    const awake = laneOf(w);
    assert.equal(awake.park, null);
    assert.equal(awake.device?.id, udid);
    assert.equal(booted(w, udid), true);
    assert.ok(w.spawns().length > spawned, 'the look ran on no engine');

    await parked(w);
    const mcp = createToolHandler({ env: callerEnv(w), cwd: w.worktree, processes: systemProcesses, wake: upWaker(wakeDeps(w)) });
    const result = await mcp('look', {});
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(laneOf(w).park, null);
    assert.equal(laneOf(w).device?.id, udid);
    assert.equal(booted(w, udid), true);
  }));

test('a call on a parked lane with no way to bring it back is refused, naming up', () =>
  withLane(async w => {
    await parked(w, false);
    const err: string[] = [];
    const code = await runDriverCommand('look', [], {
      env: callerEnv(w),
      cwd: w.worktree,
      stdout: () => undefined,
      stderr: text => err.push(text),
      stdin: new PassThrough(),
      output: new PassThrough(),
      processes: systemProcesses,
    });
    assert.notEqual(code, 0);
    assert.match(err.join(''), new RegExp(`lane ${w.lane.id} is parked`));
    assert.match(err.join(''), /agentlane up/);
    assert.equal(laneOf(w).park?.state, 'parked');
  }));

test('a run that goes on past the park window counts as a call on each heartbeat, so the sweep never parks the lane under it', () =>
  withLane(
    async w => {
      let settled = false;
      const running = callEngine(w.target(), {
        op: 'run',
        args: { yaml: '- assertVisible: General\n', appId: 'com.apple.Preferences' },
      }).finally(() => {
        settled = true;
      });
      await until(() => w.events().some(e => e.event === 'call'), 10_000, 'the run to reach Maestro');
      age(w);
      await until(() => lastUse(w).action !== 'aged', 5000, 'a heartbeat to count the run');
      assert.equal(settled, false, 'the run ended before the heartbeat was seen');
      const report = await sweep(w);
      assert.deepEqual(report.outcomes, []);
      assert.equal(laneOf(w).park, null);
      assert.equal((await running).ok, true);
    },
    { tuning: { heartbeatMs: 100 }, env: { FAKE_DELAY_MS: '3000' } },
  ));
