import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Ran } from '../src/driver/exec.ts';
import type { EvidenceSystem } from '../src/evidence/device.ts';
import { laneEvidence } from '../src/evidence/evidence.ts';
import { readInProgress, writeInProgress } from '../src/evidence/files.ts';
import { runDriverCommand } from '../src/driver-cli.ts';
import type { ProcessTable } from '../src/processes.ts';
import { identityOf, systemProcesses } from '../src/processes.ts';
import { MINUTE_MS } from '../src/registry/config.ts';
import type { Owner } from '../src/registry/owner.ts';
import { ownerKey } from '../src/registry/owner.ts';
import { OWNER_CHECK_MS, REAP_RETRY_MS, RETURN_WINDOW_MS } from '../src/registry/owner-checks.ts';
import { databasePath } from '../src/registry/paths.ts';
import type { Registry } from '../src/registry/registry.ts';
import type { Lane, LaneStatus } from '../src/registry/types.ts';
import { runRegistryCommand, type CliDeps } from '../src/registry-cli.ts';
import { realServiceSystem } from '../src/services/system.ts';
import { resolveCallerLane } from '../src/driver/caller.ts';
import { runHookCommand, SESSION_END_OWNER_ENV } from '../src/plugin/hook-cli.ts';
import { laneDir, writeUpRecord } from '../src/up/lane-files.ts';
import { passBy, runSweep, SWEEP_INTERVAL_MS, sweepDue, sweepTick, type SweepDeps, type SweepReport } from '../src/up/sweep.ts';
import { enterLane } from '../src/up/wake.ts';
import { FakeAdb } from './devices/fake-adb.ts';
import { FakeSim } from './devices/fake.ts';
import { tempDir } from './support/fakes.ts';
import type { World } from './support/world.ts';
import { world } from './support/world.ts';

const PARK_MS = 30 * MINUTE_MS;
const BUNDLE = 'com.example.fake';

function refOf(lane: Lane) {
  return { id: lane.id, token: lane.token };
}

