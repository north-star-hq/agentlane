import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ProcessTable } from '../src/processes.ts';
import { identityOf, systemProcesses } from '../src/processes.ts';
import { DEFAULT_CONFIG, MINUTE_MS, parseConfig } from '../src/registry/config.ts';
import { databasePath } from '../src/registry/paths.ts';
import type { Registry } from '../src/registry/registry.ts';
import { recordCall } from '../src/registry/touch.ts';
import type { Lane } from '../src/registry/types.ts';
import { realServiceSystem, type ServiceSystem } from '../src/services/system.ts';
import { PARK_RETRY_MS, parkLane } from '../src/up/park.ts';
import { passBy, runSweep, sweepDue, type SweepDeps } from '../src/up/sweep.ts';
import { takeLane } from '../src/up/wake.ts';
import { tempDir } from './support/fakes.ts';
import type { World } from './support/world.ts';
import { world } from './support/world.ts';

const PARK_MS = 30 * MINUTE_MS;

function sweepDeps(w: World, over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    dir: w.dir,
    env: { PATH: process.env.PATH, HOME: tempDir('parking-home') },
    processes: w.procs,
    system: realServiceSystem,
    clock: w.clock,
    devices: { ios: w.devices, android: w.emulators },
    ports: w.probe,
    config: w.config,
    self: w.procs.spawn(),
    ...over,
  };
}

function refOf(lane: Lane) {
  return { id: lane.id, token: lane.token };
}

function parkOf(w: World, lane: Lane) {
  return (
    w
      .registry()
      .status()
      .lanes.find(c => c.id === lane.id)?.park ?? null
  );
}

test('a lane is parked 30 minutes after its last call and not a second before: its device is shut down and goes back to the pool', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { boot: true }));
    const device = a.lane.device;
    assert.ok(device);
    assert.equal(w.devices.all().find(d => d.id === device.id)?.booted, true);

    await w.clock.advance(PARK_MS - 1000);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
    const early = await runSweep(sweepDeps(w));
    assert.deepEqual(early.outcomes, []);
    assert.equal(parkOf(w, a.lane), null);
    assert.equal(w.registry().status().lanes[0]?.device?.id, device.id);

    await w.clock.advance(1000);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    const due = await runSweep(sweepDeps(w));
    assert.deepEqual(
      due.outcomes.map(o => [o.kind, o.lane]),
      [['parked', a.lane.id]],
    );
    const status = w.registry().status();
    const lane = status.lanes.find(c => c.id === a.lane.id);
    assert.ok(lane?.park);
    assert.equal(lane.park.state, 'parked');
    assert.equal(lane.park.parkedAt, w.clock.now());
    assert.equal(lane.device, null);
    assert.deepEqual(lane.park.restarts.device && [lane.park.restarts.device.name, lane.park.restarts.device.booted], [
      device.name,
      true,
    ]);
    assert.deepEqual(
      status.pool.map(d => [d.name, d.laneId, d.state]),
      [[device.name, null, 'shutdown']],
    );
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false, 'a parked lane is no more work');
  } finally {
    w.close();
  }
});

test('a call recorded in the lane folder counts: a lane used within the park window by the record alone stays awake', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    await w.clock.advance(PARK_MS - 60_000);
    recordCall(w.dir, refOf(a.lane), w.clock.now());
    await w.clock.advance(60_000);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
    assert.deepEqual((await runSweep(sweepDeps(w))).outcomes, []);
    await w.clock.advance(PARK_MS - 60_000);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
  } finally {
    w.close();
  }
});

test('a call that lands after the park began, but before its stop work ran, keeps the lane awake', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { boot: true }));
    await w.clock.advance(PARK_MS);
    const parker = w.registry();
    const begin = parker.beginPark.bind(parker);
    parker.beginPark = (...args: Parameters<Registry['beginPark']>) => {
      const lane = begin(...args);
      recordCall(w.dir, refOf(a.lane), w.clock.now());
      return lane;
    };
    const outcome = await parkLane(sweepDeps(w), parker, { ref: refOf(a.lane), park: null }, w.clock.now() - PARK_MS);
    assert.deepEqual(outcome, { kind: 'left', lane: a.lane.id, reason: 'it was used' });
    assert.equal(parkOf(w, a.lane), null);
    assert.equal(w.registry().status().lanes[0]?.device?.id, a.lane.device?.id);
    assert.equal(w.devices.calls.filter(c => c.startsWith('shutdown')).length, 0);
  } finally {
    w.close();
  }
});

