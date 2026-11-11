import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { systemClock } from '../src/clock.ts';
import type { Ran } from '../src/driver/exec.ts';
import type { EvidenceSystem } from '../src/evidence/device.ts';
import { laneEvidence } from '../src/evidence/evidence.ts';
import { readInProgress, writeInProgress, type InProgress } from '../src/evidence/files.ts';
import { STRAY_RETRY_MS } from '../src/evidence/strays.ts';
import type { ProcessTable } from '../src/processes.ts';
import { startMs } from '../src/processes.ts';
import { MINUTE_MS } from '../src/registry/config.ts';
import { ownerKey } from '../src/registry/owner.ts';
import { OWNER_CHECK_MS, RETURN_WINDOW_MS } from '../src/registry/owner-checks.ts';
import { databasePath } from '../src/registry/paths.ts';
import type { Lane, ServiceProcess } from '../src/registry/types.ts';
import { leaderAliveAt, startService, stopService } from '../src/services/services.ts';
import { realServiceSystem, type ServiceSystem } from '../src/services/system.ts';
import { LANE_FILES_KEEP_MS, laneDir } from '../src/up/lane-files.ts';
import { ALIVE_REFRESH_MS, passBy, runSweep, sweepDue, type SweepDeps } from '../src/up/sweep.ts';
import { tempDir } from './support/fakes.ts';
import type { World } from './support/world.ts';
import { sawOwners, world } from './support/world.ts';

const DAY_MS = 24 * 60 * MINUTE_MS;

function refOf(lane: Lane) {
  return { id: lane.id, token: lane.token };
}

/** The service processes the fake process table holds, as the sweep's service system reads them. */
function fakeServices(w: World): ServiceSystem {
  return { ...realServiceSystem, processes: w.procs, running: pids => w.procs.startTimes(pids) };
}

function sweepDeps(w: World, over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    dir: w.dir,
    env: { PATH: process.env.PATH, HOME: tempDir('sweep-home') },
    processes: w.procs,
    system: fakeServices(w),
    clock: w.clock,
    devices: { ios: w.devices, android: w.emulators },
    ports: w.probe,
    config: w.config,
    self: w.procs.spawn(),
    ...over,
  };
}

/** A start time as ps prints it, in UTC as the toolkit runs ps. */
function lstart(ms: number): string {
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] ?? '';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] ?? '';
  const time = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  return `${day} ${month} ${String(d.getUTCDate()).padStart(2, ' ')} ${time} ${String(d.getUTCFullYear())}`;
}

/** xcrun on this Mac as the sweep sees it: recorders by pid, with their command and start time, that finish their file on SIGINT. */
class Recorders implements EvidenceSystem {
  readonly processes = new Map<number, { command: string; start: string; file: string }>();
  readonly signalled: number[] = [];
  /** The pids whose start time ps can't read. */
  readonly unreadable = new Set<number>();

  run(): Promise<Ran> {
    return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', error: undefined });
  }

  start(): number | undefined {
    return undefined;
  }

  commandOf(pid: number): string | undefined {
    return this.processes.get(pid)?.command;
  }

  startTimes(pids: readonly number[]): ReadonlyMap<number, string> | undefined {
    if (pids.some(pid => this.unreadable.has(pid))) return undefined;
    return new Map(
      pids.flatMap(pid => {
        const found = this.processes.get(pid);
        return found ? [[pid, found.start] as const] : [];
      }),
    );
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signalled.push(pid);
    const found = this.processes.get(pid);
    if (!found) return;
    if (signal === 'SIGINT') fs.writeFileSync(found.file, 'mp4');
    this.processes.delete(pid);
  }
}

interface Recording {
  pid: number;
  file: string;
  evidence: string;
}

/**
 * A recording of the lane's simulator, as `evidence video start` leaves it: the recorder running and its marker in the
 * lane's evidence folder. `written: '0.4.1'` writes the marker as 0.4.1 does, without the recorder's start time.
 */
