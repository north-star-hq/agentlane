import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { systemClock } from '../src/clock.ts';
import { identityOf, killGroup, systemProcesses } from '../src/processes.ts';
import type { SharedServiceConfig } from '../src/project/config.ts';
import type { RegistryConfig } from '../src/registry/config.ts';
import { MINUTE_MS } from '../src/registry/config.ts';
import type { Owner } from '../src/registry/owner.ts';
import { RETURN_WINDOW_MS } from '../src/registry/owner-checks.ts';
import { NOTHING_TO_RESTART } from '../src/registry/parks.ts';
import { databasePath } from '../src/registry/paths.ts';
import { Registry } from '../src/registry/registry.ts';
import { TEARDOWN_RETRY_MS } from '../src/registry/resources.ts';
import { SHARED_IDLE_MS, SHARED_READY_RUN_MAX_MS, SHARED_STOP_RETRY_MS, sharedHoldMs } from '../src/registry/shared.ts';
import { Store } from '../src/registry/store.ts';
import type { Lane } from '../src/registry/types.ts';
import { realServiceSystem } from '../src/services/system.ts';
import { tearDownEndedResources } from '../src/up/resources.ts';
import type { SharedRunDeps } from '../src/up/shared.ts';
import {
  SHARED_WAIT_POLL_MS,
  SharedServiceFailed,
  sharedDir,
  startSharedForLane,
  startSharedForTeardown,
  stopUnneededShared,
} from '../src/up/shared.ts';
import { runSweep, SWEEP_INTERVAL_MS, sweepDue, type SweepDeps } from '../src/up/sweep.ts';
import { tempDir } from './support/fakes.ts';
import type { SharedHolderPlan } from './support/shared-holder.ts';
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