test('the check every command makes as it passes by reads the registry and starts no process when there is nothing to do', async () => {
  const w = world();
  try {
    for (const name of ['a', 'b', 'c']) await w.registry().claim(w.request(w.procs.owner(), w.folder(name)));
    await w.clock.advance(PARK_MS - 1);
    const reads: (readonly number[])[] = [];
    const counting: ProcessTable = {
      startTimes: pids => {
        reads.push(pids);
        return w.procs.startTimes(pids);
      },
      info: pid => {
        reads.push([pid]);
        return w.procs.info(pid);
      },
      cwd: pid => {
        reads.push([pid]);
        return w.procs.cwd();
      },
    };
    let started = 0;
    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
      assert.equal(
        passBy({ dir: w.dir, clock: w.clock, processes: counting }, () => started++),
        false,
      );
    }
    const perCheckMs = (performance.now() - t0) / runs;
    assert.equal(started, 0);
    assert.deepEqual(reads, []);
    assert.ok(perCheckMs < 20, `each check took ${perCheckMs.toFixed(2)} ms`);
    console.log(
      `the check with 3 awake lanes and nothing to do: ${perCheckMs.toFixed(2)} ms each over ${String(runs)} runs, 0 process reads`,
    );
  } finally {
    w.close();
  }
});

test('a command passing by starts one sweeper for due work, and none again while it runs', async () => {
  const w = world();
  try {
    await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    await w.clock.advance(PARK_MS);
    let started = 0;
    const site = { dir: w.dir, clock: w.clock, processes: w.procs };
    assert.equal(
      passBy(site, () => started++),
      true,
    );
    assert.equal(
      passBy(site, () => started++),
      false,
    );
    await runSweep(sweepDeps(w));
    assert.equal(
      passBy(site, () => started++),
      false,
    );
    assert.equal(started, 1);
  } finally {
    w.close();
  }
});

test('a parked lane keeps its ports and resource values exactly, and no teardown of its resources is taken', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    const spec = { name: 'db', cwd: a.lane.worktree, teardown: 'drop-db', timeoutMs: 1000, env: {}, cleared: [] };
    const maker = w.registry();
    maker.startResource(refOf(a.lane), spec);
    maker.finishResource(a.lane.id, 'db', { DATABASE_URL: 'postgres://db/app_a' });
    await w.clock.advance(PARK_MS);
    await runSweep(sweepDeps(w));
    const lane = w.registry().touch(refOf(a.lane), 'look');
    assert.equal(parkOf(w, a.lane)?.state, 'parked');
    assert.deepEqual(lane.ports, a.lane.ports);
    assert.deepEqual(lane.resources, [{ name: 'db', exports: { DATABASE_URL: 'postgres://db/app_a' } }]);
    assert.deepEqual(w.registry().pendingTeardowns(), []);
    assert.deepEqual(w.registry().takeTeardowns(), []);
  } finally {
    w.close();
  }
});

test("a lane whose owner is dead is left to a claim's sweep, and the commands passing by don't start a sweeper for it again", async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const a = await w.registry().claim(w.request(owner, w.folder('a')));
    await w.clock.advance(PARK_MS);
    w.procs.kill(owner.process?.pid ?? 0);
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(report, { outcomes: [], leftAlone: [a.lane.id] });
    assert.equal(parkOf(w, a.lane), null);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
  } finally {
    w.close();
  }
});

test('two calls waking one lane: the registry hands the wake to one, the other waits until it is done and finds the lane awake', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    await w.clock.advance(PARK_MS);
    await runSweep(sweepDeps(w));
    const first = w.procs.spawn();
    const second = w.procs.spawn();
    assert.equal(w.registry({ self: first }).beginWake(refOf(a.lane), 'one', null).kind, 'taken');
    const busy = w.registry({ self: second }).beginWake(refOf(a.lane), 'two', null);
    assert.equal(busy.kind, 'busy');
    w.registry({ self: first }).finishWake(refOf(a.lane), 'one');
    assert.equal(w.registry({ self: second }).beginWake(refOf(a.lane), 'two', null).kind, 'awake');
  } finally {
    w.close();
  }
});