function recording(
  w: World,
  recorders: Recorders,
  lane: string,
  pid: number,
  options: { written?: '0.4.1'; leftAt?: number } = {},
): Recording {
  const evidence = laneEvidence(w.dir, lane);
  const file = path.join(evidence, `video-${String(pid)}.mp4`);
  const command = `xcrun simctl io SIM-${lane} recordVideo --codec=h264 --force ${file}`;
  const start = options.written === '0.4.1' ? lstart(w.clock.now() - 300) : `recorder #${String(pid)}`;
  recorders.processes.set(pid, { command, start, file });
  const marker: InProgress = {
    version: 1,
    target: 'device',
    startedAt: w.clock.now(),
    file,
    pid,
    command,
    platform: 'ios',
    device: `SIM-${lane}`,
    ...(options.written === '0.4.1' ? {} : { start }),
    ...(options.leftAt === undefined ? {} : { leftAt: options.leftAt }),
  };
  writeInProgress(evidence, 'video', marker);
  return { pid, file, evidence };
}

function deleteRowAs041(w: World, lane: string): void {
  const db = new DatabaseSync(databasePath(w.dir));
  try {
    db.prepare('DELETE FROM claims WHERE id = ?').run(lane);
  } finally {
    db.close();
  }
}

function marked(r: Recording): InProgress | null {
  return readInProgress(r.evidence, 'video', 'device');
}

test('the sweep stops the recorder a lane left running once it ended, by release, by a reap or by 0.4.1 deleting its row, and leaves alone a process that reused a recorder pid', async () => {
  const w = world({ parkMs: DAY_MS });
  const recorders = new Recorders();
  try {
    const claim = async (name: string) => {
      const owner = w.procs.owner();
      return { owner, lane: (await w.registry().claim(w.request(owner, w.folder(name), { device: null }))).lane };
    };
    const released = await claim('released');
    const reaped = await claim('reaped');
    const old = await claim('old');
    const reused = await claim('reused');
    const live = await claim('live');
    const deps = sweepDeps(w, { evidence: recorders });

    w.procs.kill(reaped.owner.process?.pid ?? 0);
    await w.clock.advance(OWNER_CHECK_MS);
    assert.deepEqual((await runSweep(deps)).found, [{ lane: reaped.lane.id, state: 'dead' }]);
    await w.clock.advance(RETURN_WINDOW_MS);
    const reap = await runSweep(deps);
    assert.deepEqual(
      reap.reaps.map(r => [r.kind, r.lane]),
      [['ended', reaped.lane.id]],
    );
    w.registry().release(refOf(released.lane), released.owner);
    w.registry().release(refOf(reused.lane), reused.owner);
    deleteRowAs041(w, old.lane.id);
    for (const l of [live.lane]) w.registry().touch(refOf(l), 'test');
    sawOwners(w.registry());
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);

    const stopped = [
      recording(w, recorders, released.lane.id, 9001),
      recording(w, recorders, reaped.lane.id, 9002),
      recording(w, recorders, old.lane.id, 9003, { written: '0.4.1' }),
    ];
    const another = recording(w, recorders, reused.lane.id, 9004);
    const reuser = recorders.processes.get(another.pid);
    if (reuser) reuser.start = 'recorder #reused';
    const own = recording(w, recorders, live.lane.id, 9005);
    let started = 0;
    assert.equal(
      passBy({ dir: w.dir, clock: w.clock, processes: w.procs }, () => started++),
      true,
      'a recorder left by an ended lane is work for the sweep',
    );
    assert.equal(started, 1);

    const report = await runSweep(deps);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(
      report.recorders.map(r => [r.lane, r.kind, r.pid]).sort(),
      [
        [released.lane.id, 'stopped', 9001],
        [reaped.lane.id, 'stopped', 9002],
        [old.lane.id, 'stopped', 9003],
        [reused.lane.id, 'not-ours', 9004],
      ].sort(),
    );
    for (const r of stopped) {
      assert.equal(recorders.processes.has(r.pid), false, `recorder ${String(r.pid)} still runs`);
      assert.equal(fs.readFileSync(r.file, 'utf8'), 'mp4', 'the recorder was not interrupted, so its video is not complete');
      assert.equal(marked(r), null);
    }
    assert.deepEqual(recorders.signalled.sort(), [9001, 9002, 9003], 'a process not proven to be the recorder was signalled');
    assert.equal(recorders.processes.has(another.pid), true);
    const notOurs = report.recorders.find(r => r.pid === another.pid);
    assert.match(notOurs?.kind === 'not-ours' ? notOurs.reason : '', /^it started recorder #reused UTC, not recorder #9004 UTC$/);
    assert.equal(marked(another), null, 'the marker of a recorder known gone was kept');
    assert.equal(recorders.processes.has(own.pid), true, "the sweep stopped a live lane's recorder");
    assert.notEqual(marked(own), null);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), false);
  } finally {
    w.close();
  }
});

