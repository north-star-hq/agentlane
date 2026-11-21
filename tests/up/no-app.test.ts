import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Clock } from '../../src/clock.ts';
import { systemClock } from '../../src/clock.ts';
import { systemProcesses } from '../../src/processes.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus, Registry } from '../../src/registry/registry.ts';
import { SHARED_IDLE_MS } from '../../src/registry/shared.ts';
import { laneLastCall } from '../../src/registry/touch.ts';
import type { LaneStatus } from '../../src/registry/types.ts';
import { runRegistryCommand, type CliDeps } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import type { DoctorCheck } from '../../src/up/doctor.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { execInLane } from '../../src/up/exec.ts';
import { laneDir, readUpRecord } from '../../src/up/lane-files.ts';
import { runSweep } from '../../src/up/sweep.ts';
import { up, type UpOptions } from '../../src/up/up.ts';
import { FakeClock } from '../support/fakes.ts';
import { CONFIG, clockAt, failures, OPTIONS, toolchain, until, world, type World } from '../support/up-world.ts';

const DATA_ONLY: UpOptions = { ...OPTIONS, app: false };

/** A shared database server whose commands log what ran, and which runs while its `up` file exists. */
interface Db {
  up: string;
  lines: () => string[];
}

function db(w: World): Db {
  const dir = path.join(w.root, 'db');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'log');
  return {
    up: path.join(dir, 'up'),
    lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

/**
 * The iOS app of the world's config, with a driver, a precondition for iOS alone, a database its resource needs, and a
 * cache its api service needs.
 */
function dataConfig(d: Db): Record<string, unknown> {
  const log = path.join(path.dirname(d.up), 'log');
  const running = `test -f '${d.up}'`;
  const cache = path.join(path.dirname(d.up), 'cache-up');
  return {
    ...CONFIG,
    services: { ...CONFIG.services, api: { ...CONFIG.services.api, needs: ['cache'] } },
    hooks: { setup: CONFIG.hooks.setup, build: CONFIG.hooks.build, teardown: CONFIG.hooks.teardown },
    preconditions: [
      ...CONFIG.preconditions,
      { name: 'the iOS signing files are in place', run: 'test -f ios-ready', fix: 'touch ios-ready', platforms: ['ios'] },
    ],
    driver: {},
    shared: {
      db: {
        start: `echo start >> '${log}' && touch '${d.up}'`,
        stop: `echo stop >> '${log}' && rm -f '${d.up}'`,
        ready: running,
        timeoutSeconds: 5,
      },
      cache: {
        start: `echo cache-start >> '${log}' && touch '${cache}'`,
        stop: `echo cache-stop >> '${log}' && rm -f '${cache}'`,
        ready: `test -f '${cache}'`,
        timeoutSeconds: 5,
      },
    },
    resources: {
      appdb: {
        create: `${running} && echo "create $AGENTLANE_LANE" >> '${log}' && echo "DATABASE_URL=postgres://localhost/app-$AGENTLANE_LANE" >> "$AGENTLANE_EXPORTS"`,
        exports: ['DATABASE_URL'],
        teardown: `${running} && echo "teardown $AGENTLANE_LANE" >> '${log}'`,
        needs: ['db'],
      },
    },
  };
}

function databaseUrl(lane: { id: string }): string {
  return `postgres://localhost/app-${lane.id}`;
}

function lanes(w: World): LaneStatus[] {
  return readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes;
}

function only(w: World): LaneStatus {
  const all = lanes(w);
  assert.equal(all.length, 1, JSON.stringify(all.map(l => l.id)));
  const [lane] = all;
  assert.ok(lane);
  return lane;
}

function look<T>(w: World, read: (registry: Registry) => T): T {
  const registry = Registry.open({ dir: w.state, processes: systemProcesses, ports: tcpProbe, devices: w.deps().devices });
  try {
    return read(registry);
  } finally {
    registry.close();
  }
}

function service(w: World) {
  const [found] = look(w, r => r.sharedServices());
  assert.ok(found, 'no shared service is recorded');
  return found;
}

function holdsNothing(lane: LaneStatus): void {
  assert.deepEqual(
    { device: lane.device, browser: lane.browser, ports: lane.ports, processes: lane.processes },
    { device: null, browser: null, ports: [], processes: [] },
  );
}

function sweep(w: World, clock: Clock) {
  const deps = w.deps();
  return runSweep({
    dir: w.state,
    env: deps.env,
    processes: systemProcesses,
    system: realServiceSystem,
    clock,
    devices: deps.devices,
    ports: tcpProbe,
    browser: w.browser,
  });
}

/** A clock `offsetMs` ahead of the real one, for calls made after a sweep the test ran at a later moment. */
function ahead(offsetMs: number): Clock {
  return { now: () => Date.now() + offsetMs, sleep: ms => systemClock.sleep(ms) };
}

function cli(w: World, out: string[]): CliDeps {
  const deps = w.deps();
  return {
    env: deps.env,
    cwd: w.project,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: deps.devices,
    sim: w.sim,
    system: realServiceSystem,
    browser: w.browser,
  };
}

async function doctor(w: World): Promise<{ code: number; checks: DoctorCheck[] }> {
  const out: string[] = [];
  const code = await runUpCommand('doctor', ['--json'], w.deps(), text => out.push(text));
  return { code, checks: (JSON.parse(out.join('')) as { checks: DoctorCheck[] }).checks };
}

const APP_CHECK =
  /^(device|app|launch|bundler pin|dials|hygiene|service |browser|web app|Maestro|Xcode|simulator runtime|Java 17)/;

function noXcode(): EnvDeps['toolchain'] {
  return { ...toolchain(), xcodeVersion: () => Promise.reject(new Error('xcode-select: error: no developer tools were found')) };
}

test('up --no-app runs preflight, setup, the shared service the resource needs and the resource, and claims, builds, starts and launches nothing', async t => {
  const w = world(t);
  const d = db(w);
  w.write(dataConfig(d));
  const result = await up(w.deps({ toolchain: noXcode() }), DATA_ONLY);
  assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
  const { id } = result.lane;

  assert.deepEqual(
    result.steps.map(s => s.step),
    ['preflight', 'claim', 'setup', 'build preconditions', 'shared', 'resources', 'doctor'],
  );
  assert.equal(
    result.steps[0]?.detail,
    'hook locale; git is installed',
    'the device toolchain or the iOS precondition was checked',
  );
  assert.equal(result.steps[1]?.detail, `claimed lane ${id}: no device, browser or port`);
  assert.equal(result.platform, null);
  assert.equal(result.build, null);
  assert.equal(result.url, null);
  holdsNothing(only(w));
  assert.deepEqual(w.sim.calls, [], 'a simulator was touched');
  assert.deepEqual(w.driverStarts, []);
  assert.deepEqual(w.read('trace.log').trim().split('\n'), ['setup'], 'the build ran, or setup saw a device');

  assert.deepEqual(d.lines(), ['start', `create ${id}`], 'the cache the api service needs was started');
  assert.deepEqual([service(w).name, service(w).state, service(w).lanes], ['db', 'running', [id]]);
  assert.deepEqual(
    look(w, r => r.needsOf(id)),
    ['db'],
    'the lane counted what its services would need',
  );
  assert.equal(result.env.DATABASE_URL, databaseUrl(result.lane));
  assert.deepEqual(Object.keys(result.env).sort(), [
    'AGENTLANE_EVIDENCE',
    'AGENTLANE_LANE',
    'AGENTLANE_LANE_TOKEN',
    'AGENTLANE_LOGS',
    'AGENTLANE_WORKTREE',
    'DATABASE_URL',
  ]);
  const record = readUpRecord(laneDir(w.state, id));
  assert.deepEqual([record?.platform, record?.platforms], [null, []]);

  assert.deepEqual(
    result.doctor.checks.map(c => c.name).filter(name => APP_CHECK.test(name)),
    [],
  );
});

test('up --no-app prints the exports of the lane and its resource, and refuses --platform', async t => {
  const w = world(t);
  const d = db(w);
  w.write(dataConfig(d));
  const out: string[] = [];
  assert.equal(await runUpCommand('up', ['--no-app'], w.deps(), text => out.push(text)), 0, w.lines.join('\n'));
  const lane = only(w);
  const dir = laneDir(w.state, lane.id);
  const exports = out.join('').trim().split('\n');
  assert.deepEqual(
    exports.filter(line => !line.startsWith('export AGENTLANE_LANE_TOKEN=')),
    [
      `export AGENTLANE_LANE=${lane.id}`,
      `export AGENTLANE_WORKTREE=${w.project}`,
      `export AGENTLANE_LOGS=${dir}`,
      `export AGENTLANE_EVIDENCE=${path.join(dir, 'evidence')}`,
      `export DATABASE_URL=${databaseUrl(lane)}`,
    ],
  );
  assert.match(w.lines.join('\n'), /^ready$/m);

  w.lines.length = 0;
  assert.equal(await runUpCommand('up', ['--no-app', '--platform', 'ios'], w.deps(), () => undefined), 2);
  assert.match(w.lines.join('\n'), /--no-app and --platform are exclusive/);
  holdsNothing(only(w));
});

test('up --help names --no-app', () => {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'no-app-help-'));
  try {
    const help = spawnSync(process.execPath, [path.resolve('src/cli.ts'), 'up', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTLANE_STATE_DIR: state },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^ {15}--no-app {14}bring up the project's data alone/m);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("exec in a data-only lane gives its command the resource's value, never the caller's, and no app's variables, and keeps the lane in use while it runs", async t => {
  const w = world(t);
  const d = db(w);
  w.write(dataConfig(d));
  const result = await up(w.deps(), DATA_ONLY);
  assert.equal(result.doctor.ok, true, failures(result));
  const { id } = result.lane;

  const seen = path.join(w.root, 'exec.env');
  const flag = path.join(w.root, 'exec-may-end');
  const clock = new FakeClock(Date.now());
  const deps = w.deps({ clock, heartbeatMs: 20 });
  const running = execInLane({ ...deps, env: { ...deps.env, DATABASE_URL: 'postgres://elsewhere/theirs' } }, [
    'sh',
    '-c',
    'env > "$1.tmp" && mv "$1.tmp" "$1"; while [ ! -e "$2" ]; do sleep 0.02; done',
    'sh',
    seen,
    flag,
  ]);
  let code: number;
  try {
    await until(() => fs.existsSync(seen));
    await clock.advance(DEFAULT_CONFIG.parkMs + 60_000);
    await until(() => only(w).lastUsedAt === clock.now());
  } finally {
    fs.writeFileSync(flag, '');
    code = await running;
  }
  assert.equal(code, 0, w.lines.join('\n'));

  const vars = Object.fromEntries(
    fs
      .readFileSync(seen, 'utf8')
      .trim()
      .split('\n')
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  ) as Record<string, string>;
  assert.equal(vars.DATABASE_URL, databaseUrl(result.lane));
  assert.equal(vars.AGENTLANE_LANE, id);
  assert.deepEqual(
    Object.keys(vars).filter(name => /^AGENTLANE_(PLATFORM|DEVICE|VARIANT|WEB_URL|\w+_PORT)$/.test(name)),
    [],
  );
  const maestro = spawnSync(path.join(laneDir(w.state, id), 'bin', 'maestro'), ['test', 'flow.yaml'], { encoding: 'utf8' });
  assert.equal(maestro.status, 2);
  assert.equal(
    maestro.stderr,
    `agentlane: maestro is off in lane ${id}, because the lane holds no simulator or emulator\nto fix: node_modules/.bin/agentlane up   (it brings the app up in this lane, which has the project's data only)\n`,
  );
});

test('a data-only lane parks after the idle cutoff, its shared service stops 5 minutes later, and exec wakes it by starting that service again and nothing else', async t => {
  const w = world(t);
  const d = db(w);
  w.write(dataConfig(d));
  const result = await up(w.deps(), DATA_ONLY);
  assert.equal(result.doctor.ok, true, failures(result));
  const { id, token } = result.lane;
  const lastCall = laneLastCall(w.state, { id, token, lastUsedAt: only(w).lastUsedAt });
  const cutoff = lastCall + DEFAULT_CONFIG.parkMs;

  assert.deepEqual((await sweep(w, clockAt(cutoff - 1))).outcomes, [], 'the lane parked before its idle cutoff');
  assert.equal(only(w).park, null);
  assert.deepEqual(
    (await sweep(w, clockAt(cutoff + 1))).outcomes.map(o => [o.kind, o.lane]),
    [['parked', id]],
  );
  assert.equal(only(w).park?.state, 'parked');
  const since = service(w).unneededSince;
  assert.equal(since, cutoff + 1, 'the park did not mark the shared service as unneeded');
  assert.deepEqual((await sweep(w, clockAt(since + SHARED_IDLE_MS - 1))).shared, [], 'the sweep stopped it before 5 minutes');
  assert.equal(service(w).state, 'running');
  assert.deepEqual(
    (await sweep(w, clockAt(since + SHARED_IDLE_MS))).shared.map(s => `${s.name} ${s.outcome}`),
    ['db stopped'],
  );
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'stop']);

  w.lines.length = 0;
  const later = ahead(since + SHARED_IDLE_MS + 1000 - Date.now());
  assert.equal(await execInLane(w.deps({ clock: later }), ['test', '-f', d.up]), 0, w.lines.join('\n'));
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'stop', 'start']);
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane up: shared: db started (')),
    w.lines.join('\n'),
  );
  const woken = only(w);
  assert.equal(woken.id, id);
  assert.equal(woken.park, null);
  holdsNothing(woken);
  assert.deepEqual(w.sim.calls, []);
  assert.deepEqual([service(w).state, service(w).lanes, service(w).unneededSince], ['running', [id], null]);
  assert.deepEqual(readUpRecord(laneDir(w.state, id))?.platforms, []);
});

