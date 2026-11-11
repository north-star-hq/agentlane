import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { MINUTE_MS } from '../src/registry/config.ts';
import { formatTime } from '../src/registry/format.ts';
import { MAX_HOLD_MS, parseHoldTime } from '../src/registry/holds.ts';
import type { Owner } from '../src/registry/owner.ts';
import { databasePath } from '../src/registry/paths.ts';
import type { Registry } from '../src/registry/registry.ts';
import { laneLastCall } from '../src/registry/touch.ts';
import type { Lane, LaneRequest, LaneStatus } from '../src/registry/types.ts';
import { runRegistryCommand } from '../src/registry-cli.ts';
import { realServiceSystem } from '../src/services/system.ts';
import { parkLane } from '../src/up/park.ts';
import { passBy, runSweep, sweepDue, type SweepDeps } from '../src/up/sweep.ts';
import { tempDir } from './support/fakes.ts';
import { OWNER_CHECK_MS } from '../src/registry/owner-checks.ts';
import type { World } from './support/world.ts';
import { sawOwners, world } from './support/world.ts';

const PARK_MS = 30 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const REASON = 'the user is reviewing the checkout screen';

interface Session {
  owner: Owner;
  folder: string;
}

interface Claimed extends Session {
  lane: Lane;
}

async function session(w: World, name: string, extra: Partial<LaneRequest> = {}): Promise<Claimed> {
  const owner = w.procs.owner();
  const folder = fs.realpathSync(w.folder(name));
  const { lane } = await w.registry().claim(w.request(owner, folder, extra));
  return { owner, folder, lane };
}

async function cli(w: World, s: Session, command: string, args: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await runRegistryCommand(command, args, {
    env: { AGENTLANE_STATE_DIR: w.dir, AGENTLANE_OWNER_PID: String(s.owner.process?.pid) },
    cwd: s.folder,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: w.procs,
    ports: w.probe,
    devices: { ios: w.devices, android: w.emulators },
    clock: w.clock,
  });
  return { code, out: out.join('') };
}

async function keep(w: World, s: Session, args: string[]): Promise<{ code: number; out: string }> {
  return cli(w, s, 'keep', args);
}

function sweepDeps(w: World, over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    dir: w.dir,
    env: { PATH: process.env.PATH, HOME: tempDir('holds-home') },
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

function due(w: World): boolean {
  return sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs });
}

function statusOf(w: World, lane: Lane): LaneStatus {
  const found = w
    .registry()
    .status()
    .lanes.find(c => c.id === lane.id);
  assert.ok(found, `lane ${lane.id} is gone`);
  return found;
}

function refOf(lane: Lane) {
  return { id: lane.id, token: lane.token };
}

function read<T>(w: World, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath(w.dir), { readOnly: true });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

function holdRows(w: World): number {
  return read(w, db => Number(db.prepare('SELECT COUNT(*) AS n FROM holds').get()?.n));
}

test('a held lane is not parked at the park cutoff nor while the hold lasts, and the first sweep after the hold ends parks it', async () => {
  const w = world();
  try {
    const a = await session(w, 'a', { boot: true });
    await w.clock.advance(20 * MINUTE_MS);
    const kept = await keep(w, a, ['--reason', REASON]);
    assert.equal(kept.code, 0, kept.out);
    const until = w.clock.now() + HOUR_MS;

    await w.clock.advance(PARK_MS);
    sawOwners(w.registry());
    assert.equal(due(w), false, 'a held lane is no work for the commands passing by');
    let started = 0;
    assert.equal(
      passBy({ dir: w.dir, clock: w.clock, processes: w.procs }, () => started++),
      false,
    );
    assert.equal(started, 0);
    let report = await runSweep(sweepDeps(w));
    assert.deepEqual(report, {
      checked: [],
      found: [],
      outcomes: [],
      held: [a.lane.id],
      reaps: [],
      alive: [],
      recorders: [],
      pruned: [],
      problems: [],
    });
    assert.equal(statusOf(w, a.lane).park, null);
    assert.equal(statusOf(w, a.lane).device?.id, a.lane.device?.id);

    await w.clock.advance(until - w.clock.now() - 1000);
    sawOwners(w.registry());
    assert.equal(due(w), false);
    report = await runSweep(sweepDeps(w));
    assert.deepEqual(report.held, [a.lane.id]);
    assert.equal(statusOf(w, a.lane).park, null);

    await w.clock.advance(1000);
    assert.equal(statusOf(w, a.lane).hold, null, 'the hold has ended');
    assert.equal(due(w), true);
    report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.outcomes.map(o => [o.kind, o.lane]),
      [['parked', a.lane.id]],
    );
    assert.deepEqual(report.held, []);
    assert.equal(statusOf(w, a.lane).park?.state, 'parked');
    assert.equal(w.devices.all().find(d => d.id === a.lane.device?.id)?.booted, false);
  } finally {
    w.close();
  }
});