function sweepDeps(w: World, env: NodeJS.ProcessEnv = {}): SweepDeps {
  return {
    dir: w.dir,
    env: { PATH: process.env.PATH, HOME: tempDir('shared-home'), ...env },
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
      stop: `echo stop-begin >> '${log}'; ${untilGate(gate)}; rm -f '${f.up}'; echo stop-end >> '${log}'`,
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

test('a failed stop keeps it running with the problem, readable in the shared read, and the next sweep a sweep interval later stops it', async () => {
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
    assert.equal(SHARED_STOP_RETRY_MS, SWEEP_INTERVAL_MS, "a failed stop is due again at the MCP servers' next sweep");
    assert.equal(status.stopsAt, w.clock.now() + SWEEP_INTERVAL_MS);

    await w.clock.advance(SWEEP_INTERVAL_MS - 1);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false, 'passing commands start no sweeper for it');
    assert.deepEqual(await sweepStops(w), []);
    await w.clock.advance(1);
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

test('one sweep reaping three lanes whose teardowns need a shared service that does not start tries its start once, and a later pass tries again', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const attempts = path.join(f.dir, 'attempts');
    const broken = path.join(f.dir, 'broken');
    const tries = () => (fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').trim().split('\n').length : 0);
    const spec = f.spec({
      start: `echo attempt >> '${attempts}'; if [ -f '${broken}' ]; then echo "cannot reach the docker daemon" >&2; exit 3; fi; touch '${f.up}'`,
    });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const owner = w.procs.owner();
      const made = (await w.registry().claim(w.request(owner, w.folder(name), { device: null, services: [], projectRoot: repo })))
        .lane;
      const maker = w.registry();
      maker.startResource(refOf(made), {
        name: 'appdb',
        cwd: made.worktree,
        teardown: 'true',
        timeoutMs: 1000,
        env: {},
        cleared: [],
        needs: ['db'],
      });
      maker.finishResource(made.id, 'appdb', {});
      await startSharedForLane(deps(w), w.registry(), refOf(made), [spec]);
      w.procs.kill(owner.process?.pid ?? 0);
      ids.push(made.id);
    }
    ids.sort();
    await w.clock.advance(3 * MINUTE_MS);
    assert.deepEqual(
      (await runSweep(sweepDeps(w))).outcomes.map(o => [o.kind, o.lane]).sort(),
      ids.map(id => ['parked', id]),
    );
    fs.rmSync(f.up);
    fs.writeFileSync(broken, '');
    const before = tries();

    await w.clock.advance(RETURN_WINDOW_MS);
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.reaps.map(r => [r.kind, r.lane]).sort(),
      ids.map(id => ['ended', id]),
    );
    assert.equal(tries() - before, 1, 'the sweep started the failing shared service once for each lane it reaped');
    assert.deepEqual(
      report.reaps.map(r => (r.kind === 'ended' ? r.problems.map(p => p.replace(/: start exited 3: [^]*$/, '')) : [])),
      ids.map(() => ['resource appdb: teardown did not run, since shared service db did not start (attempt 1)']),
    );
    assert.deepEqual(
      w
        .registry()
        .pendingTeardowns()
        .map(t => [t.lane, t.attempts])
        .sort(),
      ids.map(id => [id, 1]),
    );

    fs.rmSync(broken);
    await w.clock.advance(TEARDOWN_RETRY_MS);
    const later = await tearDownEndedResources(deps(w), w.registry(), w.dir);
    assert.deepEqual(
      later.flatMap(t => t.problems),
      [],
    );
    assert.equal(tries() - before, 2);
    assert.deepEqual(w.registry().pendingTeardowns(), []);
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
    await w.clock.advance(sharedHoldMs(f.spec().timeoutMs) - 1);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false, 'its holder may still be stopping it');
    await w.clock.advance(1);
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

test('a failed start runs no stop: it throws naming the service and its output, leaves the service running with the problem, and the sweep stops it 5 minutes after its lane ends', async () => {
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
    assert.deepEqual([status?.state, status?.by, status?.problem?.startsWith('start exited 4: ')], ['running', null, true]);
    assert.deepEqual(f.lines(), ['start']);

    const never = f.spec({ start: `echo start >> '${log}'`, timeoutMs: 1000 });
    const waiting = startSharedForLane(deps(w), w.registry(), refOf(a), [never]);
    const timedOut = await settle(w, waiting).catch((e: unknown) => e);
    assert.ok(timedOut instanceof SharedServiceFailed);
    assert.match(timedOut.message, /^shared service db: ready did not pass within 1 s of its start: test -f /);
    assert.match(w.registry().sharedServices()[0]?.problem ?? '', /^ready did not pass within 1 s/);
    assert.deepEqual(f.lines(), ['start', 'start']);
    assert.deepEqual(await sweepStops(w), [], 'its lane is active');

    w.registry().release(refOf(a), a.owner);
    await w.clock.advance(SHARED_IDLE_MS - 1);
    assert.deepEqual(await sweepStops(w), []);
    await w.clock.advance(1);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    assert.deepEqual(f.lines(), ['start', 'start', 'stop']);
  } finally {
    w.close();
  }
});

test('a failed start by one lane never stops the service another active lane uses', async () => {
  const w = world();
  const f = fixture();
  const flaky = path.join(f.dir, 'flaky');
  try {
    const repo = w.folder('repo');
    const b = await lane(w, 'b', repo);
    const a = await lane(w, 'a', repo);
    const spec = f.spec({ ready: `test -f '${f.up}' && test ! -f '${flaky}'`, timeoutMs: 1000 });
    await startSharedForLane(deps(w), w.registry(), refOf(b), [spec]);
    fs.writeFileSync(flaky, '');
    const error = await settle(w, startSharedForLane(deps(w), w.registry(), refOf(a), [spec])).catch((e: unknown) => e);
    assert.ok(error instanceof SharedServiceFailed);
    assert.match(error.message, /ready did not pass within 1 s/);
    assert.deepEqual(f.lines(), ['start', 'start'], 'no stop ran');
    assert.ok(fs.existsSync(f.up), "lane b's server still runs");
    const status = w.registry().sharedServices()[0];
    assert.deepEqual([status?.state, status?.lanes], ['running', [a.id, b.id].sort()]);
    await w.clock.advance(SHARED_IDLE_MS);
    assert.deepEqual(await sweepStops(w), []);
    assert.ok(fs.existsSync(f.up));
  } finally {
    w.close();
  }
});

test('a registry write that fails after a successful start leaves the service running and runs no stop', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const failing = w.registry();
    failing.finishSharedStart = () => {
      throw new Error('the registry stayed busy');
    };
    const error = await startSharedForLane(deps(w), failing, refOf(a), [f.spec()]).catch((e: unknown) => e);
    assert.ok(error instanceof SharedServiceFailed);
    assert.match(error.message, /^shared service db: its start stopped partway: the registry stayed busy$/);
    assert.deepEqual(f.lines(), ['start']);
    assert.ok(fs.existsSync(f.up));
    const status = w.registry().sharedServices()[0];
    assert.deepEqual([status?.state, status?.by], ['running', null]);

    const b = await lane(w, 'b', repo);
    assert.deepEqual(
      (await startSharedForLane(deps(w), w.registry(), refOf(b), [f.spec()])).map(s => s.outcome),
      ['found-running'],
    );
    assert.deepEqual(f.lines(), ['start']);
    assert.equal(w.registry().sharedServices()[0]?.problem, null);
  } finally {
    w.close();
  }
});