test("a 0.4.1 marker proves its recorder only by a start in the second the recording began, and an ended lane's recorder ps can't read is left marked and looked at again later", async () => {
  const w = world();
  const recorders = new Recorders();
  try {
    const owner = w.procs.owner();
    const early = (await w.registry().claim(w.request(owner, w.folder('early'), { device: null }))).lane;
    const blind = (await w.registry().claim(w.request(owner, w.folder('blind'), { device: null }))).lane;
    w.registry().release(refOf(early), owner);
    w.registry().release(refOf(blind), owner);
    const deps = sweepDeps(w, { evidence: recorders });
    const wrong = recording(w, recorders, early.id, 9101, { written: '0.4.1' });
    const earlier = recorders.processes.get(wrong.pid);
    if (earlier) earlier.start = lstart(w.clock.now() - 3000);
    const unread = recording(w, recorders, blind.id, 9102);
    recorders.unreadable.add(9102);

    const first = await runSweep(deps);
    const byLane = new Map(first.recorders.map(r => [r.lane, r]));
    assert.equal(byLane.get(blind.id)?.kind, 'cant-tell');
    assert.match(first.problems.join('\n'), new RegExp(`^lane ${blind.id}: could not prove pid 9102 is the device recorder`));
    assert.equal(recorders.processes.has(unread.pid), true);
    assert.equal(marked(unread)?.leftAt, w.clock.now());
    assert.deepEqual(recorders.signalled, []);

    recorders.unreadable.clear();
    await w.clock.advance(STRAY_RETRY_MS - 1);
    sawOwners(w.registry());
    assert.equal(
      sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }),
      false,
      'an unproven recorder is due at every pass-by',
    );
    await w.clock.advance(1);
    assert.equal(sweepDue({ dir: w.dir, clock: w.clock, processes: w.procs }), true);
    recorders.unreadable.add(9102);
    await w.clock.advance(LANE_FILES_KEEP_MS);
    for (const id of [early.id, blind.id]) {
      const at = new Date(w.clock.now() - LANE_FILES_KEEP_MS - DAY_MS);
      for (const dir of [laneEvidence(w.dir, id), laneDir(w.dir, id)]) fs.utimesSync(dir, at, at);
    }
    const later = await runSweep(deps);
    assert.deepEqual(later.pruned, [early.id]);
    assert.equal(fs.existsSync(unread.evidence), true, 'the folder a recorder may still write in was removed');

    recorders.unreadable.clear();
    await w.clock.advance(STRAY_RETRY_MS);
    const last = await runSweep(deps);
    assert.deepEqual(
      last.recorders.map(r => [r.lane, r.kind]),
      [[blind.id, 'stopped']],
    );
    assert.equal(recorders.processes.has(unread.pid), false);
    assert.equal(marked(unread), null);
    const left = first.recorders.find(r => r.pid === wrong.pid);
    assert.equal(left?.kind, 'not-ours');
    assert.equal(
      recorders.processes.has(wrong.pid),
      true,
      'a process that started 3 s before the 0.4.1 recording began was signalled',
    );
  } finally {
    w.close();
  }
});

