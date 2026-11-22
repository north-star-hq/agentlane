import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SharedServiceConfig } from '../../src/project/config.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { describeStart } from '../../src/processes.ts';
import { formatTime } from '../../src/registry/format.ts';
import { databasePath } from '../../src/registry/paths.ts';
import { SHARED_IDLE_MS, SHARED_STOP_RETRY_MS } from '../../src/registry/shared.ts';
import type { LaneRef, ProcessState } from '../../src/registry/types.ts';
import { sharedLog, startSharedForLane, stopUnneededShared } from '../../src/up/shared.ts';
import { tempDir } from '../support/fakes.ts';
import { parkNow, world, type World } from '../support/world.ts';

const NO_DEVICE = { device: null } as const;

async function laneWithProcesses(w: World) {
  const out = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), NO_DEVICE));
  const ref = { id: out.lane.id, token: out.lane.token };
  const metro = w.procs.spawn('metro');
  const api = w.procs.spawn('api');
  const web = w.procs.spawn('web');
  for (const [service, proc] of [
    ['metro', metro],
    ['api', api],
    ['web', web],
  ] as const)
    w.registry().recordProcess(ref, { service, ...proc, cwd: out.lane.worktree });
  return { lane: out.lane, metro, api, web };
}

async function run(w: World, command: string, args: string[] = []) {
  const home = path.join(path.dirname(w.dir), 'home');
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRegistryCommand(command, args, {
    env: {
      AGENTLANE_STATE_DIR: w.dir,
      HOME: home,
      XDG_STATE_HOME: path.join(home, 'state'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CONFIG_HOME: path.join(home, 'config'),
      CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      CODEX_HOME: path.join(home, 'codex'),
    },
    cwd: home,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    processes: w.procs,
    ports: w.probe,
    devices: {},
    clock: w.clock,
  });
  assert.equal(code, 0, err.join(''));
  return out.join('');
}

function processLine(stdout: string, service: string): string {
  return stdout.split('\n').find(line => new RegExp(`^ +process +${service} pid `).test(line)) ?? '';
}

test('status says a recorded process is gone when its pid has exited or been reused, and running when it is alive', async () => {
  const w = world();
  try {
    const { metro, api, web } = await laneWithProcesses(w);
    w.procs.kill(api.pid);
    w.procs.recycle(web.pid);
    const stdout = await run(w, 'status');
    assert.equal(
      processLine(stdout, 'metro'),
      `      process      metro pid ${String(metro.pid)} (started ${describeStart(metro.start)})  running`,
    );
    assert.match(processLine(stdout, 'api'), new RegExp(`pid ${String(api.pid)} .*\\)  gone$`));
    assert.match(processLine(stdout, 'web'), new RegExp(`pid ${String(web.pid)} .*\\)  gone$`));
  } finally {
    w.close();
  }
});

test('lanes --json gives each recorded process a state of running, gone or unknown', async () => {
  const w = world();
  try {
    const { lane, metro, api, web } = await laneWithProcesses(w);
    w.procs.kill(api.pid);
    w.procs.recycle(web.pid);
    const states = async () => {
      const report = JSON.parse(await run(w, 'lanes', ['--json'])) as {
        lanes: { id: string; processes: { service: string; pid: number; state: ProcessState }[] }[];
      };
      return report.lanes.find(c => c.id === lane.id)?.processes.map(p => [p.service, p.pid, p.state]);
    };
    assert.deepEqual(await states(), [
      ['api', api.pid, 'gone'],
      ['metro', metro.pid, 'running'],
      ['web', web.pid, 'gone'],
    ]);
    w.procs.blind = true;
    assert.deepEqual(await states(), [
      ['api', api.pid, 'unknown'],
      ['metro', metro.pid, 'unknown'],
      ['web', web.pid, 'unknown'],
    ]);
  } finally {
    w.close();
  }
});

test('status lists every recorded process with one process listing', async () => {
  const w = world();
  try {
    await laneWithProcesses(w);
    await w.registry().claim(w.request(w.procs.owner(), w.folder('b'), NO_DEVICE));
    const calls: number[][] = [];
    const startTimes = w.procs.startTimes.bind(w.procs);
    w.procs.startTimes = pids => {
      calls.push([...pids]);
      return startTimes(pids);
    };
    w.registry().status();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.length, 5);
  } finally {
    w.close();
  }
});

