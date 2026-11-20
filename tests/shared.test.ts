import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SharedServiceConfig } from '../src/project/config.ts';
import { MINUTE_MS } from '../src/registry/config.ts';
import { RETURN_WINDOW_MS } from '../src/registry/owner-checks.ts';
import { NOTHING_TO_RESTART } from '../src/registry/parks.ts';
import { databasePath } from '../src/registry/paths.ts';
import { SHARED_IDLE_MS, SHARED_STOP_RETRY_MS } from '../src/registry/shared.ts';
import { Store } from '../src/registry/store.ts';
import type { Lane } from '../src/registry/types.ts';
import { realServiceSystem } from '../src/services/system.ts';
import type { SharedRunDeps } from '../src/up/shared.ts';
import {
  SHARED_WAIT_POLL_MS,
  SharedServiceFailed,
  sharedDir,
  startSharedForLane,
  startSharedForTeardown,
} from '../src/up/shared.ts';
import { runSweep, sweepDue, type SweepDeps } from '../src/up/sweep.ts';
import { tempDir } from './support/fakes.ts';
import type { World } from './support/world.ts';
import { parkNow, sawOwners, world } from './support/world.ts';

const SCHEMA_0_5_1 = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'registry-0.5.1.sql'), 'utf8');

interface Fixture {
  dir: string;
  up: string;
  spec(over?: Partial<SharedServiceConfig>): SharedServiceConfig;
  lines(): string[];
}

/** A shared service whose commands append what ran to a log file, and which runs while its `up` file exists. */
function fixture(): Fixture {
  const dir = tempDir('shared');
  const log = path.join(dir, 'log');
  const up = path.join(dir, 'up');
  return {
    dir,
    up,
    spec: over => ({
      name: 'db',
      start: `echo start >> '${log}' && touch '${up}'`,
      stop: `echo stop >> '${log}' && rm -f '${up}'`,
      ready: `test -f '${up}'`,
      cwd: dir,
      timeoutMs: 5000,
      ...over,
    }),
    lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

function deps(w: World): SharedRunDeps {
  return { env: { PATH: process.env.PATH }, clock: w.clock };
}

function sweepDeps(w: World): SweepDeps {
  return {
    dir: w.dir,
    env: { PATH: process.env.PATH, HOME: tempDir('shared-home') },
    processes: w.procs,
    system: realServiceSystem,
    clock: w.clock,
    devices: { ios: w.devices, android: w.emulators },
    ports: w.probe,
    config: w.config,
    self: w.procs.spawn(),
  };
}

function refOf(lane: Lane) {
  return { id: lane.id, token: lane.token };
}

async function lane(w: World, name: string, repository: string): Promise<Lane> {
  const request = w.request(w.procs.owner(), w.folder(name), { device: null, services: [], projectRoot: repository });
  return (await w.registry().claim(request)).lane;
}

function stateOf(w: World): string | undefined {
  return w.registry().sharedServices()[0]?.state;
}

async function sweepStops(w: World): Promise<string[]> {
  sawOwners(w.registry());
  const report = await runSweep(sweepDeps(w));
  return report.shared.map(s => `${s.name} ${s.outcome}`);
}

/** Advances the fake clock until `promise` settles, for a start that waits on another process's start or stop. */
async function settle<T>(w: World, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  tracked.catch(() => undefined);
  const deadline = Date.now() + 20_000;
  while (!state.done) {
    if (Date.now() > deadline) throw new Error('the start never finished');
    await new Promise(resolve => setTimeout(resolve, 5));
    if (w.clock.sleeping > 0) await w.clock.advance(SHARED_WAIT_POLL_MS);
  }
  return tracked;
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a shared service stops 5 minutes after the last lane that needs it parks, at the first sweep after, and never while one is active', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const b = await lane(w, 'b', repo);
    const started = await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    assert.deepEqual(
      started.map(s => s.outcome),
      ['started'],
    );
    const kept = await startSharedForLane(deps(w), w.registry(), refOf(b), [f.spec()]);
    assert.deepEqual(
      kept.map(s => s.outcome),
      ['kept'],
    );
    assert.deepEqual(f.lines(), ['start']);

    assert.ok(parkNow(w.registry(), refOf(a)));
    await w.clock.advance(SHARED_IDLE_MS * 3);
    assert.deepEqual(await sweepStops(w), [], 'lane b is active and needs it');
    assert.equal(stateOf(w), 'running');
    assert.deepEqual(w.registry().sharedServices()[0]?.lanes, [b.id]);

    assert.ok(parkNow(w.registry(), refOf(b)));
    const parkedAt = w.clock.now();
    const status = w.registry().sharedServices()[0];
    assert.deepEqual([status?.lanes, status?.unneededSince, status?.stopsAt], [[], parkedAt, parkedAt + SHARED_IDLE_MS]);

    await w.clock.advance(SHARED_IDLE_MS - 1000);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
    assert.deepEqual(await sweepStops(w), []);
    assert.equal(stateOf(w), 'running');

    await w.clock.advance(1000);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    assert.equal(stateOf(w), 'stopped');
    assert.deepEqual(f.lines(), ['start', 'stop']);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
  } finally {
    w.close();
  }
});