test('a plain up after up --no-app makes the lane a full one and keeps its resource and value; up --no-app then refuses the lane', async t => {
  const w = world(t);
  const d = db(w);
  w.write(dataConfig(d));
  const data = await up(w.deps(), DATA_ONLY);
  assert.equal(data.doctor.ok, true, failures(data));
  const { id } = data.lane;
  fs.writeFileSync(path.join(w.project, 'ios-ready'), '');

  const full = await up(w.deps(), OPTIONS);
  assert.equal(full.doctor.ok, true, `${failures(full)}\n${w.lines.join('\n')}`);
  assert.equal(full.lane.id, id);
  assert.equal(full.platform, 'ios');
  assert.equal(full.env.DATABASE_URL, databaseUrl(data.lane));
  assert.equal(full.steps.find(s => s.step === 'resources')?.detail, 'kept appdb from an earlier up of this lane');
  assert.deepEqual(
    d.lines(),
    ['start', `create ${id}`, 'cache-start'],
    'the resource was created again, the database restarted, or the cache the api service needs did not start',
  );
  assert.deepEqual(
    look(w, r => r.needsOf(id)),
    ['cache', 'db'],
  );
  const lane = only(w);
  assert.ok(lane.device, 'the full up claimed no simulator');
  assert.deepEqual(lane.ports.map(p => p.service).sort(), ['api', 'metro']);
  assert.deepEqual(lane.processes.map(p => p.service).sort(), ['api', 'metro']);
  assert.match(w.read('trace.log'), /^build$/m);
  assert.equal(w.driverStarts.length, 1);
  const record = readUpRecord(laneDir(w.state, id));
  assert.deepEqual([record?.platform, record?.platforms], ['ios', ['ios']]);

  w.lines.length = 0;
  assert.equal(await runUpCommand('up', ['--no-app'], w.deps(), () => undefined), 2);
  assert.match(
    w.lines.join('\n'),
    new RegExp(
      `this folder's lane ${id} was brought up for ios and holds ${lane.device.name}, ports for (api, metro|metro, api), and up --no-app brings up a lane with the project's data alone`,
    ),
  );
  assert.match(w.lines.join('\n'), /run the command under node_modules\/\.bin\/agentlane exec in this lane/);
  assert.deepEqual(only(w).device?.id, lane.device.id);
});

