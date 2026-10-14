import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { resolveCallerLane } from '../../src/driver/caller.ts';
import { callEngine, stopLaneEngine, stopEngine } from '../../src/driver/client.ts';
import { DEFAULT_IDLE_MS, IdleWatch, readDriverSettings } from '../../src/driver/idle.ts';
import { maestroRunsDir } from '../../src/driver/maestro-runs.ts';
import { enginePaths } from '../../src/driver/paths.ts';
import { systemProcesses } from '../../src/processes.ts';
import { NotClaimed, UsageError } from '../../src/registry/refusal.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { LANE_FILES_KEEP_MS, pruneEndedLaneFiles } from '../../src/up/lane-files.ts';
import { alive, driverWorld, sleeper, until, type DriverWorld } from '../support/driver-world.ts';
import { FakeClock, FakeDevices, tempDir } from '../support/fakes.ts';

async function withWorld(options: Parameters<typeof driverWorld>[0], body: (world: DriverWorld) => Promise<void>): Promise<void> {
  const world = await driverWorld(options);
  try {
    await body(world);
  } finally {
    await world.close();
  }
}

const childPids = (world: DriverWorld, kind: 'xcodebuild' | 'runner') =>
  world
    .events()
    .filter(event => event.event === kind)
    .map(event => event.child as number);

const TAP = 'appId: com.example.expoapp\n---\n- tapOn:\n    id: home-increment\n';

class WatchedDevices extends FakeDevices {
  shutdowns: { id: string; engineAlive: boolean }[] = [];
  enginePid = 0;

  override shutdown(id: string): void {
    this.shutdowns.push({ id, engineAlive: this.enginePid !== 0 && alive(this.enginePid) });
    super.shutdown(id);
  }
}

test('release stops the engine before the simulator shuts down, and a look loop meanwhile ends with the lane-gone answer', () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    const devices = new WatchedDevices(world.devices.dir);
    devices.enginePid = first.pid;
    const env = { AGENTLANE_STATE_DIR: world.stateDir, PATH: process.env.PATH, HOME: process.env.HOME };

    const answers: string[] = [];
    const loop = (async () => {
      for (;;) {
        try {
          resolveCallerLane({ env, cwd: world.worktree, processes: systemProcesses, owner: world.lane.owner });
          const response = await callEngine(world.target(), { op: 'look', args: {} });
          answers.push(response.ok ? 'ok' : `failed: ${response.error ?? ''}`);
        } catch (error) {
          answers.push(error instanceof NotClaimed ? 'gone' : `threw: ${(error as Error).message}`);
          return;
        }
      }
    })();
    await until(() => answers.length >= 2, 5000, 'the loop to get going');

    const stderr: string[] = [];
    const code = await runRegistryCommand('release', ['--worktree', world.worktree], {
      env: { ...env, AGENTLANE_OWNER_PID: String(world.ownerIdentity.pid) },
      cwd: world.worktree,
      stdout: () => undefined,
      stderr: text => stderr.push(text),
      processes: systemProcesses,
      ports: tcpProbe,
      devices: { ios: devices },
    });
    assert.equal(code, 0, stderr.join(''));
    await loop;

    assert.equal(answers.at(-1), 'gone');
    assert.deepEqual(
      answers.filter(a => a !== 'ok' && a !== 'gone'),
      [],
      'no look failed while the lane was being released',
    );
    assert.equal(devices.shutdowns.length, 1);
    assert.equal(devices.shutdowns[0]?.engineAlive, false, 'the engine was gone before the simulator shut down');
    assert.match(stderr.join(''), /stopped the driver/);
    assert.equal(world.spawns().length, 1, 'no engine or Maestro started again during the release');
  }));

test('while a release runs, a call gets the lane-gone answer and starts no engine', () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    assert.equal(await stopLaneEngine(world.stateDir, world.lane.id, { processes: systemProcesses, ending: true }), true);
    assert.equal(alive(first.pid), false);
    await assert.rejects(callEngine(world.target(), { op: 'look', args: {} }), (error: unknown) => {
      assert.ok(error instanceof NotClaimed);
      assert.match(error.message, /has ended: it is being released \(by pid \d+\)/);
      return true;
    });
    assert.equal(world.spawns().length, 1);
  }));

async function holdConnection(world: DriverWorld): Promise<net.Socket> {
  const socket = net.connect(enginePaths(world.stateDir, world.lane.id).socket);
  socket.on('error', () => undefined);
  await new Promise(resolve => socket.once('connect', resolve));
  return socket;
}

test('stopping a lane engine resolves only once the engine has exited, even while a connection to it stays open', () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    const held = await holdConnection(world);
    try {
      assert.equal(await stopLaneEngine(world.stateDir, world.lane.id, { processes: systemProcesses, ending: true }), true);
      assert.equal(alive(first.pid), false);
    } finally {
      held.destroy();
    }
  }));