test('a release of the last lane that needs it marks it the same way, and so does a reap of a lane that was still active', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const owner = w.procs.owner();
    const a = (await w.registry().claim(w.request(owner, w.folder('a'), { device: null, services: [], projectRoot: repo }))).lane;
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    await w.clock.advance(MINUTE_MS);
    w.registry().release(refOf(a), owner);
    const releasedAt = w.clock.now();
    assert.equal(w.registry().sharedServices()[0]?.unneededSince, releasedAt);
    await w.clock.advance(SHARED_IDLE_MS - 1);
    assert.deepEqual(await sweepStops(w), []);
    await w.clock.advance(1);
    assert.deepEqual(await sweepStops(w), ['db stopped']);

    const reaped = w.procs.owner();
    const b = (await w.registry().claim(w.request(reaped, w.folder('b'), { device: null, services: [], projectRoot: repo })))
      .lane;
    await startSharedForLane(deps(w), w.registry(), refOf(b), [f.spec()]);
    w.procs.kill(reaped.process?.pid ?? 0);
    const reaper = w.registry();
    reaper.noteOwners([], [{ id: b.id, ownerKey: b.ownerKey, process: reaped.process, state: 'dead' }]);
    await w.clock.advance(RETURN_WINDOW_MS);
    assert.equal(
      w.registry().sharedServices()[0]?.unneededSince,
      null,
      'a lane whose owner is gone is active until it parks or ends',
    );
    const begun = reaper.beginReap(refOf(b), 'attempt', []);
    assert.equal(begun.kind, 'taken');
    assert.ok(reaper.endReaped(refOf(b), 'attempt'));
    assert.equal(w.registry().sharedServices()[0]?.unneededSince, w.clock.now());
    assert.deepEqual(f.lines(), ['start', 'stop', 'start']);
  } finally {
    w.close();
  }
});

test('a lane whose owner dies is parked by the sweep, and its shared service stops 5 minutes after that park', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const owner = w.procs.owner();
    const a = (await w.registry().claim(w.request(owner, w.folder('a'), { device: null, services: [], projectRoot: repo }))).lane;
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    w.procs.kill(owner.process?.pid ?? 0);
    await w.clock.advance(3 * MINUTE_MS);
    const found = await runSweep(sweepDeps(w));
    assert.deepEqual(
      found.outcomes.map(o => o.kind),
      ['parked'],
    );
    const parkedAt = w.clock.now();
    assert.equal(w.registry().sharedServices()[0]?.unneededSince, parkedAt);
    await w.clock.advance(SHARED_IDLE_MS - 1000);
    assert.deepEqual((await runSweep(sweepDeps(w))).shared, []);
    await w.clock.advance(1000);
    assert.deepEqual(
      (await runSweep(sweepDeps(w))).shared.map(s => s.outcome),
      ['stopped'],
    );
    assert.deepEqual(f.lines(), ['start', 'stop']);
  } finally {
    w.close();
  }
});