test("the sweep removes an ended lane's folder, its evidence with it, seven days after the lane ended, and never the folder of a lane the registry records", async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const claim = async (name: string) => (await w.registry().claim(w.request(owner, w.folder(name), { device: null }))).lane;
    const live = await claim('live');
    const first = await claim('first');
    const second = await claim('second');
    const t0 = w.clock.now();
    const formerId = 'f041f041';
    const former = w.procs.spawn();
    const db = new DatabaseSync(databasePath(w.dir));
    try {
      const formerOwner = { kind: 'process', process: former, sessionId: null, threadId: null } as const;
      db.prepare(
        `INSERT INTO claims (id, token, owner_key, owner_kind, owner_pid, owner_start, owner_session, owner_thread,
           project_root, worktree, created_at, last_used_at, last_action)
         VALUES (?, 'token', ?, 'process', ?, ?, NULL, NULL, ?, ?, ?, ?, 'claim')`,
      ).run(formerId, ownerKey(formerOwner), former.pid, former.start, w.folder('former'), w.folder('former'), t0, t0);
    } finally {
      db.close();
    }
    const shots = new Map<string, string>();
    for (const id of [live.id, first.id, second.id, formerId]) {
      const shot = path.join(laneEvidence(w.dir, id), 'shot.jpg');
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      fs.writeFileSync(shot, 'jpeg');
      shots.set(id, shot);
    }
    const age = () => {
      const at = new Date(t0);
      for (const id of shots.keys()) if (fs.existsSync(laneDir(w.dir, id))) fs.utimesSync(laneDir(w.dir, id), at, at);
    };
    w.registry().release(refOf(first), owner);
    await w.clock.advance(6 * DAY_MS);
    w.registry().release(refOf(second), owner);
    await w.clock.advance(DAY_MS + MINUTE_MS);
    age();

    const deps = sweepDeps(w);
    const report = await runSweep(deps);
    assert.deepEqual(report.pruned, [first.id]);
    assert.equal(fs.existsSync(laneDir(w.dir, first.id)), false);
    assert.equal(
      fs.readFileSync(shots.get(second.id) ?? '', 'utf8'),
      'jpeg',
      'evidence went a day after its lane ended, though its folder was last written to 7 days ago',
    );
    assert.equal(fs.existsSync(shots.get(live.id) ?? ''), true);
    assert.equal(fs.existsSync(shots.get(formerId) ?? ''), true, "the folder of a lane 0.4.1's row records was removed");

    await w.clock.advance(6 * DAY_MS);
    age();
    assert.deepEqual((await runSweep(deps)).pruned, [second.id]);
    assert.equal(fs.existsSync(shots.get(live.id) ?? ''), true, 'the folder of a lane the registry records was removed');
    assert.equal(fs.existsSync(shots.get(formerId) ?? ''), true);
  } finally {
    w.close();
  }
});

test('passing by reads no process and starts no sweeper while every service leader was seen lately and each ended recorder was looked at lately', async () => {
  const w = world();
  const recorders = new Recorders();
  try {
    const owner = w.procs.owner();
    const running = (await w.registry().claim(w.request(owner, w.folder('running'), { device: null }))).lane;
    const ended = (await w.registry().claim(w.request(owner, w.folder('ended'), { device: null }))).lane;
    const plain = (await w.registry().claim(w.request(owner, w.folder('plain'), { device: null }))).lane;
    const leader = w.procs.spawn('node api.mjs');
    const proc: ServiceProcess = { service: 'api', ...leader, cwd: null };
    w.registry().recordProcess(refOf(running), proc);
    w.registry().recordLeaderAlive(running.id, proc, w.clock.now());
    w.registry().release(refOf(ended), owner);
    w.registry().release(refOf(plain), owner);
    recording(w, recorders, ended.id, 9201, { leftAt: w.clock.now() });
    fs.mkdirSync(laneEvidence(w.dir, plain.id), { recursive: true });
    await w.clock.advance(2 * MINUTE_MS);
    sawOwners(w.registry());

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
    for (let i = 0; i < 200; i++) {
      assert.equal(
        passBy({ dir: w.dir, clock: w.clock, processes: counting }, () => started++),
        false,
      );
    }
    assert.equal(started, 0);
    assert.deepEqual(reads, []);
    assert.deepEqual(recorders.signalled, []);
  } finally {
    w.close();
  }
});