function sweepDeps(w: World, over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    dir: w.dir,
    env: { PATH: process.env.PATH, HOME: tempDir('reap-home') },
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

function claude(w: World, session: string | null): Owner {
  return { kind: 'claude', process: w.procs.spawn('claude'), sessionId: session, threadId: null };
}

function statusOf(w: World, id: string): LaneStatus | undefined {
  return w
    .registry()
    .status()
    .lanes.find(c => c.id === id);
}

function kill(w: World, owner: Owner): void {
  w.procs.kill(owner.process?.pid ?? 0);
}

function service(): ChildProcess {
  return spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return identityOf(systemProcesses, pid) !== undefined;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function recordService(registry: Registry, lane: Lane, child: ChildProcess, name = 'api'): void {
  const identity = identityOf(systemProcesses, child.pid ?? 0);
  assert.ok(identity, 'the service started');
  registry.recordProcess(refOf(lane), { service: name, pid: identity.pid, start: identity.start, cwd: null });
}

function makeResource(registry: Registry, lane: Lane, file: string): void {
  registry.startResource(refOf(lane), {
    name: 'db',
    cwd: lane.worktree,
    teardown: `echo "dropped $DATABASE_URL" >> '${file}'`,
    timeoutMs: 10_000,
    env: {},
    cleared: ['DATABASE_URL'],
  });
  registry.finishResource(lane.id, 'db', { DATABASE_URL: `postgres://db/${lane.id}` });
}

function lines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
}

function history(w: World): { claim_id: string; reason: string }[] {
  const db = new DatabaseSync(databasePath(w.dir), { readOnly: true });
  try {
    return db
      .prepare('SELECT claim_id, reason FROM history ORDER BY seq')
      .all()
      .map(r => ({ claim_id: String(r.claim_id), reason: String(r.reason) }));
  } finally {
    db.close();
  }
}

const adopted = new WeakSet<World>();

function cliDeps(w: World, out: string[], over: Partial<CliDeps> = {}): CliDeps {
  if (!adopted.has(w)) {
    w.procs.recycle(process.pid);
    adopted.add(w);
  }
  return {
    env: { AGENTLANE_STATE_DIR: w.dir, PATH: process.env.PATH, HOME: tempDir('reap-cli-home') },
    cwd: w.dir,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: w.procs,
    ports: w.probe,
    devices: { ios: w.devices, android: w.emulators },
    clock: w.clock,
    system: realServiceSystem,
    ...over,
  };
}

test("with a dead owner and another session's MCP server running, the lane's servers and device are gone within one sweep interval", async () => {
  const w = world();
  const api = service();
  try {
    const doomed = w.procs.owner();
    const a = await w.registry().claim(w.request(doomed, w.folder('a'), { boot: true }));
    recordService(w.registry(), a.lane, api);
    const mcpOwner = claude(w, 'mcp-session');
    const b = await w.registry().claim(w.request(mcpOwner, w.folder('b'), { boot: true }));
    kill(w, doomed);

    const sweeps: Promise<SweepReport>[] = [];
    const input = new PassThrough();
    const serving = runDriverCommand('mcp', [], {
      env: { AGENTLANE_STATE_DIR: w.dir, PATH: process.env.PATH },
      cwd: w.folder('b'),
      stdout: () => undefined,
      stderr: () => undefined,
      stdin: input,
      output: new PassThrough(),
      processes: w.procs,
      sweep: {
        run: () => {
          sweepTick({ dir: w.dir, clock: w.clock, processes: w.procs }, {}, () => sweeps.push(runSweep(sweepDeps(w))));
        },
        wait: ms => w.clock.sleep(ms),
      },
    });

    await w.clock.advance(SWEEP_INTERVAL_MS - 1);
    assert.equal(sweeps.length, 0, 'no sweep before the interval');
    assert.equal(running(api.pid ?? 0), true);
    await w.clock.advance(1);
    assert.equal(sweeps.length, 1, 'the MCP server swept once the interval passed');
    const report = await sweeps[0];
    assert.deepEqual(report?.found, [{ lane: a.lane.id, state: 'dead' }]);

    await until(() => !running(api.pid ?? 0));
    const lane = statusOf(w, a.lane.id);
    assert.equal(lane?.device, null, 'the device went back to the pool');
    assert.deepEqual(lane.processes, []);
    assert.equal(lane.park?.state, 'parked');
    assert.equal(w.devices.all().find(d => d.id === a.lane.device?.id)?.booted, false);
    assert.equal(statusOf(w, b.lane.id)?.device?.id, b.lane.device?.id, "the MCP server's own session keeps its lane");
    assert.equal(statusOf(w, b.lane.id)?.park, null);

    input.end();
    assert.equal(await serving, 0);
  } finally {
    api.kill('SIGKILL');
    w.close();
  }
});

/** xcrun as device evidence runs it: a recorder that is running until it is interrupted. */
class Recorders implements EvidenceSystem {
  readonly running = new Map<number, string>();

  run(): Promise<Ran> {
    return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', error: undefined });
  }

  start(): number | undefined {
    return undefined;
  }

  commandOf(pid: number): string | undefined {
    return this.running.get(pid);
  }

  signal(pid: number): void {
    this.running.delete(pid);
  }
}

function project(w: World, trace: string): { folder: string; config: string } {
  const folder = w.folder('project');
  const config = path.join(folder, 'agentlane.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      app: {
        platform: 'ios',
        bundleId: BUNDLE,
        scheme: 'fakeapp',
        launch: 'bundler-pin',
        output: 'build/Fake.app',
        android: { output: 'build/app.apk' },
      },
      services: {
        metro: { type: 'metro', start: 'exec node metro.mjs', ready: { kind: 'http', path: '/status' } },
        api: {
          type: 'api',
          start: 'exec node api.mjs',
          ready: { kind: 'http', path: '/health' },
          dial: { argument: '-apiBaseUrl' },
        },
      },
      hooks: { build: 'true', teardown: `echo "teardown $AGENTLANE_LANE" >> '${trace}'` },
    }),
  );
  return { folder, config };
}