test('a lane that comes up while the sweep stops the service waits for the stop, then starts it: the log shows the stop, then the start', async () => {
  const w = world();
  const f = fixture();
  const gate = path.join(f.dir, 'gate');
  const log = path.join(f.dir, 'log');
  try {
    const repo = w.folder('repo');
    const spec = f.spec({
      start: `echo start-begin >> '${log}'; touch '${f.up}'; echo start-end >> '${log}'`,
      stop: `echo stop-begin >> '${log}'; while [ ! -f '${gate}' ]; do sleep 0.02; done; rm -f '${f.up}'; echo stop-end >> '${log}'`,
    });
    const a = await lane(w, 'a', repo);
    await startSharedForLane(deps(w), w.registry(), refOf(a), [spec]);
    assert.ok(parkNow(w.registry(), refOf(a)));
    await w.clock.advance(SHARED_IDLE_MS);

    sawOwners(w.registry());
    const sweeping = runSweep(sweepDeps(w));
    await until(() => f.lines().includes('stop-begin'));
    const b = await lane(w, 'b', repo);
    const starting = startSharedForLane(deps(w), w.registry(), refOf(b), [spec]);
    await until(() => w.clock.sleeping > 0);
    assert.equal(stateOf(w), 'stopping');
    fs.writeFileSync(gate, '');
    assert.deepEqual(
      (await sweeping).shared.map(s => s.outcome),
      ['stopped'],
    );
    const started = await settle(w, starting);
    assert.deepEqual(
      started.map(s => s.outcome),
      ['started'],
    );
    assert.equal(stateOf(w), 'running');
    assert.ok(fs.existsSync(f.up));
    assert.deepEqual(f.lines(), ['start-begin', 'start-end', 'stop-begin', 'stop-end', 'start-begin', 'start-end']);
  } finally {
    w.close();
  }
});

test('two lanes coming up together start it once', async () => {
  const w = world();
  const f = fixture();
  const log = path.join(f.dir, 'log');
  try {
    const repo = w.folder('repo');
    const spec = f.spec({ start: `echo start >> '${log}'; sleep 0.3; touch '${f.up}'` });
    const a = await lane(w, 'a', repo);
    const b = await lane(w, 'b', repo);
    const both = await settle(
      w,
      Promise.all([
        startSharedForLane(deps(w), w.registry(), refOf(a), [spec]),
        startSharedForLane(deps(w), w.registry(), refOf(b), [spec]),
      ]),
    );
    assert.deepEqual(
      both
        .flat()
        .map(s => s.outcome)
        .sort(),
      ['kept', 'started'],
    );
    assert.deepEqual(f.lines(), ['start']);
    assert.deepEqual(w.registry().sharedServices()[0]?.lanes, [a.id, b.id].sort());
  } finally {
    w.close();
  }
});

test("a lane whose resources and services don't need it doesn't keep it up, nor does a lane that stopped needing it", async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const c = await lane(w, 'c', repo);
    const d = await lane(w, 'd', repo);
    const other = await lane(w, 'other', w.folder('other-repo'));
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    await startSharedForLane(deps(w), w.registry(), refOf(c), []);
    await startSharedForLane(deps(w), w.registry(), refOf(d), [f.spec()]);
    w.registry().recordNeeds(refOf(other), ['db']);
    assert.deepEqual(w.registry().sharedServices()[0]?.lanes, [a.id, d.id].sort());
    assert.deepEqual(
      [a, c, other].map(l => w.registry().needsOf(l.id)),
      [['db'], [], ['db']],
    );

    assert.ok(parkNow(w.registry(), refOf(a)));
    await w.clock.advance(MINUTE_MS);
    w.registry().recordNeeds(refOf(d), []);
    const droppedAt = w.clock.now();
    assert.equal(
      w.registry().sharedServices()[0]?.unneededSince,
      droppedAt,
      'the moment the last active lane stopped needing it',
    );
    await w.clock.advance(SHARED_IDLE_MS);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    assert.deepEqual(f.lines(), ['start', 'stop']);
    assert.equal(w.registry().sharedServices().length, 1, "another repository's lane needing a db never shares this one");
  } finally {
    w.close();
  }
});