test('a park begun from a list of lanes that predates the hold is refused it inside the registry lock', async () => {
  const w = world();
  try {
    const a = await session(w, 'a', { boot: true });
    assert.equal((await keep(w, a, ['--for', '2h', '--reason', REASON])).code, 0);
    await w.clock.advance(PARK_MS);
    const outcome = await parkLane(sweepDeps(w), w.registry(), { ref: refOf(a.lane), park: null }, w.clock.now() - PARK_MS);
    assert.equal(outcome.kind, 'left');
    assert.equal(statusOf(w, a.lane).park, null);
    assert.equal(statusOf(w, a.lane).device?.id, a.lane.device?.id);
    assert.equal(w.devices.calls.filter(c => c.startsWith('shutdown')).length, 0);
  } finally {
    w.close();
  }
});

test('keep --for takes minutes or hours up to 24h and gives one hour without it; any other time is refused, naming the form or the limit', async () => {
  const w = world();
  try {
    const a = await session(w, 'a');
    const until = () => statusOf(w, a.lane).hold?.until;
    for (const [raw, minutes] of [
      ['45m', 45],
      ['2h', 120],
      ['1h30m', 90],
      ['90m', 90],
      ['24h', 24 * 60],
      ['1440m', 24 * 60],
    ] as const) {
      const r = await keep(w, a, ['--for', raw, '--reason', REASON]);
      assert.equal(r.code, 0, `${raw}: ${r.out}`);
      assert.equal(until(), w.clock.now() + minutes * MINUTE_MS, raw);
    }
    const before = until();
    for (const raw of ['25h', '24h1m', '1441m', '100h']) {
      const r = await keep(w, a, ['--for', raw, '--reason', REASON]);
      assert.equal(r.code, 2, raw);
      assert.match(
        r.out,
        new RegExp(`--for ${raw} is longer than a hold can last, which is 24h\\nto fix: pass --for 24h or less`),
      );
    }
    for (const raw of ['soon', '1.5h', '2 h', '30s', '1d', '2H', 'h', 'm30']) {
      const r = await keep(w, a, ['--for', raw, '--reason', REASON]);
      assert.equal(r.code, 2, raw);
      assert.match(r.out, /is not a time\nto fix: write --for as minutes or hours, such as 45m, 2h or 1h30m/, raw);
    }
    for (const raw of ['0m', '0h', '0h0m']) {
      const r = await keep(w, a, ['--for', raw, '--reason', REASON]);
      assert.equal(r.code, 2, raw);
      assert.match(r.out, /holds the lane for no time\nto fix: pass at least 1m, as minutes or hours, such as 45m/, raw);
    }
    assert.equal(until(), before, 'a refused keep leaves the hold as it was');

    const bare = await keep(w, a, ['--reason', REASON]);
    assert.equal(bare.code, 0, bare.out);
    assert.equal(until(), w.clock.now() + HOUR_MS, 'no --for holds the lane for one hour');

    for (const args of [
      ['--for', '2h'],
      ['--reason', '  '],
    ]) {
      const r = await keep(w, a, args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.out, /keep needs --reason\nto fix: say who is looking at what/);
    }
    assert.equal(until(), w.clock.now() + HOUR_MS);
    assert.equal(parseHoldTime('24h'), MAX_HOLD_MS);
  } finally {
    w.close();
  }
});