test('once ended, a lane leaves no recording, bundler pin, dial default, adb reverse rule or un-run teardown hook, whether it was parked before its owner died or after', async () => {
  const w = world();
  const trace = path.join(tempDir('reap-trace'), 'trace.log');
  const sim = new FakeSim();
  const adbs = new Map<string, FakeAdb>();
  const adb = (serial: string) => {
    const known = adbs.get(serial) ?? new FakeAdb(serial);
    adbs.set(serial, known);
    return known;
  };
  const recorders = new Recorders();
  try {
    const { folder, config } = project(w, trace);
    const iosOwner = w.procs.owner();
    const androidOwner = w.procs.owner();
    const ios = await w.registry().claim(w.request(iosOwner, folder, { boot: true }));
    const android = await w
      .registry()
      .claim(w.request(androidOwner, w.folder('android'), { device: { platform: 'android' }, boot: true }));
    const udid = ios.lane.device?.id ?? '';
    const serial = android.lane.device?.serial ?? '';
    const metro = ios.lane.ports.find(p => p.service === 'metro')?.port ?? 0;
    const apiPort = ios.lane.ports.find(p => p.service === 'api')?.port ?? 0;
    sim.addDevice(udid, 'Booted', ios.lane.device?.name);
    const app = sim.install(BUNDLE, udid);
    app.defaults.set('RCT_jsLocation', `localhost:${String(metro)}`);
    app.defaults.set('apiBaseUrl', `http://localhost:${String(apiPort)}`);
    for (const lane of [ios.lane, android.lane]) {
      writeUpRecord(laneDir(w.dir, lane.id), {
        version: 1,
        lane: lane.id,
        config,
        platform: lane === ios.lane ? 'ios' : 'android',
        bundleId: BUNDLE,
        launch: 'bundler-pin',
        pinned: lane === ios.lane,
        ...(lane === android.lane ? { reversed: android.lane.ports.filter(p => p.service !== 'emulator').map(p => p.port) } : {}),
        updatedAt: w.clock.now(),
      });
    }
    for (const port of android.lane.ports.filter(p => p.service !== 'emulator'))
      adb(serial).reverseRules.set(port.port, port.port);
    recorders.running.set(8_000_001, 'xcrun simctl io recordVideo');
    writeInProgress(laneEvidence(w.dir, ios.lane.id), 'video', {
      version: 1,
      target: 'device',
      startedAt: w.clock.now(),
      file: path.join(laneEvidence(w.dir, ios.lane.id), 'video.mp4'),
      pid: 8_000_001,
      command: 'xcrun simctl io recordVideo',
      platform: 'ios',
      device: udid,
    });
    const deps = sweepDeps(w, { sim, adb, evidence: recorders });

    await w.clock.advance(PARK_MS);
    kill(w, iosOwner);
    const first = await runSweep(deps);
    assert.deepEqual(first.found, [{ lane: ios.lane.id, state: 'dead' }]);
    assert.deepEqual(
      first.outcomes.map(o => [o.kind, o.lane]).sort(),
      [
        ['parked', android.lane.id],
        ['parked', ios.lane.id],
      ].sort(),
      'the iOS lane parks for its dead owner, the Android lane for its idle one',
    );
    assert.equal(app.defaults.has('RCT_jsLocation'), false, 'the park left the bundler pin');
    assert.equal(app.defaults.has('apiBaseUrl'), false, 'the park left the dial default');
    assert.deepEqual([...(adbs.get(serial)?.reverseRules ?? [])], [], 'the park left adb reverse rules');
    assert.equal(recorders.running.size, 0, 'the park left the recording running');
    assert.equal(readInProgress(laneEvidence(w.dir, ios.lane.id), 'video', 'device'), null);
    assert.deepEqual(lines(trace), [], 'the teardown hook ran inside the window');

    kill(w, androidOwner);
    await w.clock.advance(OWNER_CHECK_MS);
    assert.deepEqual((await runSweep(deps)).found, [{ lane: android.lane.id, state: 'dead' }]);
    await w.clock.advance(RETURN_WINDOW_MS);
    const ended = await runSweep(deps);
    assert.deepEqual(
      ended.reaps.map(r => [r.kind, r.lane]).sort(),
      [
        ['ended', android.lane.id],
        ['ended', ios.lane.id],
      ].sort(),
      JSON.stringify(ended),
    );
    assert.deepEqual(ended.problems, []);
    assert.deepEqual(lines(trace).sort(), [`teardown ${android.lane.id}`, `teardown ${ios.lane.id}`].sort());
    assert.deepEqual(w.registry().status().lanes, []);
    assert.equal(app.defaults.has('RCT_jsLocation'), false);
    assert.deepEqual([...(adbs.get(serial)?.reverseRules ?? [])], []);
  } finally {
    w.close();
  }
});