test("a sweep is due once a service leader's recorded moment is ALIVE_REFRESH_MS old, moves it on, and a leader it can't see running is not due again before that long", async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const lane = (await w.registry().claim(w.request(owner, w.folder('a'), { device: null }))).lane;
    const leader = w.procs.spawn('node api.mjs');
    const proc: ServiceProcess = { service: 'api', ...leader, cwd: null };
    w.registry().recordProcess(refOf(lane), proc);
    w.registry().recordLeaderAlive(lane.id, proc, w.clock.now());
    const site = { dir: w.dir, clock: w.clock, processes: w.procs };
    const due = async (ms: number) => {
      await w.clock.advance(ms);
      w.registry().touch(refOf(lane), 'test');
      return sweepDue(site);
    };
    assert.equal(await due(ALIVE_REFRESH_MS - 1), false);
    assert.equal(await due(1), true);
    const refreshed = await runSweep(sweepDeps(w));
    assert.deepEqual(refreshed.alive, [{ lane: lane.id, service: 'api', aliveAt: w.clock.now() }]);
    assert.equal(w.registry().status().lanes[0]?.processes[0]?.aliveAt, w.clock.now());
    assert.equal(sweepDue(site), false);

    w.procs.kill(leader.pid);
    assert.equal(await due(ALIVE_REFRESH_MS), true);
    assert.deepEqual((await runSweep(sweepDeps(w))).alive, []);
    assert.equal(await due(ALIVE_REFRESH_MS - 1), false, 'a leader no check can see running makes every pass-by start a sweeper');
    assert.equal(await due(1), true);
  } finally {
    w.close();
  }
});

/** Forks a long-lived worker in its process group, after the delay in ms its argument names. */
const FORKER = `import { spawn } from 'node:child_process';
setTimeout(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' }), Number(process.argv[2]));
setInterval(() => {}, 1e9);
`;

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

test('a stop proves ours, through the moment the sweep saw its leader running, a worker the leader forked after the moment `up` recorded', async t => {
  const system = realServiceSystem;
  const project = fs.realpathSync(tempDir('sweep-services'));
  fs.writeFileSync(path.join(project, 'forker.mjs'), FORKER);
  const w = world();
  const proc = startService(
    system,
    {
      name: 'api',
      type: 'api',
      ports: null,
      start: 'exec node forker.mjs 1500',
      cwd: project,
      ready: { kind: 'tcp', host: '127.0.0.1' },
      timeoutMs: 8000,
      dial: null,
      platforms: null,
    },
    { PATH: process.env.PATH },
    path.join(project, 'api.log'),
  );
  t.after(() => {
    for (const below of system.descendants(proc.pid) ?? []) system.signal(below.pid, 'SIGKILL');
    system.signalGroup(proc.pid, 'SIGKILL');
    w.close();
    fs.rmSync(project, { recursive: true, force: true });
  });
  await w.clock.advance(Date.now() - w.clock.now());
  const owner = w.procs.owner();
  const lane = (await w.registry().claim(w.request(owner, w.folder('a'), { device: null }))).lane;
  w.registry().recordProcess(refOf(lane), proc);
  const recorded = leaderAliveAt(system, proc, systemClock);
  assert.ok(recorded !== undefined, 'the leader was not seen running');
  w.registry().recordLeaderAlive(lane.id, proc, recorded);

  await until(() => (system.groupMembers(proc.pid) ?? []).length === 2);
  const worker = (system.groupMembers(proc.pid) ?? []).find(pid => pid !== proc.pid) ?? 0;
  const workerStart = startMs(system.processes.startTimes([worker])?.get(worker) ?? '');
  assert.ok(workerStart - startMs(proc.start) > 1000, 'the worker started with the leader');
  await until(() => Date.now() >= workerStart + 1000);
  await w.clock.advance(Date.now() - w.clock.now());
  const report = await runSweep(sweepDeps(w, { system }));
  assert.deepEqual(report.problems, []);
  assert.deepEqual(
    report.alive.map(a => [a.lane, a.service]),
    [[lane.id, 'api']],
  );
  const refreshed = w
    .registry()
    .status()
    .lanes[0]?.processes.find(p => p.service === 'api');
  assert.ok(refreshed?.aliveAt !== undefined && refreshed.aliveAt >= workerStart + 1000);

  system.signal(proc.pid, 'SIGKILL');
  await until(() => !alive(proc.pid) && (system.groupMembers(proc.pid) ?? []).join() === String(worker));
  const before = await stopService(system, { ...proc, aliveAt: recorded }, systemClock);
  assert.equal(before.kind, 'cant-tell', 'the moment up recorded already proved the worker ours');
  assert.equal(alive(worker), true);
  const after = await stopService(system, refreshed, systemClock);
  assert.equal(after.kind, 'stopped');
  assert.equal(alive(worker), false, `the worker pid ${String(worker)} outlived its service`);
});