test('a second keep replaces the first: a shorter hold ends sooner, and the lane is parked once its park window passes', async () => {
  const w = world();
  try {
    const a = await session(w, 'a', { boot: true });
    assert.equal((await keep(w, a, ['--for', '2h', '--reason', 'the first look'])).code, 0);
    const first = w.clock.now();
    await w.clock.advance(5 * MINUTE_MS);
    const second = await keep(w, a, ['--for', '10m', '--reason', 'the second look']);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, new RegExp(`this replaces its hold until ${formatTime(first + 2 * HOUR_MS)}: the first look`));
    assert.deepEqual(statusOf(w, a.lane).hold, {
      reason: 'the second look',
      since: w.clock.now(),
      until: w.clock.now() + 10 * MINUTE_MS,
    });
    assert.equal(holdRows(w), 1);

    await w.clock.advance(PARK_MS);
    assert.ok(w.clock.now() < first + 2 * HOUR_MS, 'the first hold would still hold the lane');
    assert.equal(due(w), true);
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.outcomes.map(o => [o.kind, o.lane]),
      [['parked', a.lane.id]],
    );
  } finally {
    w.close();
  }
});

test("release ends the hold with the lane, and the folder's next lane starts with none", async () => {
  const w = world();
  try {
    const a = await session(w, 'a');
    assert.equal((await keep(w, a, ['--for', '2h', '--reason', REASON])).code, 0);
    assert.equal(holdRows(w), 1);
    w.registry().releaseOwn(a.owner, a.folder);
    assert.equal(holdRows(w), 0, 'the hold went with the lane');

    const again = await w.registry().claim(w.request(a.owner, a.folder));
    assert.notEqual(again.lane.id, a.lane.id);
    assert.equal(statusOf(w, again.lane).hold, null);
    await w.clock.advance(PARK_MS);
    assert.equal(due(w), true);
  } finally {
    w.close();
  }
});

test("the owner's death ends its hold: the sweep no longer counts the lane as held, parks it as any gone owner's lane, and drops the hold", async () => {
  const w = world();
  try {
    const a = await session(w, 'a', { boot: true });
    assert.equal((await keep(w, a, ['--for', '2h', '--reason', REASON])).code, 0);
    await w.clock.advance(PARK_MS);

    w.procs.blind = true;
    assert.notEqual(statusOf(w, a.lane).hold, null, "an owner that can't be judged keeps its hold");
    assert.deepEqual((await runSweep(sweepDeps(w))).held, [a.lane.id]);
    w.procs.blind = false;

    w.procs.kill(a.owner.process?.pid ?? 0);
    assert.equal(statusOf(w, a.lane).ownerState, 'dead');
    assert.equal(statusOf(w, a.lane).hold, null, 'status shows no hold on a dead owner');
    await w.clock.advance(OWNER_CHECK_MS);
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(report.found, [{ lane: a.lane.id, state: 'dead' }]);
    assert.deepEqual(
      report.outcomes.map(o => [o.kind, o.lane]),
      [['parked', a.lane.id]],
    );
    assert.deepEqual(report.held, []);
    assert.equal(holdRows(w), 0, 'the sweep recorded that the hold ended');
  } finally {
    w.close();
  }
});

test('a hold belongs to the owner that placed it: no other session can hold the lane, and once the lane has a new owner it is held no more', async () => {
  const w = world();
  try {
    const a = await session(w, 'a');
    const other = { owner: w.procs.owner(), folder: a.folder };
    const refused = await keep(w, other, ['--reason', REASON]);
    assert.equal(refused.code, 3, refused.out);
    assert.match(refused.out, new RegExp(`holds no lane in ${a.folder}\\nto recover: node_modules/\\.bin/agentlane up `));
    assert.equal(statusOf(w, a.lane).hold, null);

    const elsewhere = await keep(w, { owner: a.owner, folder: fs.realpathSync(w.folder('b')) }, ['--reason', REASON]);
    assert.equal(elsewhere.code, 3, 'a session holds only the lane of the folder it names');
    assert.equal(holdRows(w), 0);

    assert.equal((await keep(w, a, ['--for', '2h', '--reason', REASON])).code, 0);
    const next = w.procs.spawn();
    const db = new DatabaseSync(databasePath(w.dir));
    try {
      db.prepare('UPDATE claims SET owner_key = ?, owner_pid = ?, owner_start = ? WHERE id = ?').run(
        `process:${String(next.pid)}:${next.start}`,
        next.pid,
        next.start,
        a.lane.id,
      );
    } finally {
      db.close();
    }
    assert.equal(statusOf(w, a.lane).hold, null);
    await w.clock.advance(PARK_MS);
    assert.equal(due(w), true, "the former owner's hold keeps the lane up no more");
  } finally {
    w.close();
  }
});