test('a sweep with no dead owners starts no process beyond the one check of the owners not seen alive lately, and with every owner seen lately starts none', async () => {
  const w = world();
  try {
    for (const name of ['a', 'b', 'c']) await w.registry().claim(w.request(w.procs.owner(), w.folder(name), { boot: true }));
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
    const systemCalls: string[] = [];
    const system = new Proxy(realServiceSystem, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          systemCalls.push(String(key));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const deviceCalls = () => w.devices.calls.length + w.emulators.calls.length;
    const devicesBefore = deviceCalls();
    const site = { dir: w.dir, clock: w.clock, processes: counting };
    let started = 0;

    await w.clock.advance(OWNER_CHECK_MS - 1000);
    for (let i = 0; i < 50; i++)
      assert.equal(
        passBy(site, () => started++),
        false,
      );
    const quiet = await runSweep(sweepDeps(w, { processes: counting, system }));
    assert.deepEqual(quiet.checked, []);
    assert.deepEqual([started, reads, systemCalls, deviceCalls() - devicesBefore], [0, [], [], 0]);

    await w.clock.advance(1000);
    assert.equal(
      passBy(site, () => started++),
      true,
    );
    assert.equal(reads.length, 0, 'the check that a sweep is due reads no process table');
    const checked = await runSweep(sweepDeps(w, { processes: counting, system }));
    assert.equal(checked.checked.length, 3);
    assert.deepEqual(checked.found, []);
    assert.equal(reads.length, 1, `one read of the process table for every owner: ${JSON.stringify(reads)}`);
    assert.equal(reads[0]?.length, 3);
    assert.deepEqual([systemCalls, deviceCalls() - devicesBefore], [[], 0]);

    reads.length = 0;
    for (let i = 0; i < 50; i++)
      assert.equal(
        passBy(site, () => started++),
        false,
      );
    const after = await runSweep(sweepDeps(w, { processes: counting, system }));
    assert.deepEqual([after.checked, reads, started], [[], [], 1]);
  } finally {
    w.close();
  }
});

test("a dead owner's lane is parked at the next sweep and keeps its resources until 30 minutes after its owner was found dead, when its teardowns run", async () => {
  const w = world();
  const api = service();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const owner = claude(w, 'session-a');
    const a = await w.registry().claim(w.request(owner, w.folder('a'), { boot: true }));
    makeResource(w.registry(), a.lane, dropped);
    recordService(w.registry(), a.lane, api);
    kill(w, owner);
    await w.clock.advance(OWNER_CHECK_MS);

    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    const found = await runSweep(sweepDeps(w));
    const foundAt = w.clock.now();
    assert.deepEqual(found.found, [{ lane: a.lane.id, state: 'dead' }]);
    assert.deepEqual(
      found.outcomes.map(o => [o.kind, o.lane]),
      [['parked', a.lane.id]],
    );
    await until(() => !running(api.pid ?? 0));
    const parked = statusOf(w, a.lane.id);
    assert.equal(parked?.device, null);
    assert.deepEqual(parked.ports, a.lane.ports);
    assert.deepEqual(parked.resources, [{ name: 'db', exports: { DATABASE_URL: `postgres://db/${a.lane.id}` } }]);
    assert.deepEqual(parked.ownerGone, {
      state: 'dead',
      foundAt,
      endsAt: foundAt + RETURN_WINDOW_MS,
      session: 'session-a',
      by: null,
    });
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false, 'a parked lane waits out its window');

    await w.clock.advance(RETURN_WINDOW_MS - 1000);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
    const early = await runSweep(sweepDeps(w));
    assert.deepEqual(early.reaps, []);
    assert.deepEqual(lines(dropped), []);
    assert.deepEqual(w.registry().pendingTeardowns(), []);
    assert.ok(statusOf(w, a.lane.id));

    await w.clock.advance(1000);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    const ended = await runSweep(sweepDeps(w));
    assert.deepEqual(
      ended.reaps.map(r => [r.kind, r.lane]),
      [['ended', a.lane.id]],
    );
    assert.deepEqual(lines(dropped), [`dropped postgres://db/${a.lane.id}`]);
    assert.equal(statusOf(w, a.lane.id), undefined);
    assert.deepEqual(w.registry().pendingTeardowns(), []);
    assert.deepEqual(history(w), [{ claim_id: a.lane.id, reason: 'dead' }]);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
  } finally {
    api.kill('SIGKILL');
    w.close();
  }
});

async function goneLane(w: World, session: string | null, dropped: string): Promise<{ owner: Owner; lane: Lane }> {
  const owner = claude(w, session);
  const { lane } = await w.registry().claim(w.request(owner, fs.realpathSync(w.folder('a')), { boot: true }));
  makeResource(w.registry(), lane, dropped);
  kill(w, owner);
  await w.clock.advance(OWNER_CHECK_MS);
  assert.deepEqual((await runSweep(sweepDeps(w))).found, [{ lane: lane.id, state: 'dead' }]);
  return { owner, lane };
}