test('doctor on a data-only lane checks the lane, its resource and its shared service, and fails the shared line while its ready fails', async t => {
  const w = world(t);
  const d = db(w);
  w.write(dataConfig(d));
  const result = await up(w.deps(), DATA_ONLY);
  assert.equal(result.doctor.ok, true, failures(result));

  const healthy = await doctor(w);
  assert.equal(healthy.code, 0, JSON.stringify(healthy.checks));
  assert.deepEqual(
    healthy.checks.map(c => c.name),
    ['config', 'wiring', 'lane', 'hook locale', 'resource appdb', 'shared db'],
  );

  fs.rmSync(d.up);
  const down = await doctor(w);
  assert.equal(down.code, 1);
  assert.deepEqual(
    down.checks.filter(c => !c.ok).map(c => [c.name, c.fix]),
    [['shared db', 'node_modules/.bin/agentlane up (it starts db)']],
  );
});

test("release of a data-only lane runs the project's teardown hook and tears its resource down", async t => {
  const w = world(t);
  const d = db(w);
  w.write(dataConfig(d));
  const result = await up(w.deps(), DATA_ONLY);
  assert.equal(result.doctor.ok, true, failures(result));
  const { id } = result.lane;

  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource appdb \\(`));
  assert.deepEqual(d.lines(), ['start', `create ${id}`, `teardown ${id}`]);
  assert.match(w.read('trace.log'), new RegExp(`^teardown ${id}$`, 'm'));
  assert.deepEqual(lanes(w), []);
  assert.deepEqual(readRegistryStatus({ dir: w.state, processes: systemProcesses }).teardowns, []);
});

test('up --no-app in a project that declares no resources refuses before claiming anything', async t => {
  const w = world(t);
  const d = db(w);
  const config = dataConfig(d);
  delete config.resources;
  w.write(config);
  assert.equal(await runUpCommand('up', ['--no-app'], w.deps(), () => undefined), 2);
  assert.match(w.lines.join('\n'), /agentlane\.json declares no resources, so up --no-app has no data to bring up/);
  assert.match(w.lines.join('\n'), /declare the data under resources in agentlane\.json/);
  assert.deepEqual(lanes(w), []);
  assert.deepEqual(d.lines(), []);
});