test('stopping an engine with its token resolves only once the engine has exited, even while a connection to it stays open', () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    const held = await holdConnection(world);
    try {
      assert.equal(await stopEngine(world.stateDir, world.lane, 8000), true);
      assert.equal(alive(first.pid), false);
    } finally {
      held.destroy();
    }
  }));

test('a release marker left by a process that has exited holds nothing up', () =>
  withWorld({}, async world => {
    const paths = enginePaths(world.stateDir, world.lane.id);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const gone = sleeper();
    const start = systemProcesses.startTimes([gone.pid ?? 0])?.get(gone.pid ?? 0);
    fs.writeFileSync(paths.releasing, JSON.stringify({ pid: gone.pid, start }));
    gone.kill('SIGKILL');
    await until(() => !alive(gone.pid ?? 0), 3000, 'the marker holder to exit');
    const response = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(response.ok, true, response.error);
  }));

test('an engine with no tool call for its idle time stops Maestro, xcodebuild and the runner, keeps the lane, and the next call starts it cold', () =>
  withWorld({ tuning: { idleMs: 600 } }, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.coldStart?.idleStop, undefined);
    const [maestro] = world.spawns();
    const [xcodebuild] = childPids(world, 'xcodebuild');
    const [runner] = childPids(world, 'runner');
    assert.ok(maestro && xcodebuild && runner);
    await until(
      () => ![first.pid, maestro.pid, xcodebuild, runner].some(alive),
      8000,
      'the idle engine, its Maestro, xcodebuild and runner to stop',
    );
    const paths = enginePaths(world.stateDir, world.lane.id);
    assert.match(fs.readFileSync(paths.log, 'utf8'), /stopping: no tool call for 0\.6 s; the lane stays/);
    assert.equal(world.registry().find(world.lane.owner, world.worktree)?.id, world.lane.id, 'the lane stays');

    const next = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(next.ok, true, next.error);
    assert.notEqual(next.pid, first.pid);
    assert.ok(next.coldStart?.idleStop, 'the response says the engine had stopped for lack of calls');
    assert.match(
      next.text ?? '',
      /^The driver had stopped after 0\.6 s without a call; this call started it again \([\d.]+ s\)\.\n/,
    );
    const again = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(again.coldStart, undefined);
    assert.doesNotMatch(again.text ?? '', /had stopped/);
  }));

test('calls inside the idle time keep the engine running', () =>
  withWorld({ tuning: { idleMs: 700 } }, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    const started = Date.now();
    while (Date.now() - started < 2000) {
      const response = await callEngine(world.target(), { op: 'look', args: { interactiveOnly: true } });
      assert.equal(response.pid, first.pid);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(world.spawns().length, 1);
  }));

test('the idle clock counts from the end of the last tool call, and never runs out during one', async () => {
  const clock = new FakeClock();
  const watch = new IdleWatch(30 * 60_000, clock);
  assert.equal(watch.remainingMs(), 30 * 60_000);
  await clock.advance(29 * 60_000);
  assert.equal(watch.remainingMs(), 60_000);
  watch.begin();
  await clock.advance(45 * 60_000);
  assert.equal(watch.remainingMs(), 30 * 60_000, 'a call in progress is never idle');
  watch.end();
  await clock.advance(30 * 60_000 - 1);
  assert.equal(watch.remainingMs(), 1);
  await clock.advance(1);
  assert.equal(watch.remainingMs(), 0);
  assert.equal(new IdleWatch(0, clock).remainingMs(), undefined, '0 never stops the engine');
});

test("the idle time is a per-Mac setting in the state dir's driver.json, 30 minutes when unset", () => {
  const dir = tempDir('driver-settings');
  assert.equal(readDriverSettings(dir).idleMs, DEFAULT_IDLE_MS);
  assert.equal(DEFAULT_IDLE_MS, 30 * 60_000);
  fs.writeFileSync(path.join(dir, 'driver.json'), '{"idleMinutes": 1}');
  assert.equal(readDriverSettings(dir).idleMs, 60_000);
  fs.writeFileSync(path.join(dir, 'driver.json'), '{"idleMinutes": 0}');
  assert.equal(readDriverSettings(dir).idleMs, 0);
  for (const bad of ['{"idleMinutes": -1}', '{"idleMinutes": "30"}', '{"idle": 30}', '[1]', 'not json']) {
    fs.writeFileSync(path.join(dir, 'driver.json'), bad);
    assert.throws(() => readDriverSettings(dir), UsageError, bad);
  }
});