test("a new process presenting the lane's session id inside the window is its owner again, finds its resource values unchanged, and its next call wakes the lane", async () => {
  const w = world();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const { owner, lane } = await goneLane(w, 'session-a', dropped);
    await w.clock.advance(RETURN_WINDOW_MS - MINUTE_MS);
    const back = claude(w, 'session-a');
    const env = { AGENTLANE_STATE_DIR: w.dir };
    const caller = resolveCallerLane({
      env,
      cwd: lane.worktree,
      worktree: lane.worktree,
      processes: w.procs,
      clock: w.clock,
      owner: back,
    });
    assert.equal(caller.lane.id, lane.id);
    assert.equal(caller.lane.token, lane.token);
    assert.equal(caller.lane.ownerKey, ownerKey(back));
    assert.deepEqual(caller.lane.owner.process, back.process);
    assert.deepEqual(caller.lane.ports, lane.ports);
    assert.deepEqual(caller.lane.resources, [{ name: 'db', exports: { DATABASE_URL: `postgres://db/${lane.id}` } }]);
    assert.equal(caller.park?.state, 'parked');
    const status = statusOf(w, lane.id);
    assert.equal(status?.ownerGone, null);
    assert.equal(status.ownerState, 'alive');
    assert.notEqual(status.ownerKey, ownerKey(owner));

    const woken: string[] = [];
    const awake = await enterLane(
      { stateDir: w.dir, processes: w.procs, clock: w.clock, self: w.procs.spawn() },
      caller.lane,
      caller.park,
      l => {
        woken.push(l.id);
        return Promise.resolve();
      },
    );
    assert.deepEqual(woken, [lane.id]);
    assert.equal(awake.id, lane.id);
    assert.equal(w.registry().parkOf(lane.id), null, 'the lane is awake');

    const again = await w.registry().claim(w.request(back, lane.worktree));
    assert.equal(again.lane.id, lane.id);
    assert.equal(again.created, false);

    await w.clock.advance(2 * RETURN_WINDOW_MS);
    const later = await runSweep(sweepDeps(w));
    assert.deepEqual(later.reaps, [], 'a lane its owner took back is never ended by the window');
    assert.deepEqual(lines(dropped), []);
  } finally {
    w.close();
  }
});

test('a returning Claude session takes its lane back through up as well, and a Codex thread that returns in a new process keeps its lane', async () => {
  const w = world();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const { lane } = await goneLane(w, 'session-a', dropped);
    const back = claude(w, 'session-a');
    const claimed = await w.registry().claim(w.request(back, lane.worktree));
    assert.equal(claimed.lane.id, lane.id);
    assert.equal(claimed.created, false);
    assert.deepEqual(claimed.lane.resources, [{ name: 'db', exports: { DATABASE_URL: `postgres://db/${lane.id}` } }]);

    const thread = (process: Owner['process']): Owner => ({ kind: 'codex', process, sessionId: null, threadId: 'thread-1' });
    const first = thread(w.procs.spawn('codex exec'));
    const codex = await w.registry().claim(w.request(first, w.folder('codex')));
    kill(w, first);
    await w.clock.advance(OWNER_CHECK_MS);
    assert.deepEqual((await runSweep(sweepDeps(w))).found, [{ lane: codex.lane.id, state: 'dead' }]);
    const second = thread(w.procs.spawn('codex exec'));
    const kept = w.registry().takeBack(second, codex.lane.worktree);
    assert.equal(kept?.id, codex.lane.id);
    assert.deepEqual(kept.owner.process, second.process);
    assert.equal(statusOf(w, codex.lane.id)?.ownerGone, null);
    await w.clock.advance(RETURN_WINDOW_MS + OWNER_CHECK_MS);
    const later = await runSweep(sweepDeps(w));
    assert.deepEqual(later.found, [], 'the sweep judges the thread by its new process');
    assert.deepEqual(later.reaps, []);
  } finally {
    w.close();
  }
});

test('after the window the lane is ended, and the same session id gets a new lane', async () => {
  const w = world();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const { lane } = await goneLane(w, 'session-a', dropped);
    await w.clock.advance(RETURN_WINDOW_MS);
    const late = claude(w, 'session-a');
    assert.equal(w.registry().takeBack(late, lane.worktree), null, 'the window passed before any sweep ended the lane');
    const fresh = await w.registry().claim(w.request(late, lane.worktree, { device: null }));
    assert.notEqual(fresh.lane.id, lane.id);
    assert.equal(fresh.created, true);
    assert.deepEqual(fresh.lane.resources, []);

    const ended = await runSweep(sweepDeps(w));
    assert.deepEqual(
      ended.reaps.map(r => [r.kind, r.lane]),
      [['ended', lane.id]],
    );
    assert.deepEqual(lines(dropped), [`dropped postgres://db/${lane.id}`]);
    const after = claude(w, 'session-a');
    const next = await w.registry().claim(w.request(after, w.folder('a'), { device: null }));
    assert.notEqual(next.lane.id, lane.id);
    assert.equal(next.created, true);
  } finally {
    w.close();
  }
});