test('a failed stop keeps it running with the problem, readable in the shared read, and the next sweep after the retry time stops it', async () => {
  const w = world();
  const f = fixture();
  const log = path.join(f.dir, 'log');
  const failOnce = path.join(f.dir, 'fail-once');
  try {
    const repo = w.folder('repo');
    const spec = f.spec({
      stop: `if [ -f '${failOnce}' ]; then rm '${failOnce}'; echo docker is not running >&2; exit 3; fi; echo stop >> '${log}'; rm -f '${f.up}'`,
    });
    fs.writeFileSync(failOnce, '');
    const a = await lane(w, 'a', repo);
    await startSharedForLane(deps(w), w.registry(), refOf(a), [spec]);
    assert.ok(parkNow(w.registry(), refOf(a)));
    const parkedAt = w.clock.now();
    await w.clock.advance(SHARED_IDLE_MS);
    sawOwners(w.registry());
    const failed = await runSweep(sweepDeps(w));
    assert.deepEqual(
      failed.shared.map(s => s.outcome),
      ['failed'],
    );
    assert.match(
      failed.problems.join('\n'),
      /^shared service db of .*: stop exited 3: [^\n]*\n(.|\n)* {2}\| docker is not running\nfull log: /,
    );
    const status = w.registry().sharedServices()[0];
    assert.equal(status?.state, 'running');
    assert.match(status.problem ?? '', /^stop exited 3: /);
    assert.equal(status.attempts, 1);
    assert.equal(status.unneededSince, parkedAt);
    assert.equal(status.stopsAt, w.clock.now() + SHARED_STOP_RETRY_MS);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false, 'not due again before the retry time');

    await w.clock.advance(SHARED_STOP_RETRY_MS);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    const after = w.registry().sharedServices()[0];
    assert.deepEqual([after?.state, after?.problem, after?.attempts], ['stopped', null, 0]);
    assert.deepEqual(f.lines(), ['start', 'stop']);
  } finally {
    w.close();
  }
});

test('a service whose ready already passes the first time agentlane sees it is recorded as running without its start, and stops under the same rule', async () => {
  const w = world();
  const f = fixture();
  try {
    fs.writeFileSync(f.up, '');
    const a = await lane(w, 'a', w.folder('repo'));
    const started = await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    assert.deepEqual(
      started.map(s => s.outcome),
      ['found-running'],
    );
    assert.equal(stateOf(w), 'running');
    assert.deepEqual(f.lines(), []);
    w.registry().release(refOf(a), a.owner);
    await w.clock.advance(SHARED_IDLE_MS);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    assert.deepEqual(f.lines(), ['stop']);
  } finally {
    w.close();
  }
});

test('a stop runs the commands its last start recorded, after agentlane.json changed and after the worktree that started it was deleted', async () => {
  const w = world();
  const f = fixture();
  const log = path.join(f.dir, 'log');
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const b = await lane(w, 'b', repo);
    const v1 = f.spec({ cwd: a.worktree, stop: `echo "stop-v1 $(pwd)" >> '${log}'; rm -f '${f.up}'` });
    const v2 = f.spec({ cwd: b.worktree, stop: `echo stop-v2 >> '${log}'; rm -f '${f.up}'` });
    await startSharedForLane(deps(w), w.registry(), refOf(a), [v1]);
    assert.deepEqual(
      (await startSharedForLane(deps(w), w.registry(), refOf(a), [v2])).map(s => s.outcome),
      ['kept'],
    );
    await startSharedForLane(deps(w), w.registry(), refOf(b), [v2]);
    assert.equal(w.registry().sharedServices()[0]?.commands.stop, v1.stop);
    for (const l of [a, b]) w.registry().release(refOf(l), l.owner);
    fs.rmSync(a.worktree, { recursive: true, force: true });

    await w.clock.advance(SHARED_IDLE_MS);
    sawOwners(w.registry());
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.shared.map(s => [s.outcome, s.moved]),
      [['stopped', true]],
    );
    const folder = fs.realpathSync(sharedDir(w.dir, repo));
    assert.deepEqual(f.lines(), ['start', `stop-v1 ${folder}`]);
  } finally {
    w.close();
  }
});