function sharedSpec(dir: string, over: Partial<SharedServiceConfig> = {}): SharedServiceConfig {
  const up = path.join(dir, 'up');
  return {
    name: 'db',
    start: `touch '${up}'`,
    stop: `rm -f '${up}'`,
    ready: `test -f '${up}'`,
    cwd: dir,
    timeoutMs: 5000,
    ...over,
  };
}

async function sharedLane(w: World, name: string): Promise<LaneRef> {
  const request = w.request(w.procs.owner(), w.folder(name), { device: null, services: [], projectRoot: w.folder('lanski') });
  const { lane } = await w.registry().claim(request);
  return { id: lane.id, token: lane.token };
}

function sharedDeps(w: World) {
  return { env: { PATH: process.env.PATH }, clock: w.clock };
}

function sharedBlock(stdout: string): string[] {
  const lines = stdout.split('\n');
  const start = lines.findIndex(l => l.startsWith('shared service '));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l === '');
  return lines.slice(start, end < 0 ? undefined : end);
}

test('status lists a shared service after the lanes: running, used by the two lanes that need it, with its repository', async () => {
  const w = world();
  const dir = tempDir('status-shared');
  try {
    const a = await sharedLane(w, 'a');
    const b = await sharedLane(w, 'b');
    const repo = w.folder('lanski');
    const startedAt = w.clock.now();
    await startSharedForLane(sharedDeps(w), w.registry(), a, [sharedSpec(dir)]);
    await startSharedForLane(sharedDeps(w), w.registry(), b, [sharedSpec(dir)]);
    const ids = [a.id, b.id].sort();
    const stdout = await run(w, 'status');
    assert.deepEqual(sharedBlock(stdout), [
      `shared service db: running, used by 2 lanes (${ids.join(', ')})`,
      `      repository   lanski  (${repo})   running since ${formatTime(startedAt)}`,
    ]);
    assert.ok(stdout.indexOf('lanes (2):') < stdout.indexOf('shared service db'), 'after the lanes');
  } finally {
    w.close();
  }
});

test('status says when a running shared service nothing needs stops, then shows it stopped', async () => {
  const w = world();
  const dir = tempDir('status-shared');
  try {
    const a = await sharedLane(w, 'a');
    await startSharedForLane(sharedDeps(w), w.registry(), a, [sharedSpec(dir)]);
    assert.ok(parkNow(w.registry(), a));
    const parkedAt = w.clock.now();
    await w.clock.advance(60_000);
    assert.equal(
      sharedBlock(await run(w, 'status'))[0],
      `shared service db: running, used by no lane; stops ${formatTime(parkedAt + SHARED_IDLE_MS)} (in 4m)`,
    );
    await w.clock.advance(SHARED_IDLE_MS);
    assert.equal(sharedBlock(await run(w, 'status'))[0], 'shared service db: running, used by no lane; the next sweep stops it');
    const stopped = await stopUnneededShared(sharedDeps(w), w.registry());
    assert.deepEqual(
      stopped.map(s => s.outcome),
      ['stopped'],
    );
    const lines = sharedBlock(await run(w, 'status'));
    assert.equal(lines[0], 'shared service db: stopped');
    assert.match(lines[1] ?? '', new RegExp(` stopped since ${formatTime(w.clock.now())}$`));
    assert.equal(lines.length, 2);
  } finally {
    w.close();
  }
});

test('status shows a failed stop with its problem, its log and when the next sweep tries it again', async () => {
  const w = world();
  const dir = tempDir('status-shared');
  try {
    const a = await sharedLane(w, 'a');
    const repo = w.folder('lanski');
    const spec = sharedSpec(dir, { stop: 'echo docker is not running >&2; exit 3' });
    await startSharedForLane(sharedDeps(w), w.registry(), a, [spec]);
    assert.ok(parkNow(w.registry(), a));
    await w.clock.advance(SHARED_IDLE_MS);
    const failed = await stopUnneededShared(sharedDeps(w), w.registry());
    assert.deepEqual(
      failed.map(s => s.outcome),
      ['failed'],
    );
    const failedAt = w.clock.now();
    assert.deepEqual(sharedBlock(await run(w, 'status')), [
      `shared service db: running, used by no lane; stops ${formatTime(failedAt + SHARED_STOP_RETRY_MS)} (in 1m)`,
      `      repository   lanski  (${repo})   running since ${formatTime(failedAt)}`,
      `      stop failed  1 time: stop exited 3: ${spec.stop}; the sweep tries it again then`,
      `      log          ${sharedLog(w.dir, { repository: repo, name: 'db' })}`,
    ]);
  } finally {
    w.close();
  }
});