test('a process with another session id, none, another agent or another folder never gets the lane, inside the window or after', async () => {
  const w = world();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const { owner, lane } = await goneLane(w, 'session-a', dropped);
    const strangers: [string, Owner, string][] = [
      ['another session', claude(w, 'session-b'), lane.worktree],
      ['no session id', claude(w, null), lane.worktree],
      [
        'Cursor with the same id',
        { kind: 'process', process: w.procs.spawn(), sessionId: 'cursor:session-a', threadId: null },
        lane.worktree,
      ],
      [
        'a Codex thread with the same id',
        { kind: 'codex', process: w.procs.spawn(), sessionId: null, threadId: 'session-a' },
        lane.worktree,
      ],
      ['the same session in another folder', claude(w, 'session-a'), w.folder('elsewhere')],
    ];
    for (const at of ['inside the window', 'after it'] as const) {
      if (at === 'after it') await w.clock.advance(RETURN_WINDOW_MS);
      for (const [who, stranger, folder] of strangers) {
        assert.equal(w.registry().takeBack(stranger, folder), null, `${who}, ${at}`);
        const claimed = await w.registry().claim(w.request(stranger, folder, { device: null }));
        assert.notEqual(claimed.lane.id, lane.id, `${who} was handed the lane ${at}`);
        w.registry().release(refOf(claimed.lane), stranger);
        const kept = statusOf(w, lane.id);
        assert.equal(kept?.ownerKey, ownerKey(owner), `${who} took the lane's ownership ${at}`);
        assert.equal(kept.ownerGone?.state, 'dead');
      }
    }
  } finally {
    w.close();
  }
});

test('a session-end event releases at once, with no window, even when a sweep found the owner gone first', async () => {
  const w = world();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const hook = (owner: Owner) =>
      runHookCommand(['session-end'], {
        ...cliDeps(w, []),
        env: { ...cliDeps(w, []).env, [SESSION_END_OWNER_ENV]: JSON.stringify(owner) },
        stdin: '',
        startWorker: () => undefined,
      });
    const live = claude(w, 'session-live');
    const kept = await w.registry().claim(w.request(live, w.folder('live')));
    makeResource(w.registry(), kept.lane, dropped);
    assert.equal(await hook(live), 0);
    assert.equal(statusOf(w, kept.lane.id), undefined, 'the session-end release waited for something');
    assert.deepEqual(lines(dropped), [`dropped postgres://db/${kept.lane.id}`]);

    const { owner, lane } = await goneLane(w, 'session-a', dropped);
    assert.ok(statusOf(w, lane.id)?.ownerGone);
    assert.equal(await hook(owner), 0);
    assert.equal(statusOf(w, lane.id), undefined);
    assert.deepEqual(lines(dropped).slice(-1), [`dropped postgres://db/${lane.id}`]);
    assert.deepEqual(
      history(w).map(h => h.reason),
      ['released', 'released'],
    );
  } finally {
    w.close();
  }
});

async function slowLane(w: World, trace: string, dropped: string): Promise<Lane> {
  const { folder, config } = project(w, trace);
  const owner = claude(w, null);
  const { lane } = await w.registry().claim(w.request(owner, folder, { device: null }));
  fs.writeFileSync(
    config,
    JSON.stringify({
      ...(JSON.parse(fs.readFileSync(config, 'utf8')) as object),
      hooks: { build: 'true', teardown: `sleep 0.3; echo "teardown $AGENTLANE_LANE" >> '${trace}'` },
    }),
  );
  writeUpRecord(laneDir(w.dir, lane.id), {
    version: 1,
    lane: lane.id,
    config,
    platform: 'ios',
    bundleId: BUNDLE,
    launch: 'bundler-pin',
    pinned: false,
    updatedAt: w.clock.now(),
  });
  makeResource(w.registry(), lane, dropped);
  kill(w, owner);
  await w.clock.advance(OWNER_CHECK_MS);
  assert.deepEqual((await runSweep(sweepDeps(w))).found, [{ lane: lane.id, state: 'dead' }]);
  await w.clock.advance(RETURN_WINDOW_MS);
  return lane;
}