test('a stop never runs while a resource teardown that needs it holds its row, and it stops 5 minutes after the teardown lets go', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const maker = w.registry();
    maker.startResource(refOf(a), {
      name: 'appdb',
      cwd: a.worktree,
      teardown: 'true',
      timeoutMs: 1000,
      env: {},
      cleared: [],
      needs: ['db'],
    });
    maker.finishResource(a.id, 'appdb', {});
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    w.registry().release(refOf(a), a.owner);
    await w.clock.advance(SHARED_IDLE_MS);

    const reaper = w.registry();
    const [teardown] = reaper.takeTeardowns();
    assert.deepEqual([teardown?.repository, teardown?.needs], [repo, ['db']]);
    assert.ok(teardown);
    assert.deepEqual(
      (await startSharedForTeardown(deps(w), reaper, teardown)).map(s => s.outcome),
      ['kept'],
    );
    assert.deepEqual(w.registry().sharedServices()[0]?.holding, [{ lane: a.id, resource: 'appdb' }]);
    await w.clock.advance(SHARED_IDLE_MS * 2);
    assert.deepEqual(await sweepStops(w), [], 'the teardown holds its row');
    const left = w.registry().beginSharedStop({ repository: repo, name: 'db' });
    assert.deepEqual(
      left.kind === 'left' ? left.reason : left.kind,
      `resource appdb of lane ${a.id}, which needs it, is being created or torn down`,
    );

    reaper.finishTeardown(a.id, 'appdb');
    const doneAt = w.clock.now();
    assert.equal(w.registry().sharedServices()[0]?.unneededSince, doneAt);
    await w.clock.advance(SHARED_IDLE_MS - 1);
    assert.deepEqual(await sweepStops(w), []);
    await w.clock.advance(1);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    assert.deepEqual(f.lines(), ['start', 'stop']);
  } finally {
    w.close();
  }
});

test('a teardown whose shared service was stopped starts it again with the recorded commands, and it stops 5 minutes after', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const maker = w.registry();
    maker.startResource(refOf(a), {
      name: 'appdb',
      cwd: a.worktree,
      teardown: 'true',
      timeoutMs: 1000,
      env: {},
      cleared: [],
      needs: ['db'],
    });
    maker.finishResource(a.id, 'appdb', {});
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    assert.ok(parkNow(w.registry(), refOf(a)));
    await w.clock.advance(SHARED_IDLE_MS);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    w.registry().release(refOf(a), a.owner);

    const reaper = w.registry();
    const [teardown] = reaper.takeTeardowns();
    assert.ok(teardown);
    assert.deepEqual(
      (await startSharedForTeardown(deps(w), reaper, teardown)).map(s => s.outcome),
      ['started'],
    );
    reaper.finishTeardown(a.id, 'appdb');
    await w.clock.advance(SHARED_IDLE_MS);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    assert.deepEqual(f.lines(), ['start', 'stop', 'start', 'stop']);

    const unknown = await startSharedForTeardown(deps(w), reaper, { ...teardown, needs: ['cache'] }).catch((e: unknown) => e);
    assert.ok(unknown instanceof SharedServiceFailed);
    assert.match(unknown.message, /^shared service cache: no start of it is recorded for /);
  } finally {
    w.close();
  }
});