test('a park or wake whose process died is taken over: a call takes the lane to wake it, and the next sweep parks it again', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { boot: true }));
    await w.clock.advance(PARK_MS);
    const parker = w.procs.spawn();
    assert.ok(w.registry({ self: parker }).beginPark(refOf(a.lane), w.clock.now(), 'died', null));
    w.procs.kill(parker.pid);
    assert.equal(parkOf(w, a.lane)?.state, 'parking');
    assert.equal(
      sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }),
      false,
      'a park under way is left to its process for a while',
    );

    const caller = { stateDir: w.dir, processes: w.procs, clock: w.clock, self: w.procs.spawn() };
    const handle = await takeLane(caller, refOf(a.lane));
    assert.ok(handle, 'the call took the lane from the dead parker');
    assert.equal(parkOf(w, a.lane)?.state, 'waking');
    const waker = w.procs.spawn();
    w.registry({ self: waker }).giveUp(refOf(a.lane), handle.attempt, []);
    assert.equal(parkOf(w, a.lane)?.state, 'parked');
    assert.equal(
      w.registry().status().lanes[0]?.device?.id,
      a.lane.device?.id,
      'the device the dead parker never freed is still the lane',
    );

    await w.clock.advance(PARK_RETRY_MS);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.outcomes.map(o => o.kind),
      ['parked'],
    );
    assert.equal(w.registry().status().lanes[0]?.device, null);
    assert.equal(w.devices.all()[0]?.booted, false);
  } finally {
    w.close();
  }
});

test('a park whose device shutdown fails leaves the lane parked with the problem and the device free in the pool, and the next claim shuts it down', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { boot: true }));
    await w.clock.advance(PARK_MS);
    w.devices.failShutdown = true;
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.outcomes.map(o => o.kind),
      ['parked'],
    );
    const park = parkOf(w, a.lane);
    assert.equal(park?.state, 'parked');
    assert.match(park.problems.join('\n'), /could not be shut down, so it is back in the pool still running/);
    assert.deepEqual(
      w
        .registry()
        .status()
        .pool.map(d => [d.laneId, d.state]),
      [[null, 'booted']],
    );
    w.devices.failShutdown = false;
    await w.registry().claim(w.request(w.procs.owner(), w.folder('b'), { device: null, services: [] }));
    assert.equal(w.devices.all()[0]?.booted, false);
  } finally {
    w.close();
  }
});

function blindPs(system: ServiceSystem, blind: { on: boolean }): ServiceSystem {
  return {
    processes: system.processes,
    running: pids => (blind.on ? undefined : system.running(pids)),
    spawnGroup: (command, options) => system.spawnGroup(command, options),
    listeners: port => system.listeners(port),
    groups: pids => system.groups(pids),
    groupMembers: pgid => (blind.on ? undefined : system.groupMembers(pgid)),
    descendants: pid => system.descendants(pid),
    signalGroup: (pgid, signal) => system.signalGroup(pgid, signal),
    signal: (pid, signal) => system.signal(pid, signal),
  };
}

test("a park that can't stop a service keeps its record and the problem in status, and the next sweep finishes the job", async () => {
  const w = world();
  const service = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { boot: true }));
    const identity = identityOf(systemProcesses, service.pid ?? 0);
    assert.ok(identity);
    w.registry().recordProcess(refOf(a.lane), { service: 'api', pid: identity.pid, start: identity.start, cwd: null });
    await w.clock.advance(PARK_MS);
    const blind = { on: true };
    await runSweep(sweepDeps(w, { system: blindPs(realServiceSystem, blind) }));
    const lane = w.registry().status().lanes[0];
    assert.equal(lane?.park?.state, 'parked');
    assert.deepEqual(
      lane.processes.map(p => p.service),
      ['api'],
    );
    assert.match(lane.park.problems.join('\n'), /left api \(pid \d+, started .*\) alone/);
    assert.equal(lane.device, null, 'the device was freed all the same');
    assert.deepEqual(lane.park.restarts.services, ['api']);

    blind.on = false;
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false, 'not before the retry interval');
    await w.clock.advance(PARK_RETRY_MS);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    await runSweep(sweepDeps(w));
    const after = w.registry().status().lanes[0];
    assert.equal(after?.park?.state, 'parked');
    assert.deepEqual(after.processes, []);
    assert.deepEqual(after.park.problems, []);
    assert.deepEqual(after.park.restarts.services, ['api'], 'the next call still restarts what the first park stopped');
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
  } finally {
    service.kill('SIGKILL');
    w.close();
  }
});