test('lanes --json carries each shared service under shared: its lane ids, state, times in ms and problem', async () => {
  const w = world();
  const dir = tempDir('status-shared');
  try {
    const a = await sharedLane(w, 'a');
    const b = await sharedLane(w, 'b');
    const repo = w.folder('lanski');
    const startedAt = w.clock.now();
    for (const ref of [a, b]) await startSharedForLane(sharedDeps(w), w.registry(), ref, [sharedSpec(dir)]);
    assert.ok(parkNow(w.registry(), b));
    const parkedAt = w.clock.now();
    const report = JSON.parse(await run(w, 'lanes', ['--json'])) as { shared: Record<string, unknown>[] };
    assert.equal(report.shared.length, 1);
    const [db] = report.shared;
    assert.deepEqual(
      {
        repository: db?.repository,
        name: db?.name,
        state: db?.state,
        since: db?.since,
        lanes: db?.lanes,
        holding: db?.holding,
        stopsAt: db?.stopsAt,
        problem: db?.problem,
        attempts: db?.attempts,
      },
      {
        repository: repo,
        name: 'db',
        state: 'running',
        since: startedAt,
        lanes: [a.id],
        holding: [],
        stopsAt: null,
        problem: null,
        attempts: 0,
      },
    );
    assert.ok(parkNow(w.registry(), a));
    const idle = (JSON.parse(await run(w, 'lanes', ['--json'])) as { shared: Record<string, unknown>[] }).shared[0];
    assert.deepEqual([idle?.lanes, idle?.unneededSince, idle?.stopsAt], [[], parkedAt, parkedAt + SHARED_IDLE_MS]);
  } finally {
    w.close();
  }
});

test('status and lanes --json read a 0.5.x registry as it is: no shared services, and the file is not upgraded', async () => {
  const w = world();
  try {
    fs.mkdirSync(w.dir, { recursive: true });
    const old = new DatabaseSync(databasePath(w.dir));
    old.exec(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'registry-0.5.1.sql'), 'utf8'));
    old.exec('PRAGMA user_version = 1');
    old.close();
    const before = fs.readFileSync(databasePath(w.dir));

    const stdout = await run(w, 'status');
    assert.match(stdout, /^no lanes$/m);
    assert.doesNotMatch(stdout, /shared service/);
    const report = JSON.parse(await run(w, 'lanes', ['--json'])) as { lanes: unknown[]; shared: unknown[] };
    assert.deepEqual([report.lanes, report.shared], [[], []]);

    assert.deepEqual(fs.readFileSync(databasePath(w.dir)), before);
    const db = new DatabaseSync(databasePath(w.dir));
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(r => String(r.name));
      assert.ok(!tables.includes('shared_services') && !tables.includes('shared_needs'), tables.join(', '));
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('resources')")
        .all()
        .map(r => String(r.name));
      assert.ok(!columns.includes('repository') && !columns.includes('needs'), columns.join(', '));
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});

test('status upgrades a registry older than 0.5.x, which lacks tables status reads, before reading it', async () => {
  const w = world();
  try {
    fs.mkdirSync(w.dir, { recursive: true });
    const old = new DatabaseSync(databasePath(w.dir));
    old.exec(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'registry-0.5.1.sql'), 'utf8'));
    old.exec('DROP TABLE holds; DROP TABLE owner_checks; DROP TABLE parks');
    old.exec('PRAGMA user_version = 1');
    old.close();

    assert.match(await run(w, 'status'), /^no lanes$/m);
    const db = new DatabaseSync(databasePath(w.dir));
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(r => String(r.name));
      for (const t of ['parks', 'holds', 'owner_checks', 'shared_services']) assert.ok(tables.includes(t), t);
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});

test('status prints no shared service line when there are none', async () => {
  const w = world();
  try {
    await sharedLane(w, 'a');
    assert.doesNotMatch(await run(w, 'status'), /shared service/);
  } finally {
    w.close();
  }
});