test('a resource row held by a process that died does not keep it up: up killed mid-create, then the lane parks, and it stops 5 minutes after the park', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec({ timeoutMs: 1000 })]);
    const dying = w.procs.spawn();
    w.registry({ self: dying }).startResource(refOf(a), {
      name: 'appdb',
      cwd: a.worktree,
      teardown: 'true',
      timeoutMs: 1000,
      env: {},
      cleared: [],
      needs: ['db'],
    });
    w.procs.kill(dying.pid);
    await w.clock.advance(MINUTE_MS);
    assert.ok(parkNow(w.registry(), refOf(a)));
    const parkedAt = w.clock.now();
    const status = w.registry().sharedServices()[0];
    assert.deepEqual([status?.holding, status?.unneededSince], [[{ lane: a.id, resource: 'appdb' }], parkedAt]);

    await w.clock.advance(SHARED_IDLE_MS - 1000);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
    assert.deepEqual(await sweepStops(w), []);
    await w.clock.advance(1000);
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
    assert.deepEqual(f.lines(), ['start', 'stop']);
  } finally {
    w.close();
  }
});

test('a lane waits on a live start for as long as a start may take: its first ready run, its start and the ready window, plus margin', async () => {
  const w = world();
  const f = fixture();
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const b = await lane(w, 'b', repo);
    const timeoutMs = 1000;
    const holder = w.procs.spawn();
    const claimedAt = w.clock.now();
    const claim = w
      .registry({ self: holder })
      .beginSharedStart({ lane: refOf(a) }, 'db', { ...f.spec({ timeoutMs }), env: {} }, false);
    assert.equal(claim.kind, 'claimed');
    const state = { settled: false };
    const waiting = startSharedForLane(deps(w), w.registry(), refOf(b), [f.spec({ timeoutMs })]).finally(() => {
      state.settled = true;
    });
    waiting.catch(() => undefined);
    const firstReady = Math.min(timeoutMs, SHARED_READY_RUN_MAX_MS);
    const worstCase = claimedAt + firstReady + timeoutMs + timeoutMs + 1000;
    const limit = claimedAt + sharedHoldMs(timeoutMs);
    const end = Math.max(limit, worstCase);
    while (w.clock.now() < end) {
      await until(() => w.clock.sleeping > 0 || state.settled);
      assert.equal(state.settled, false, `still waiting at ${String(w.clock.now() - claimedAt)} ms`);
      await w.clock.advance(Math.min(SHARED_WAIT_POLL_MS, end - w.clock.now()));
    }
    await until(() => w.clock.sleeping > 0 || state.settled);
    assert.equal(state.settled, false, 'still waiting at the limit');
    await w.clock.advance(SHARED_WAIT_POLL_MS);
    const hung = await waiting.catch((e: unknown) => e);
    assert.ok(hung instanceof SharedServiceFailed);
    assert.match(
      hung.message,
      /^shared service db: pid \d+ has been starting it since .*, longer than its commands may take; kill \d+/,
    );
  } finally {
    w.close();
  }
});

test('a ready that passes only after the ready window has closed does not count', async () => {
  const w = world();
  const f = fixture();
  const log = path.join(f.dir, 'log');
  try {
    const a = await lane(w, 'a', w.folder('repo'));
    const starting = startSharedForLane(deps(w), w.registry(), refOf(a), [
      f.spec({ start: `echo start >> '${log}'`, timeoutMs: 100 }),
    ]);
    starting.catch(() => undefined);
    await until(() => w.clock.sleeping > 0);
    fs.writeFileSync(f.up, '');
    await w.clock.advance(500);
    const late = await starting.catch((e: unknown) => e);
    assert.ok(late instanceof SharedServiceFailed, 'no ready run is started once the window has closed');
    assert.match(late.message, /^shared service db: ready did not pass within 0\.1 s/);
  } finally {
    w.close();
  }
});

test('a ready run that answers after the ready window has closed does not count', async () => {
  const w = world();
  const f = fixture();
  const probes = path.join(f.dir, 'probes');
  try {
    const a = await lane(w, 'a', w.folder('repo'));
    const starting = startSharedForLane(deps(w), w.registry(), refOf(a), [
      f.spec({ ready: `echo probe >> '${probes}'; sleep 0.3; test -f '${f.up}'`, timeoutMs: 1000 }),
    ]);
    starting.catch(() => undefined);
    await until(() => fs.existsSync(probes) && fs.readFileSync(probes, 'utf8').split('\n').length > 2);
    await w.clock.advance(1001);
    const late = await starting.catch((e: unknown) => e);
    assert.ok(late instanceof SharedServiceFailed);
    assert.match(late.message, /^shared service db: ready did not pass within 1 s/);
  } finally {
    w.close();
  }
});