test('the labels the diff learned tick survive an engine restart, so the ticker is still not a change', () =>
  withWorld({ start: 'example-home', tuning: { idleSampleMs: 50 } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const paths = enginePaths(world.stateDir, world.lane.id);
    await until(() => fs.existsSync(paths.volatile), 3000, 'the idle read to learn the ticker');
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.volatile, 'utf8')), { version: 1, anchors: ['text|#home-ticker'] });
    assert.equal(await stopEngine(world.stateDir, world.lane, 8000), true);

    const response = await callEngine(world.target(), { op: 'run', args: { yaml: TAP } });
    assert.equal(response.ok, true, response.text);
    assert.equal(world.spawns().length, 2, 'the run went to a new engine and a new Maestro');
    assert.doesNotMatch(response.text ?? '', /home-ticker/);
    assert.match(
      response.text ?? '',
      /\nScreen changed: 1 changed\.\n~ \[text\] id=home-tap-count "Taps: 0" → \[text\] id=home-tap-count "Taps: 1"$/,
    );
  }));

test('what the diff learned goes with the lane', () =>
  withWorld({ start: 'example-home', tuning: { idleSampleMs: 50 } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const paths = enginePaths(world.stateDir, world.lane.id);
    await until(() => fs.existsSync(paths.volatile), 3000, 'the idle read to learn the ticker');
    await stopLaneEngine(world.stateDir, world.lane.id, { processes: systemProcesses, ending: true });
    assert.equal(fs.existsSync(paths.volatile), false);
    assert.equal(fs.existsSync(paths.steps) || fs.existsSync(paths.log), true, 'the log stays until it is pruned');
  }));

test("the files of ended lanes are pruned with the registry's 7-day history, with the links to their Maestro runs; live lanes and recent ones stay", async () => {
  const clock = new FakeClock();
  const state = tempDir('prune');
  const driver = path.join(state, 'driver');
  fs.mkdirSync(driver, { recursive: true });
  const write = (name: string, ageMs: number) => {
    const file = path.join(state, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    const at = new Date(clock.now() - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };
  const day = 24 * 3_600_000;
  const old = ['driver/aaaaaaaa.log', 'driver/aaaaaaaa.steps.jsonl', 'driver/aaaaaaaa.volatile.json', 'lanes/aaaaaaaa/up.json'];
  for (const name of old) write(name, 8 * day);
  fs.mkdirSync(path.join(driver, 'aaaaaaaa'));
  fs.utimesSync(path.join(driver, 'aaaaaaaa'), new Date(clock.now() - 8 * day), new Date(clock.now() - 8 * day));
  fs.utimesSync(path.join(state, 'lanes', 'aaaaaaaa'), new Date(clock.now() - 8 * day), new Date(clock.now() - 8 * day));
  write('driver/bbbbbbbb.log', 8 * day);
  write('driver/bbbbbbbb.steps.jsonl', 2 * day);
  write('driver/cccccccc.log', 30 * day);
  const holder = sleeper();
  try {
    await until(() => alive(holder.pid ?? 0), 3000, 'the lock holder');
    write('driver/dddddddd.log', 9 * day);
    fs.writeFileSync(path.join(driver, 'dddddddd.lock'), JSON.stringify({ pid: holder.pid, start: 'x' }));
    fs.utimesSync(path.join(driver, 'dddddddd.lock'), new Date(clock.now() - 9 * day), new Date(clock.now() - 9 * day));
    write('driver/registry-notes.txt', 30 * day);

    const env = { XDG_STATE_HOME: path.join(state, 'xdg') };
    const runs = maestroRunsDir(env);
    fs.mkdirSync(runs, { recursive: true });
    const run = (lane: string) => path.join(state, 'lanes', lane, 'evidence', 'x-maestro-test-1', '.maestro', 'tests', 'r');
    fs.mkdirSync(run('cccccccc'), { recursive: true });
    fs.symlinkSync(run('aaaaaaaa'), path.join(runs, 'pruned'));
    fs.symlinkSync(run('cccccccc'), path.join(runs, 'live'));
    fs.symlinkSync(path.join(state, 'elsewhere'), path.join(runs, 'not-ours'));
    fs.mkdirSync(path.join(runs, 'maestro-own'));

    const removed = pruneEndedLaneFiles(state, new Set(['cccccccc']), clock.now(), env);
    assert.deepEqual(removed, ['aaaaaaaa']);
    assert.deepEqual(fs.readdirSync(runs).sort(), ['live', 'maestro-own', 'not-ours']);
    assert.deepEqual(fs.readdirSync(driver).sort(), [
      'bbbbbbbb.log',
      'bbbbbbbb.steps.jsonl',
      'cccccccc.log',
      'dddddddd.lock',
      'dddddddd.log',
      'registry-notes.txt',
    ]);
    assert.equal(fs.existsSync(path.join(state, 'lanes', 'aaaaaaaa')), false);

    await clock.advance(LANE_FILES_KEEP_MS);
    assert.deepEqual(pruneEndedLaneFiles(state, new Set(['cccccccc']), clock.now(), env), ['bbbbbbbb']);
  } finally {
    holder.kill('SIGKILL');
  }
});