test('status shows the hold with its reason and its end, and lanes --json carries them as hold', async () => {
  const w = world();
  try {
    const a = await session(w, 'a');
    const b = await session(w, 'b');
    assert.equal((await keep(w, a, ['--for', '2h', '--reason', REASON])).code, 0);
    const since = w.clock.now();
    const until = since + 2 * HOUR_MS;
    await w.clock.advance(MINUTE_MS);

    const status = await cli(w, a, 'status', []);
    assert.equal(status.code, 0, status.out);
    const escaped = REASON.replaceAll('.', '\\.');
    assert.match(status.out, new RegExp(`\\n {6}held {9}until ${formatTime(until)} \\(1h 59m left\\): ${escaped}\\n`));
    assert.match(status.out, /unless a hold keeps it up/);

    const listed = await cli(w, a, 'lanes', ['--json']);
    assert.equal(listed.code, 0, listed.out);
    const lanes = (JSON.parse(listed.out) as { lanes: LaneStatus[] }).lanes;
    assert.deepEqual(lanes.find(c => c.id === a.lane.id)?.hold, { reason: REASON, since, until });
    assert.equal(lanes.find(c => c.id === b.lane.id)?.hold, null);
  } finally {
    w.close();
  }
});

test('keep counts as a call on the lane, in the registry and in the lane folder, and leaves a parked lane parked for its next call', async () => {
  const w = world();
  try {
    const a = await session(w, 'a', { boot: true });
    await w.clock.advance(10 * MINUTE_MS);
    assert.equal((await keep(w, a, ['--reason', REASON])).code, 0);
    const row = read(w, db => db.prepare('SELECT last_used_at, last_action FROM claims WHERE id = ?').get(a.lane.id));
    assert.deepEqual({ ...row }, { last_used_at: w.clock.now(), last_action: 'keep' });
    assert.equal(laneLastCall(w.dir, { ...refOf(a.lane), lastUsedAt: 0 }), w.clock.now(), 'the lane folder records the call');

    await w.clock.advance(HOUR_MS);
    assert.deepEqual(
      (await runSweep(sweepDeps(w))).outcomes.map(o => o.kind),
      ['parked'],
    );
    const again = await keep(w, a, ['--reason', REASON]);
    assert.equal(again.code, 0, again.out);
    assert.match(
      again.out,
      new RegExp(
        `lane ${a.lane.id} is parked; its next call brings back an iOS simulator .*, and the hold keeps it up from then`,
      ),
    );
    const lane = statusOf(w, a.lane);
    assert.equal(lane.park?.state, 'parked', 'keep does not wake a parked lane');
    assert.equal(lane.device, null);
    assert.notEqual(lane.hold, null);
    assert.equal(lane.lastAction, 'keep');
  } finally {
    w.close();
  }
});

const FORMER_041_SRC = process.env.AGENTLANE_041_SRC;

test(
  "0.4.1's own registry code shares a registry with holds: it ends a dead owner's held lane, and the hold goes with it",
  { skip: !FORMER_041_SRC && "set AGENTLANE_041_SRC to 0.4.1's src folder, such as one from git archive 6777fca src" },
  async () => {
    const source = path.join(FORMER_041_SRC ?? '', 'registry', 'registry.ts');
    const { Registry: Registry041 } = (await import(pathToFileURL(source).href)) as { Registry: typeof Registry };
    const w = world();
    const former = () =>
      Registry041.open({
        dir: w.dir,
        processes: w.procs,
        ports: w.probe,
        devices: { ios: w.devices, android: w.emulators },
        config: { ...w.config, idleMs: 2 * HOUR_MS } as typeof w.config,
        clock: w.clock,
        pollMs: 500,
        self: w.procs.spawn(),
      });
    try {
      former().close();
      const a = await session(w, 'a');
      assert.equal((await keep(w, a, ['--for', '2h', '--reason', REASON])).code, 0);
      w.procs.kill(a.owner.process?.pid ?? 0);
      const old = former();
      try {
        const b = await old.claim(w.request(w.procs.owner(), w.folder('b'), { device: null, services: [] }));
        assert.deepEqual(
          (b as unknown as { freed: { id: string }[] }).freed.map(e => e.id),
          [a.lane.id],
        );
      } finally {
        old.close();
      }
      assert.equal(holdRows(w), 0);
    } finally {
      w.close();
    }
  },
);