test('each ready run gets what is left of the ready window, not a full run of its own', async () => {
  const w = world();
  const f = fixture();
  const slow = path.join(f.dir, 'slow');
  try {
    const a = await lane(w, 'a', w.folder('repo'));
    const timeoutMs = 30_000;
    const starting = startSharedForLane(deps(w), w.registry(), refOf(a), [
      f.spec({ start: 'true', ready: `if [ -f '${slow}' ]; then sleep 10; echo slow; fi; exit 1`, timeoutMs }),
    ]);
    starting.catch(() => undefined);
    await until(() => w.clock.sleeping > 0);
    fs.writeFileSync(slow, '');
    const began = Date.now();
    await w.clock.advance(timeoutMs - 1000);
    const late = await settle(w, starting).catch((e: unknown) => e);
    assert.ok(late instanceof SharedServiceFailed);
    assert.ok(Date.now() - began < 5000, `its last ready run was cut at the window's end (${String(Date.now() - began)} ms)`);
  } finally {
    w.close();
  }
});

test('a start or stop whose log folder cannot be made lets go of the shared service', async () => {
  const w = world();
  const f = fixture();
  const blocker = path.join(w.dir, 'shared');
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(blocker, '');
    const error = await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()]).catch((e: unknown) => e);
    const failed = w.registry().sharedServices()[0];
    assert.deepEqual([failed?.state, failed?.by], ['running', null]);
    assert.ok(error instanceof SharedServiceFailed);
    assert.match(error.message, /^shared service db: its start stopped partway: .*(ENOTDIR|EEXIST)/);
    assert.deepEqual(f.lines(), []);

    fs.rmSync(blocker);
    assert.deepEqual(
      (await startSharedForLane(deps(w), w.registry(), refOf(a), [f.spec()])).map(s => s.outcome),
      ['started'],
      'the next start does not wait on the one that failed',
    );
    w.registry().release(refOf(a), a.owner);
    await w.clock.advance(SHARED_IDLE_MS);
    fs.rmSync(path.join(w.dir, 'shared'), { recursive: true });
    fs.writeFileSync(blocker, '');
    sawOwners(w.registry());
    const report = await runSweep(sweepDeps(w));
    assert.deepEqual(
      report.shared.map(s => s.outcome),
      ['failed'],
    );
    assert.match(report.shared[0]?.problem ?? '', /^stop could not run \(.*(ENOTDIR|EEXIST)/);
    const after = w.registry().sharedServices()[0];
    assert.deepEqual([after?.state, after?.by, after?.attempts], ['running', null, 1]);
    fs.rmSync(blocker);
    await w.clock.advance(SWEEP_INTERVAL_MS);
    assert.deepEqual(await sweepStops(w), ['db stopped']);
  } finally {
    w.close();
  }
});