test('a holder that died mid-start or mid-stop does not block the next lane: it takes the start over', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const dying = w.procs.spawn();
    const starter = w.registry({ self: dying });
    const claim = starter.beginSharedStart({ lane: refOf(a) }, 'db', { ...f.spec(), env: {} }, false);
    assert.equal(claim.kind, 'claimed');
    w.procs.kill(dying.pid);

    const b = await lane(w, 'b', repo);
    const took = await startSharedForLane(deps(w), w.registry(), refOf(b), [f.spec()]);
    assert.deepEqual(
      took.map(s => [s.outcome, s.took]),
      [['started', { state: 'starting', pid: dying.pid }]],
    );
    assert.deepEqual(f.lines(), ['start']);

    for (const l of [a, b]) assert.ok(parkNow(w.registry(), refOf(l)));
    await w.clock.advance(SHARED_IDLE_MS);
    const stopping = w.procs.spawn();
    const stopper = w.registry({ self: stopping });
    assert.equal(stopper.beginSharedStop({ repository: repo, name: 'db' }).kind, 'claimed');
    w.procs.kill(stopping.pid);
    const c = await lane(w, 'c', repo);
    const again = await startSharedForLane(deps(w), w.registry(), refOf(c), [f.spec()]);
    assert.deepEqual(
      again.map(s => [s.outcome, s.took]),
      [['found-running', { state: 'stopping', pid: stopping.pid }]],
      "the dead stop never ran, so ready passes and the start isn't run",
    );
    assert.equal(stateOf(w), 'running');
  } finally {
    w.close();
  }
});

test('a sweep takes over a stop whose holder died once nothing needs the service, and a live holder makes a start wait', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    w.registry().release(refOf(a), a.owner);
    await w.clock.advance(SHARED_IDLE_MS);
    const stopping = w.procs.spawn();
    assert.equal(w.registry({ self: stopping }).beginSharedStop({ repository: repo, name: 'db' }).kind, 'claimed');

    const b = await lane(w, 'b', repo);
    const waiting = startSharedForLane(deps(w), w.registry(), refOf(b), [f.spec()]);
    await until(() => w.clock.sleeping > 0);
    assert.equal(stateOf(w), 'stopping', 'the start waits while the stop holder lives');
    w.procs.kill(stopping.pid);
    assert.deepEqual(
      (await settle(w, waiting)).map(s => s.outcome),
      ['found-running'],
    );
    w.registry().release(refOf(b), b.owner);

    await w.clock.advance(SHARED_IDLE_MS);
    const dead = w.procs.spawn();
    assert.equal(w.registry({ self: dead }).beginSharedStop({ repository: repo, name: 'db' }).kind, 'claimed');
    w.procs.kill(dead.pid);
    await w.clock.advance(3 * f.spec().timeoutMs);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.shared.map(s => [s.outcome, s.took?.state]),
      [['stopped', 'stopping']],
    );
    assert.deepEqual(f.lines(), ['start', 'stop']);
  } finally {
    w.close();
  }
});

test('a failed start leaves it stopped with the problem, undoes what the start began, and throws naming the service and its output', async () => {
  const w = world();
  const f = fixture();
  const log = path.join(f.dir, 'log');
  try {
    const a = await lane(w, 'a', w.folder('repo'));
    const spec = f.spec({ start: `echo start >> '${log}'; echo port 5432 is taken >&2; exit 4` });
    const error = await startSharedForLane(deps(w), w.registry(), refOf(a), [spec]).catch((e: unknown) => e);
    assert.ok(error instanceof SharedServiceFailed);
    assert.equal(error.service, 'db');
    assert.match(error.message, /^shared service db: start exited 4: .*\n(.|\n)*port 5432 is taken(.|\n)*full log: /);
    const status = w.registry().sharedServices()[0];
    assert.deepEqual([status?.state, status?.problem?.startsWith('start exited 4: ')], ['stopped', true]);
    assert.deepEqual(f.lines(), ['start', 'stop']);

    const never = f.spec({ start: `echo start >> '${log}'`, timeoutMs: 1000 });
    const waiting = startSharedForLane(deps(w), w.registry(), refOf(a), [never]);
    const timedOut = await settle(w, waiting).catch((e: unknown) => e);
    assert.ok(timedOut instanceof SharedServiceFailed);
    assert.match(timedOut.message, /^shared service db: ready did not pass within 1 s of its start: test -f /);
    assert.equal(stateOf(w), 'stopped');
  } finally {
    w.close();
  }
});

test('a service recorded as running whose ready fails, as after a reboot, is started again rather than kept', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    fs.rmSync(f.up);
    const b = await lane(w, 'b', repo);
    assert.deepEqual(
      (await startSharedForLane(deps(w), w.registry(), refOf(b), [f.spec()])).map(s => s.outcome),
      ['started'],
    );
    assert.deepEqual(f.lines(), ['start', 'start']);
  } finally {
    w.close();
  }
});