test("a parked lane's record is gone with the lane: a release ends it, parked or not", async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const a = await w.registry().claim(w.request(owner, w.folder('a')));
    await w.clock.advance(PARK_MS);
    await runSweep(sweepDeps(w));
    w.registry().release(refOf(a.lane), owner);
    const db = new DatabaseSync(databasePath(w.dir), { readOnly: true });
    try {
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM parks').get()?.n), 0);
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});

const FORMER_041_SRC = process.env.AGENTLANE_041_SRC;

test(
  "0.4.1's own registry code sees a parked lane alive with its ports held, takes the device it gave back, and never hands out its ports",
  { skip: !FORMER_041_SRC && "set AGENTLANE_041_SRC to 0.4.1's src folder, such as one from git archive 6777fca src" },
  async () => {
    const source = path.join(FORMER_041_SRC ?? '', 'registry', 'registry.ts');
    const { Registry: Registry041 } = (await import(pathToFileURL(source).href)) as { Registry: typeof Registry };
    const w = world({ poolSize: 1, blocks: { metro: { first: 47000, last: 47001 }, api: { first: 47100, last: 47101 } } });
    try {
      const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { boot: true }));
      const device = a.lane.device;
      assert.ok(device);
      await w.clock.advance(PARK_MS);
      await runSweep(sweepDeps(w));
      const former = Registry041.open({
        dir: w.dir,
        processes: w.procs,
        ports: w.probe,
        devices: { ios: w.devices, android: w.emulators },
        config: { ...w.config, idleMs: 2 * 60 * MINUTE_MS } as typeof w.config,
        clock: w.clock,
        pollMs: 500,
        self: w.procs.spawn(),
      });
      try {
        const seen = former.status().lanes.find(c => c.id === a.lane.id);
        assert.equal(seen?.ownerState, 'alive');
        assert.deepEqual(seen.ports, a.lane.ports);
        assert.equal(seen.device, null);
        const b = await former.claim(w.request(w.procs.owner(), w.folder('b'), { boot: true }));
        assert.equal(b.lane.device?.id, device.id, "0.4.1 took the parked lane's simulator");
        const theirs = b.lane.ports.map(p => p.port);
        assert.deepEqual(
          theirs.filter(p => a.lane.ports.some(q => q.port === p)),
          [],
          `0.4.1 handed out a parked lane's port: ${theirs.join(', ')}`,
        );
        assert.deepEqual(b.freed, []);
      } finally {
        former.close();
      }
      assert.equal(parkOf(w, a.lane)?.state, 'parked');
    } finally {
      w.close();
    }
  },
);

test("config.json's parkMinutes sets the park window; idleHours, which only 0.4.1 reads, is still accepted and changes nothing", () => {
  assert.equal(parseConfig({}, 'config.json').parkMs, PARK_MS);
  assert.equal(parseConfig({ parkMinutes: 5 }, 'config.json').parkMs, 5 * MINUTE_MS);
  assert.equal(parseConfig({ parkMinutes: 0.5 }, 'config.json').parkMs, 30_000);
  assert.throws(() => parseConfig({ parkMinutes: 0 }, 'config.json'), /parkMinutes must be a positive number/);
  assert.throws(() => parseConfig({ parkMinutes: '30' }, 'config.json'), /parkMinutes must be a positive number/);
  assert.deepEqual(parseConfig({ idleHours: 0.1 }, 'config.json'), DEFAULT_CONFIG);
  assert.throws(() => parseConfig({ idleHours: -1 }, 'config.json'), /idleHours must be a positive number/);
});