test('a stop and ready run with the PATH and container variables the start had, over those of the process running them, and the rest of its environment is not recorded', async () => {
  const w = world();
  const f = fixture();
  const log = path.join(f.dir, 'log');
  try {
    const repo = w.folder('repo');
    const a = await lane(w, 'a', repo);
    const b = await lane(w, 'b', repo);
    const spec = f.spec({
      start: `echo "start $DOCKER_HOST $COMPOSE_PROJECT_NAME" >> '${log}'; touch '${f.up}'`,
      stop: `echo "stop \${DOCKER_HOST:-none} \${COMPOSE_PROJECT_NAME:-none} \${DOCKER_CONTEXT:-none}" >> '${log}'; rm -f '${f.up}'`,
      ready: `test "$DOCKER_HOST" = tcp://start-host && test -f '${f.up}'`,
    });
    const startEnv = {
      PATH: process.env.PATH,
      DOCKER_HOST: 'tcp://start-host',
      COMPOSE_PROJECT_NAME: 'lanes',
      API_TOKEN: 's3cret',
    };
    await startSharedForLane({ ...deps(w), env: startEnv }, w.registry(), refOf(a), [spec]);
    assert.deepEqual(w.registry().sharedServices()[0]?.commands.env, {
      PATH: process.env.PATH,
      DOCKER_HOST: 'tcp://start-host',
      COMPOSE_PROJECT_NAME: 'lanes',
    });
    assert.deepEqual(
      (
        await startSharedForLane(
          { ...deps(w), env: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://other' } },
          w.registry(),
          refOf(b),
          [spec],
        )
      ).map(s => s.outcome),
      ['kept'],
      "lane b's ready asks the start's daemon",
    );
    for (const l of [a, b]) w.registry().release(refOf(l), l.owner);
    await w.clock.advance(SHARED_IDLE_MS);
    sawOwners(w.registry());
    const report = await runSweep(sweepDeps(w, { DOCKER_HOST: 'tcp://sweep-host', DOCKER_CONTEXT: 'elsewhere' }));
    assert.deepEqual(
      report.shared.map(s => s.outcome),
      ['stopped'],
    );
    assert.deepEqual(f.lines(), ['start tcp://start-host lanes', 'stop tcp://start-host lanes none']);
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

const HOLDER = path.join(import.meta.dirname, 'support', 'shared-holder.ts');
const HOLDER_CONFIG: RegistryConfig = {
  poolSize: 0,
  emulatorPoolSize: 0,
  memoryBudgetMb: 0,
  parkMs: 30 * MINUTE_MS,
  blocks: { metro: { first: 48320, last: 48328 } },
};

interface RealWorld {
  root: string;
  stateDir: string;
  repo: string;
  log: string;
  up: string;
  gate: string;
  registry(clock?: typeof systemClock): Registry;
  lane(name: string): Promise<Lane>;
  lines(): string[];
  /** Runs a holder in a process of its own and kills it once `log` shows `marker` and its command is recorded; resolves to its pid. */
  killMidway(plan: SharedHolderPlan['action'], aheadMs: number, marker: string): Promise<number>;
  /** Ends the recorded command's process group and every process still running that names this folder, then removes it. */
  close(): Promise<void>;
}

/** Shell that waits until `gate` exists, giving up after about a minute. */
function untilGate(gate: string): string {
  return `n=0; while [ ! -f '${gate}' ] && [ "$n" -lt 3000 ]; do n=$((n + 1)); sleep 0.02; done`;
}

interface Running {
  pid: number;
  pgid: number;
}

/** The processes other than this one whose command line names `dir`. */
function processesNaming(dir: string): Running[] {
  const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.stderr);
  return ps.stdout.split('\n').flatMap(line => {
    const [, pid, pgid, command] = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line) ?? [];
    if (pid === undefined || pgid === undefined || command?.includes(dir) !== true) return [];
    return Number(pid) === process.pid ? [] : [{ pid: Number(pid), pgid: Number(pgid) }];
  });
}

/** Kills the process, with its process group when it leads one. */
function end(running: Running): void {
  try {
    process.kill(running.pid === running.pgid ? -running.pgid : running.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

const realRoots: string[] = [];

after(() => {
  for (const root of realRoots) assert.deepEqual(processesNaming(root), [], `a process of ${root} outlived its test`);
});

function recordedCommand(stateDir: string): number | null {
  const db = new DatabaseSync(databasePath(stateDir));
  try {
    const pid = db.prepare('SELECT command_pid FROM shared_services').get()?.command_pid;
    return typeof pid === 'number' ? pid : null;
  } finally {
    db.close();
  }
}

/** A registry on the real process table and clock, for holders that are real processes killed mid-command. */
function realWorld(): RealWorld {
  const root = tempDir('shared-real');
  realRoots.push(root);
  const stateDir = path.join(root, 'state');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  Store.open(stateDir, 5000).close();
  const self = identityOf(systemProcesses, process.pid);
  assert.ok(self);
  const owner: Owner = { kind: 'process', process: self, sessionId: null, threadId: null };
  const log = path.join(root, 'log');
  const open = (clock = systemClock) =>
    Registry.open({
      dir: stateDir,
      processes: systemProcesses,
      ports: { listening: () => Promise.resolve(new Set<number>()) },
      devices: {},
      config: HOLDER_CONFIG,
      pollMs: 20,
      lockWaitMs: 30_000,
      self,
      clock,
    });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return {
    root,
    stateDir,
    repo,
    log,
    up: path.join(root, 'up'),
    gate: path.join(root, 'gate'),
    registry: open,
    lane: async name => {
      const worktree = path.join(root, name);
      fs.mkdirSync(worktree, { recursive: true });
      const registry = open();
      try {
        return (await registry.claim({ owner, worktree, projectRoot: repo, services: [], device: null, waitMs: 0 })).lane;
      } finally {
        registry.close();
      }
    },
    lines,
    killMidway: async (action, aheadMs, marker) => {
      const plan: SharedHolderPlan = { stateDir, config: HOLDER_CONFIG, aheadMs, action };
      const child = spawn(process.execPath, [HOLDER, JSON.stringify(plan)], { stdio: ['ignore', 'ignore', 'inherit'] });
      const exited = new Promise(resolve => child.once('exit', resolve));
      try {
        await until(() => lines().includes(marker) && recordedCommand(stateDir) !== null);
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
      return child.pid ?? 0;
    },
    close: async () => {
      const command = recordedCommand(stateDir);
      if (command !== null) killGroup(command);
      for (const running of processesNaming(root)) end(running);
      await until(() => processesNaming(root).length === 0);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  return alive(-pgid);
}

function realDeps(said: string[]): SharedRunDeps {
  return { env: process.env, clock: systemClock, log: line => said.push(line) };
}

test("a sweeper killed mid-stop leaves its stop running: a lane's start waits for that stop to end, then starts the service", async () => {
  const r = realWorld();
  const registry = r.registry();
  try {
    const spec: SharedServiceConfig = {
      name: 'db',
      start: `echo start >> '${r.log}'; touch '${r.up}'`,
      stop: `echo stop-begin >> '${r.log}'; ${untilGate(r.gate)}; rm -f '${r.up}'; echo stop-end >> '${r.log}'`,
      ready: `test -f '${r.up}'`,
      cwd: r.repo,
      timeoutMs: 20_000,
    };
    const a = await r.lane('a');
    const said: string[] = [];
    await startSharedForLane(realDeps(said), registry, refOf(a), [spec]);
    assert.ok(parkNow(registry, refOf(a)));
    const sweeper = await r.killMidway({ kind: 'stop' }, SHARED_IDLE_MS + MINUTE_MS, 'stop-begin');
    assert.deepEqual([registry.sharedServices()[0]?.state, registry.sharedServices()[0]?.by], ['stopping', sweeper]);

    const b = await r.lane('b');
    const state = { settled: false };
    const starting = startSharedForLane(realDeps(said), registry, refOf(b), [spec]).finally(() => {
      state.settled = true;
    });
    await until(() => said.some(line => line.startsWith('waiting for the stop of shared service db that pid')));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(state.settled, false, 'the start waits while the stop runs on');
    assert.deepEqual(r.lines(), ['start', 'stop-begin']);
    fs.writeFileSync(r.gate, '');
    const started = await starting;
    assert.deepEqual(
      started.map(s => [s.outcome, s.took]),
      [['started', { state: 'stopping', pid: sweeper }]],
    );
    assert.deepEqual(r.lines(), ['start', 'stop-begin', 'stop-end', 'start']);
    assert.ok(fs.existsSync(r.up));
    assert.equal(registry.sharedServices()[0]?.state, 'running');
  } finally {
    registry.close();
    await r.close();
  }
});

test('the command of a holder that died is ended once it runs past its timeout, and the start is taken over', async () => {
  const r = realWorld();
  const registry = r.registry();
  try {
    const spec: SharedServiceConfig = {
      name: 'db',
      start: `echo start >> '${r.log}'; touch '${r.up}'`,
      stop: `echo stop-begin >> '${r.log}'; sleep 30; rm -f '${r.up}'; echo stop-end >> '${r.log}'`,
      ready: `test -f '${r.up}'`,
      cwd: r.repo,
      timeoutMs: 1000,
    };
    const a = await r.lane('a');
    const said: string[] = [];
    await startSharedForLane(realDeps(said), registry, refOf(a), [spec]);
    assert.ok(parkNow(registry, refOf(a)));
    const sweeper = await r.killMidway({ kind: 'stop' }, SHARED_IDLE_MS + MINUTE_MS, 'stop-begin');
    const command = recordedCommand(r.stateDir);
    assert.ok(command !== null && groupAlive(command), 'the stop recorded its shell, which runs on');

    const b = await r.lane('b');
    const began = Date.now();
    const started = await startSharedForLane(realDeps(said), registry, refOf(b), [spec]);
    assert.deepEqual(
      started.map(s => [s.outcome, s.took]),
      [['found-running', { state: 'stopping', pid: sweeper }]],
    );
    assert.ok(Date.now() - began < 10_000, `ended within its timeout plus slack (${String(Date.now() - began)} ms)`);
    assert.ok(
      said.some(line => line.startsWith(`ending the stop of shared service db that pid ${String(sweeper)} left running`)),
    );
    assert.equal(groupAlive(command), false, 'its whole process group was ended');
    assert.deepEqual(r.lines(), ['start', 'stop-begin']);
  } finally {
    registry.close();
    await r.close();
  }
});

test('a lane start killed mid-start leaves its start running: the sweep stops the service only once that start has ended', async () => {
  const r = realWorld();
  const registry = r.registry();
  const ahead = { now: () => Date.now() + SHARED_IDLE_MS + MINUTE_MS, sleep: (ms: number) => systemClock.sleep(ms) };
  const sweeping = r.registry(ahead);
  try {
    const spec: SharedServiceConfig = {
      name: 'db',
      start: `echo start-begin >> '${r.log}'; ${untilGate(r.gate)}; touch '${r.up}'; echo start-end >> '${r.log}'`,
      stop: `echo stop >> '${r.log}'; rm -f '${r.up}'`,
      ready: `test -f '${r.up}'`,
      cwd: r.repo,
      timeoutMs: 20_000,
    };
    const a = await r.lane('a');
    const starter = await r.killMidway({ kind: 'start', lane: refOf(a), spec }, 0, 'start-begin');
    assert.ok(parkNow(registry, refOf(a)));
    const sweep = () => stopUnneededShared({ env: process.env, clock: ahead }, sweeping);
    assert.deepEqual(await sweep(), [], 'the start that pid left running still runs');
    const left = sweeping.beginSharedStop({ repository: r.repo, name: 'db' });
    assert.match(
      left.kind === 'left' ? left.reason : left.kind,
      new RegExp(`^the start that pid ${String(starter)} left running`),
    );

    const command = recordedCommand(r.stateDir);
    assert.ok(command !== null);
    fs.writeFileSync(r.gate, '');
    await until(() => r.lines().includes('start-end') && !groupAlive(command));
    assert.deepEqual(
      (await sweep()).map(s => [s.outcome, s.took?.state]),
      [['stopped', 'starting']],
    );
    assert.deepEqual(r.lines(), ['start-begin', 'start-end', 'stop']);
  } finally {
    registry.close();
    sweeping.close();
    await r.close();
  }
});

test('a holder killed once its command is launched but before the registry records it runs no command, and the next lane starts the service alone', async () => {
  const r = realWorld();
  const registry = r.registry();
  try {
    const spec: SharedServiceConfig = {
      name: 'db',
      start: `echo start >> '${r.log}'; sleep 0.3; touch '${r.up}'`,
      stop: `echo stop >> '${r.log}'; rm -f '${r.up}'`,
      ready: `test -f '${r.up}'`,
      cwd: r.repo,
      timeoutMs: 20_000,
    };
    const a = await r.lane('a');
    const plan: SharedHolderPlan = {
      stateDir: r.stateDir,
      config: HOLDER_CONFIG,
      aheadMs: 0,
      action: { kind: 'start', lane: refOf(a), spec },
      dieMidCommand: 'launched',
    };
    const holder = spawn(process.execPath, [HOLDER, JSON.stringify(plan)], { stdio: ['ignore', 'ignore', 'inherit'] });
    const signal = await new Promise(resolve => {
      holder.once('exit', (_code, killedBy) => {
        resolve(killedBy);
      });
    });
    assert.equal(signal, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(r.lines(), [], 'its start never ran');
    assert.equal(recordedCommand(r.stateDir), null);

    const b = await r.lane('b');
    const started = await startSharedForLane(realDeps([]), registry, refOf(b), [spec]);
    assert.deepEqual(
      started.map(s => [s.outcome, s.took]),
      [['started', { state: 'starting', pid: holder.pid }]],
    );
    assert.deepEqual(r.lines(), ['start']);
    assert.equal(registry.sharedServices()[0]?.state, 'running');
  } finally {
    registry.close();
    await r.close();
  }
});

test('a start whose holder died and whose shell then exited has done its job: the next lane keeps the server it left and runs no second start', async () => {
  const r = realWorld();
  const registry = r.registry();
  const serverFile = path.join(r.root, 'server.pid');
  const servers = () => (fs.existsSync(serverFile) ? fs.readFileSync(serverFile, 'utf8').trim().split('\n').map(Number) : []);
  try {
    const spec: SharedServiceConfig = {
      name: 'db',
      start: `sleep 600 & echo $! >> '${serverFile}'; echo start >> '${r.log}'; ${untilGate(r.gate)}`,
      stop: `echo stop >> '${r.log}'; kill $(cat '${serverFile}')`,
      ready: `kill -0 $(tail -n 1 '${serverFile}')`,
      cwd: r.repo,
      timeoutMs: 1000,
    };
    const a = await r.lane('a');
    const starter = await r.killMidway({ kind: 'start', lane: refOf(a), spec }, 0, 'start');
    const shell = recordedCommand(r.stateDir);
    assert.ok(shell !== null);
    const [server] = servers();
    assert.ok(server !== undefined);
    fs.writeFileSync(r.gate, '');
    await until(() => !alive(shell));
    assert.ok(alive(server) && groupAlive(shell), "the server runs on in its shell's process group");

    const b = await r.lane('b');
    const said: string[] = [];
    const started = await startSharedForLane(realDeps(said), registry, refOf(b), [spec]);
    assert.deepEqual(
      started.map(s => [s.outcome, s.took]),
      [['found-running', { state: 'starting', pid: starter }]],
    );
    assert.deepEqual(
      said.filter(line => line.startsWith('ending ') || line.startsWith('waiting ')),
      [],
    );
    assert.ok(alive(server), 'the server the start left is never ended by a takeover');
    assert.deepEqual(r.lines(), ['start']);
    assert.equal(registry.sharedServices()[0]?.state, 'running');
  } finally {
    registry.close();
    for (const pid of servers()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await r.close();
  }
});

test("a dead holder's command whose shell runs past its timeout and can't be ended is tried until the hold limit, then the start fails naming that shell", async () => {
  const r = realWorld();
  const registry = r.registry();
  try {
    const spec: SharedServiceConfig = {
      name: 'db',
      start: `echo start-begin >> '${r.log}'; sleep 30`,
      stop: `echo stop >> '${r.log}'; rm -f '${r.up}'`,
      ready: `test -f '${r.up}'`,
      cwd: r.repo,
      timeoutMs: 1000,
    };
    const a = await r.lane('a');
    const starter = await r.killMidway({ kind: 'start', lane: refOf(a), spec }, 0, 'start-begin');
    const shell = recordedCommand(r.stateDir);
    assert.ok(shell !== null);
    await new Promise(resolve => setTimeout(resolve, spec.timeoutMs + 2200));

    const b = await r.lane('b');
    const signalled: number[] = [];
    const said: string[] = [];
    const triesBeforeTheLimit = 3;
    const pastHold = sharedHoldMs(spec.timeoutMs) + MINUTE_MS;
    const eperm: SharedRunDeps = {
      env: process.env,
      clock: {
        now: () => Date.now() + (signalled.length >= triesBeforeTheLimit ? pastHold : 0),
        sleep: ms => systemClock.sleep(ms),
      },
      log: line => said.push(line),
      signal: pid => {
        signalled.push(pid);
        throw Object.assign(new Error(`kill ${String(pid)}: operation not permitted`), { code: 'EPERM' });
      },
    };
    const failed = await startSharedForLane(eperm, registry, refOf(b), [spec]).catch((e: unknown) => e);
    assert.ok(failed instanceof SharedServiceFailed, String(failed));
    assert.equal(
      failed.message,
      `shared service db: the start that pid ${String(starter)} left running when it died still runs as pid ${String(shell)}, past its 1 s timeout, and could not be ended; kill ${String(shell)} as the user that owns that process, then try again`,
    );
    assert.deepEqual(
      signalled,
      Array.from({ length: triesBeforeTheLimit }, () => -shell),
    );
    assert.equal(said.filter(line => line.startsWith('ending ')).length, 1, 'it says once that it ends the command');
    assert.ok(alive(shell));
    assert.deepEqual(r.lines(), ['start-begin']);
    assert.equal(registry.sharedServices()[0]?.state, 'starting');
  } finally {
    registry.close();
    await r.close();
  }
});

test('closing a real world ends each process of its own still running: one polling a gate that never comes, and one past its gate', async () => {
  const r = realWorld();
  const shell = (command: string) => {
    const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
    const state = { exited: false };
    child.once('exit', () => {
      state.exited = true;
    });
    return { pgid: child.pid ?? 0, exited: () => state.exited };
  };
  const polling = shell(untilGate(path.join(r.root, 'never')));
  const past = shell(`${untilGate(r.gate)}; echo past >> '${r.log}'; sleep 30`);
  fs.writeFileSync(r.gate, '');
  await until(() => r.lines().includes('past'));

  await r.close();
  await until(() => polling.exited() && past.exited(), 5000);
  await until(() => !groupAlive(polling.pgid) && !groupAlive(past.pgid), 5000);
  assert.equal(fs.existsSync(r.root), false);
});