test('two sweepers starting at once to end one lane run its teardown hook and its resource teardown once', async () => {
  const w = world();
  const trace = path.join(tempDir('reap-trace'), 'trace.log');
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const lane = await slowLane(w, trace, dropped);
    const reports = await Promise.all([runSweep(sweepDeps(w)), runSweep(sweepDeps(w))]);
    const reaps = reports.flatMap(r => r.reaps);
    assert.deepEqual(
      reaps.filter(r => r.kind === 'ended').map(r => r.lane),
      [lane.id],
      JSON.stringify(reaps),
    );
    assert.deepEqual(lines(trace), [`teardown ${lane.id}`]);
    assert.deepEqual(lines(dropped), [`dropped postgres://db/${lane.id}`]);
    assert.deepEqual(
      history(w).map(h => h.reason),
      ['dead'],
    );
  } finally {
    w.close();
  }
});

test('a sweeper that comes while another is ending a lane leaves the lane to it, even once the retry time has passed', async () => {
  const w = world();
  const trace = path.join(tempDir('reap-trace'), 'trace.log');
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const lane = await slowLane(w, trace, dropped);
    const first = sweepDeps(w);
    const ending = runSweep(first);
    await until(() => statusOf(w, lane.id)?.ownerGone?.by != null);
    assert.equal(statusOf(w, lane.id)?.ownerGone?.by, first.self?.pid);
    assert.deepEqual((await runSweep(sweepDeps(w))).reaps, [], 'a second sweeper started on a lane already being ended');
    await w.clock.advance(REAP_RETRY_MS);
    const late = await runSweep(sweepDeps(w));
    assert.deepEqual(late.reaps, [{ kind: 'left', lane: lane.id, reason: `pid ${String(first.self?.pid)} is ending it` }]);
    const done = await ending;
    assert.deepEqual(
      done.reaps.map(r => [r.kind, r.lane]),
      [['ended', lane.id]],
    );
    assert.deepEqual(lines(trace), [`teardown ${lane.id}`]);
    assert.deepEqual(lines(dropped), [`dropped postgres://db/${lane.id}`]);
    assert.deepEqual(
      history(w).map(h => h.reason),
      ['dead'],
    );
  } finally {
    w.close();
  }
});

test('status and lanes --json show a lane in its window: when its owner was found gone, when it ends, and which session can take it back', async () => {
  const w = world();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const { lane } = await goneLane(w, 'session-abcdefgh-1234', dropped);
    const foundAt = w.clock.now();
    await w.clock.advance(5 * MINUTE_MS);
    const out: string[] = [];
    assert.equal(await runRegistryCommand('status', [], cliDeps(w, out)), 0);
    assert.match(
      out.join(''),
      /\n {6}owner gone {3}owner dead, found \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(5m ago\); the lane ends \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(in 25m\) unless claude session session- calls on it from its folder\n/,
    );
    assert.match(out.join(''), /a lane whose owner is gone is parked at once and ends 30m later/);
    out.length = 0;
    assert.equal(await runRegistryCommand('lanes', ['--json'], cliDeps(w, out)), 0);
    const json = JSON.parse(out.join('')) as { lanes: LaneStatus[] };
    assert.deepEqual(json.lanes.find(c => c.id === lane.id)?.ownerGone, {
      state: 'dead',
      foundAt,
      endsAt: foundAt + RETURN_WINDOW_MS,
      session: 'session-abcdefgh-1234',
      by: null,
    });

    await w.clock.advance(RETURN_WINDOW_MS);
    out.length = 0;
    assert.equal(await runRegistryCommand('status', [], cliDeps(w, out)), 0);
    assert.match(out.join(''), /owner gone {3}owner dead, found .*; the next sweep ends the lane\n/);
  } finally {
    w.close();
  }
});

test('agentlane reap runs the sweep and says what it did, and --json gives the report to tools', async () => {
  const w = world();
  const dropped = path.join(tempDir('reap-db'), 'dropped.log');
  try {
    const out: string[] = [];
    const owner = w.procs.owner();
    const { lane } = await w.registry().claim(w.request(owner, w.folder('a'), { boot: true }));
    makeResource(w.registry(), lane, dropped);
    assert.equal(await runRegistryCommand('reap', [], cliDeps(w, out)), 0);
    assert.match(out.join(''), /^agentlane: nothing to park or end: no owner was due a check\n$/);

    kill(w, owner);
    await w.clock.advance(OWNER_CHECK_MS);
    out.length = 0;
    assert.equal(await runRegistryCommand('reap', [], cliDeps(w, out)), 0, out.join(''));
    assert.match(
      out.join(''),
      new RegExp(
        `agentlane: found the owner of lane ${lane.id} gone \\(owner dead\\): the lane is parked now, and it ends at .*; nothing can take it back\n`,
      ),
    );
    assert.match(out.join(''), new RegExp(`agentlane: parked lane ${lane.id}, whose owner is gone; it ends at `));

    await w.clock.advance(RETURN_WINDOW_MS);
    out.length = 0;
    assert.equal(await runRegistryCommand('reap', ['--json'], cliDeps(w, out)), 0, out.join(''));
    const report = JSON.parse(out.join('')) as SweepReport;
    assert.deepEqual(
      report.reaps.map(r => [r.kind, r.lane, r.kind === 'ended' ? r.state : null]),
      [['ended', lane.id, 'dead']],
    );
    assert.deepEqual(report.problems, []);
    assert.equal(statusOf(w, lane.id), undefined);
    assert.deepEqual(lines(dropped), [`dropped postgres://db/${lane.id}`]);
  } finally {
    w.close();
  }
});