test('a wake that gives up parks the lane again and marks its shared service, and a running one nothing ever marked is marked by the sweep', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]);
    assert.ok(parkNow(w.registry(), refOf(a)));
    await w.clock.advance(MINUTE_MS);
    const waker = w.registry();
    assert.equal(waker.beginWake(refOf(a), 'wake-1', null).kind, 'taken');
    await startSharedForLane(deps(w), waker, refOf(a), [f.spec()]);
    assert.equal(w.registry().sharedServices()[0]?.unneededSince, null);
    await w.clock.advance(MINUTE_MS);
    waker.giveUp(refOf(a), 'wake-1', ['the bundler would not start']);
    assert.equal(w.registry().sharedServices()[0]?.unneededSince, w.clock.now());

    const db = new DatabaseSync(databasePath(w.dir));
    db.exec('UPDATE shared_services SET unneeded_since = NULL');
    db.close();
    await w.clock.advance(SHARED_IDLE_MS);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    assert.deepEqual(await sweepStops(w), [], 'marked now, stopped 5 minutes from now');
    assert.equal(w.registry().sharedServices()[0]?.unneededSince, w.clock.now());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
    await w.clock.advance(SHARED_IDLE_MS);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
  } finally {
    w.close();
  }
});

test('a 0.5.x registry gains the shared service tables and the resource columns, and 0.5.x writes still work beside them', async () => {
  const w = world();
  try {
    fs.mkdirSync(w.dir, { recursive: true });
    const old = new DatabaseSync(databasePath(w.dir));
    old.exec(SCHEMA_0_5_1);
    old.exec('PRAGMA user_version = 1');
    old.close();

    for (let i = 0; i < 2; i++) Store.open(w.dir, 5000).close();
    const db = new DatabaseSync(databasePath(w.dir));
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(r => String(r.name));
      for (const t of ['shared_services', 'shared_needs']) assert.ok(tables.includes(t), t);
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('resources')")
        .all()
        .map(r => String(r.name));
      assert.ok(columns.includes('repository') && columns.includes('needs'));
    } finally {
      db.close();
    }

    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    w.registry().recordNeeds(refOf(a), ['db']);
    const former = new DatabaseSync(databasePath(w.dir));
    try {
      former.exec('PRAGMA foreign_keys = ON');
      former
        .prepare(
          `INSERT INTO resources (claim_id, name, worktree, cwd, teardown, timeout_ms, env, cleared, created_at)
           VALUES (?, 'old', ?, ?, 'true', 1000, '{}', '[]', 0)`,
        )
        .run(a.id, a.worktree, a.worktree);
      former.prepare('DELETE FROM claims WHERE id = ?').run(a.id);
      assert.equal(
        former.prepare('SELECT COUNT(*) AS n FROM shared_needs').get()?.n,
        0,
        "0.5.x's lane delete takes the lane's needs with it",
      );
    } finally {
      former.close();
    }
    const [teardown] = w.registry().takeTeardowns();
    assert.deepEqual([teardown?.name, teardown?.repository, teardown?.needs], ['old', null, []]);
  } finally {
    w.close();
  }
});

test('a lane parked mid-start leaves the service marked once the start finishes', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const starter = w.registry();
    const claim = starter.beginSharedStart({ lane: refOf(a) }, 'db', { ...f.spec(), env: {} }, false);
    assert.equal(claim.kind, 'claimed');
    const attempt = 'park-1';
    const parker = w.registry();
    assert.ok(parker.beginPark(refOf(a), Number.MAX_SAFE_INTEGER, attempt, null));
    assert.ok(parker.finishPark(refOf(a), attempt, NOTHING_TO_RESTART, [], []));
    const parkedAt = w.clock.now();
    await w.clock.advance(1000);
    assert.equal(starter.finishSharedStart({ repository: repo, name: 'db' }), true);
    const status = w.registry().sharedServices()[0];
    assert.deepEqual([status?.state, status?.unneededSince], ['running', parkedAt]);
  } finally {
    w.close();
  }
});