test("a claim waiting for a device held by a gone owner's lane asks for the sweep, which frees it", async () => {
  const w = world({ poolSize: 1 });
  try {
    const owner = w.procs.owner();
    const a = await w.registry().claim(w.request(owner, w.folder('a'), { boot: true }));
    kill(w, owner);
    const sweeps: Promise<SweepReport>[] = [];
    const waiting = w
      .registry({ sweepSoon: () => sweeps.push(runSweep(sweepDeps(w))) })
      .claim(w.request(w.procs.owner(), w.folder('b'), { waitMs: 60_000 }));
    for (let i = 0; i < 100 && sweeps.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(sweeps.length > 0, 'the claim asked for no sweep');
    await Promise.all(sweeps);
    await w.clock.advance(500);
    const b = await waiting;
    assert.equal(b.lane.device?.id, a.lane.device?.id);
    assert.equal(statusOf(w, a.lane.id)?.park?.state, 'parked');
  } finally {
    w.close();
  }
});

const FORMER_041_SRC = process.env.AGENTLANE_041_SRC;

test(
  "0.4.1's own registry code beside the window: it still ends a gone owner's lane at once, the record goes with it, and a lane taken back is alive to it",
  { skip: !FORMER_041_SRC && "set AGENTLANE_041_SRC to 0.4.1's src folder, such as one from git archive 6777fca src" },
  async () => {
    const source = path.join(FORMER_041_SRC ?? '', 'registry', 'registry.ts');
    const { Registry: Registry041 } = (await import(pathToFileURL(source).href)) as {
      Registry: typeof import('../src/registry/registry.ts').Registry;
    };
    const w = world({ poolSize: 2 });
    const former = () =>
      Registry041.open({
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
      former().close();
      const doomed = claude(w, 'session-doomed');
      const a = await w.registry().claim(w.request(doomed, w.folder('a'), { boot: true }));
      const back = claude(w, 'session-back');
      const b = await w.registry().claim(w.request(back, w.folder('b'), { boot: true }));
      kill(w, doomed);
      kill(w, back);
      await w.clock.advance(OWNER_CHECK_MS);
      const report = await runSweep(sweepDeps(w));
      assert.deepEqual(report.found.map(f => f.lane).sort(), [a.lane.id, b.lane.id].sort());
      const returned = claude(w, 'session-back');
      assert.equal(w.registry().takeBack(returned, b.lane.worktree)?.id, b.lane.id);

      const old = former();
      try {
        const seen = old.status().lanes;
        assert.equal(seen.find(c => c.id === b.lane.id)?.ownerState, 'alive');
        const c = await old.claim(w.request(w.procs.owner(), w.folder('c'), { device: null }));
        assert.deepEqual(
          (c as unknown as { freed: { id: string }[] }).freed.map(e => e.id),
          [a.lane.id],
          "0.4.1 ends a dead owner's lane at once, as the ruling accepts",
        );
        const theirs = c.lane.ports.map(p => p.port);
        assert.deepEqual(
          theirs.filter(p => b.lane.ports.some(q => q.port === p)),
          [],
          `0.4.1 handed out a port of the lane taken back: ${theirs.join(', ')}`,
        );
      } finally {
        old.close();
      }
      const db = new DatabaseSync(databasePath(w.dir), { readOnly: true });
      try {
        assert.deepEqual(
          db
            .prepare('SELECT claim_id FROM owner_checks')
            .all()
            .map(r => String(r.claim_id)),
          [],
        );
      } finally {
        db.close();
      }
      assert.equal(statusOf(w, b.lane.id)?.ownerGone, null);
    } finally {
      w.close();
    }
  },
);
