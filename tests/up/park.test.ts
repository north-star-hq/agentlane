import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { browserPaths } from '../../src/browser/paths.ts';
import { lookAtBrowser } from '../../src/browser/screen.ts';
import { systemClock } from '../../src/clock.ts';
import { identityOf, systemProcesses, type ProcessIdentity } from '../../src/processes.ts';
import type { Owner } from '../../src/registry/owner.ts';
import { databasePath } from '../../src/registry/paths.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus, Registry } from '../../src/registry/registry.ts';
import type { Lane, LaneStatus } from '../../src/registry/types.ts';
import { runRegistryCommand, type CliDeps } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { execInLane } from '../../src/up/exec.ts';
import { laneDir, lastCallFile } from '../../src/up/lane-files.ts';
import { runSweep } from '../../src/up/sweep.ts';
import { up } from '../../src/up/up.ts';
import { FakeClock, type FakeDevices } from '../support/fakes.ts';
import { alive, BUNDLE, CONFIG, OPTIONS, until, world, type World } from '../support/up-world.ts';

const IDLE = 31 * 60_000;

function deviceConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...CONFIG,
    app: { ...CONFIG.app, launch: 'hook' },
    services: {},
    hooks: { build: CONFIG.hooks.build, launch: 'echo launched >> launch.log' },
    preconditions: [],
    ...over,
  };
}

function simulators(w: World): FakeDevices {
  const ios = w.deps().devices.ios;
  assert.ok(ios);
  return ios as FakeDevices;
}

function deviceWorld(t: Parameters<typeof world>[0], config: Record<string, unknown> = deviceConfig()): World {
  const w = world(t);
  w.write(config);
  simulators(w).during = (call, id) => {
    if (call === 'shutdown' && w.sim.devices.get(id)?.info.state === 'Booted') void w.sim.shutdown(id);
  };
  return w;
}

function launches(w: World): number {
  return fs.existsSync(path.join(w.project, 'launch.log')) ? w.read('launch.log').trim().split('\n').length : 0;
}

function age(w: World, lane: { id: string }, ms = IDLE): void {
  const db = new DatabaseSync(databasePath(w.state), { timeout: 5000 });
  try {
    db.prepare("UPDATE claims SET last_used_at = ?, last_action = 'aged' WHERE id = ?").run(Date.now() - ms, lane.id);
  } finally {
    db.close();
  }
  fs.rmSync(lastCallFile(laneDir(w.state, lane.id)), { force: true });
}

function sweep(w: World) {
  const deps = w.deps();
  return runSweep({
    dir: w.state,
    env: deps.env,
    processes: systemProcesses,
    system: realServiceSystem,
    clock: systemClock,
    devices: deps.devices,
    ports: tcpProbe,
    browser: w.browser,
  });
}

function laneOf(w: World, id: string): LaneStatus {
  const lane = readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes.find(c => c.id === id);
  assert.ok(lane, `lane ${id} is gone`);
  return lane;
}

async function parked(w: World, lane: Lane): Promise<void> {
  age(w, lane);
  const report = await sweep(w);
  assert.deepEqual(
    report.outcomes.map(o => [o.kind, o.lane]),
    [['parked', lane.id]],
    JSON.stringify(report),
  );
  assert.equal(laneOf(w, lane.id).park?.state, 'parked');
}

function cliDeps(w: World, out: string[]): CliDeps {
  const deps = w.deps();
  return {
    env: deps.env,
    cwd: w.project,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: deps.devices,
  };
}

test('a call on a parked lane brings back its device and its app first, then runs as it would have', async t => {
  const w = deviceWorld(t);
  const first = await up(w.deps(), OPTIONS);
  const udid = first.lane.device?.id ?? '';
  assert.equal(launches(w), 1);

  await parked(w, first.lane);
  const parkedLane = laneOf(w, first.lane.id);
  assert.equal(parkedLane.device, null);
  assert.equal(w.sim.devices.get(udid)?.info.state, 'Shutdown');
  assert.deepEqual(parkedLane.ports, first.lane.ports);

  w.lines.length = 0;
  const marker = path.join(w.root, 'ran');
  assert.equal(await execInLane(w.deps(), ['sh', '-c', `echo "$AGENTLANE_DEVICE" > '${marker}'`]), 0, w.lines.join('\n'));
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), udid, 'the command ran with the lane device it got back');
  assert.equal(w.sim.devices.get(udid)?.info.state, 'Booted');
  assert.equal(launches(w), 2);
  const awake = laneOf(w, first.lane.id);
  assert.equal(awake.park, null);
  assert.equal(awake.device?.id, udid);
  assert.ok(
    w.lines.some(l => l.includes(`lane ${first.lane.id} was parked`) && l.includes(`the app ${BUNDLE}`)),
    w.lines.join('\n'),
  );
  assert.ok(!w.lines.some(l => l.includes('up: setup')), 'the wake ran setup');
});

test('a parked lane keeps its resources: the wake runs no create, the park and the wake run no teardown, and the call sees the same values', async t => {
  const w = deviceWorld(t);
  const trace = path.join(w.root, 'resources.trace');
  w.write(
    deviceConfig({
      resources: {
        db: {
          create: `echo "create $AGENTLANE_LANE" >> '${trace}' && echo "DATABASE_URL=file:db-$AGENTLANE_LANE" >> "$AGENTLANE_EXPORTS"`,
          exports: ['DATABASE_URL'],
          teardown: `echo "teardown $AGENTLANE_LANE" >> '${trace}'`,
        },
      },
      hooks: { build: CONFIG.hooks.build, launch: 'echo launched >> launch.log', teardown: `echo "teardown hook" >> '${trace}'` },
    }),
  );
  const first = await up(w.deps(), OPTIONS);
  const values = first.lane.resources;
  await parked(w, first.lane);
  assert.deepEqual(laneOf(w, first.lane.id).resources, values);
  const seen = path.join(w.root, 'seen');
  assert.equal(await execInLane(w.deps(), ['sh', '-c', `echo "$DATABASE_URL" > '${seen}'`]), 0, w.lines.join('\n'));
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), `file:db-${first.lane.id}`);
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), [`create ${first.lane.id}`]);
  assert.deepEqual(laneOf(w, first.lane.id).resources, values);
});

test('two calls racing to wake one lane bring its device and app back once', async t => {
  const w = deviceWorld(t);
  const first = await up(w.deps(), OPTIONS);
  await parked(w, first.lane);
  const boots = () => w.sim.calls.filter(c => c.startsWith('boot ')).length;
  const before = boots();
  const codes = await Promise.all([execInLane(w.deps(), ['true']), execInLane(w.deps(), ['true'])]);
  assert.deepEqual(codes, [0, 0], w.lines.join('\n'));
  assert.equal(boots() - before, 1);
  assert.equal(launches(w), 2);
  assert.equal(w.lines.filter(l => l.includes(`lane ${first.lane.id} was parked`)).length, 1);
  assert.equal(laneOf(w, first.lane.id).park, null);
});

async function identityOfChild(child: ChildProcess): Promise<ProcessIdentity> {
  const found: ProcessIdentity[] = [];
  await until(() => {
    const identity = identityOf(systemProcesses, child.pid ?? 0);
    if (identity) found.push(identity);
    return identity !== undefined;
  });
  const [identity] = found;
  assert.ok(identity);
  return identity;
}

async function otherOwner(): Promise<{ owner: Owner; stop: () => void }> {
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  const identity = await identityOfChild(sleeper);
  return {
    owner: { kind: 'process', process: identity, sessionId: null, threadId: null },
    stop: () => {
      sleeper.kill('SIGKILL');
    },
  };
}

function registryOf(w: World, clock = systemClock): Registry {
  const deps = w.deps();
  return Registry.open({ dir: w.state, processes: systemProcesses, ports: tcpProbe, devices: deps.devices, clock });
}

function onePool(w: World): void {
  const file = path.join(w.state, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), poolSize: 1 }));
}

test('a wake with the pool full waits for a device, as up does, and the call goes on once one frees', async t => {
  const w = deviceWorld(t);
  onePool(w);
  const first = await up(w.deps(), OPTIONS);
  await parked(w, first.lane);
  const other = await otherOwner();
  const registry = registryOf(w);
  try {
    const taken = await registry.claim({
      owner: other.owner,
      worktree: w.root,
      projectRoot: w.root,
      services: [],
      device: { platform: 'ios' },
      waitMs: 0,
    });
    assert.equal(taken.lane.device?.id, first.lane.device?.id);
    let done = false;
    const call = execInLane(w.deps({ pollMs: 50 }), ['true']).finally(() => {
      done = true;
    });
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(done, false, 'the call ran on a lane with no device');
    assert.equal(laneOf(w, first.lane.id).park?.state, 'waking');
    registry.release({ id: taken.lane.id, token: taken.lane.token }, other.owner);
    assert.equal(await call, 0, w.lines.join('\n'));
    assert.equal(laneOf(w, first.lane.id).device?.id, first.lane.device?.id);
    assert.equal(laneOf(w, first.lane.id).park, null);
  } finally {
    registry.close();
    other.stop();
  }
});

test('a wake that gets no device within its wait fails the call, leaves the lane parked with the failure, and the next call brings it back', async t => {
  const w = deviceWorld(t);
  onePool(w);
  const first = await up(w.deps(), OPTIONS);
  await parked(w, first.lane);
  const other = await otherOwner();
  const registry = registryOf(w);
  try {
    const taken = await registry.claim({
      owner: other.owner,
      worktree: w.root,
      projectRoot: w.root,
      services: [],
      device: { platform: 'ios' },
      waitMs: 0,
    });
    const clock = new FakeClock(Date.now());
    const call = { settled: false };
    const outcome = execInLane(w.deps({ clock, pollMs: 1000 }), ['true']).then(
      () => {
        call.settled = true;
        return null;
      },
      (error: unknown) => {
        call.settled = true;
        return error;
      },
    );
    while (!call.settled) {
      await clock.advance(60_000);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const error = await outcome;
    assert.ok(error instanceof Error);
    assert.match(error.message, /could not bring lane \w+ back: no pool simulator is free/);
    const park = laneOf(w, first.lane.id).park;
    assert.equal(park?.state, 'parked');
    assert.match(park.problems.join('\n'), /the last call could not bring it back: no pool simulator is free/);

    registry.release({ id: taken.lane.id, token: taken.lane.token }, other.owner);
    assert.equal(await execInLane(w.deps(), ['true']), 0, w.lines.join('\n'));
    assert.equal(laneOf(w, first.lane.id).park, null);
    assert.equal(laneOf(w, first.lane.id).device?.id, first.lane.device?.id);
  } finally {
    registry.close();
    other.stop();
  }
});

test("a wake whose service won't start fails the call and leaves the lane parked with the failure; once that is fixed the next call wakes it", async t => {
  const w = deviceWorld(t);
  const first = await up(w.deps(), OPTIONS);
  await parked(w, first.lane);
  w.write(deviceConfig({ services: { broken: { type: 'api', start: 'exit 3', ready: { kind: 'tcp' }, timeoutSeconds: 2 } } }));
  await assert.rejects(execInLane(w.deps(), ['true']), /could not bring lane \w+ back: service broken/);
  const park = laneOf(w, first.lane.id).park;
  assert.equal(park?.state, 'parked');
  assert.match(park.problems.join('\n'), /service broken/);
  w.write(deviceConfig());
  assert.equal(await execInLane(w.deps(), ['true']), 0, w.lines.join('\n'));
  assert.equal(laneOf(w, first.lane.id).park, null);
});

test('a call that arrives while its lane is being parked waits for the park to finish, then wakes the lane', async t => {
  const w = deviceWorld(t);
  const first = await up(w.deps(), OPTIONS);
  const stubborn = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { detached: true, stdio: 'ignore' });
  try {
    const identity = await identityOfChild(stubborn);
    const registry = registryOf(w);
    try {
      registry.recordProcess(
        { id: first.lane.id, token: first.lane.token },
        { service: 'stubborn', pid: identity.pid, start: identity.start, cwd: null },
      );
    } finally {
      registry.close();
    }
    age(w, first.lane);
    const order: string[] = [];
    const parking = sweep(w).then(report => {
      order.push('parked');
      return report;
    });
    await until(() => laneOf(w, first.lane.id).park?.state === 'parking');
    const call = execInLane(w.deps(), ['true']).then(code => {
      order.push('called');
      return code;
    });
    const report = await parking;
    assert.deepEqual(
      report.outcomes.map(o => o.kind),
      ['parked'],
    );
    assert.equal(await call, 0, w.lines.join('\n'));
    assert.deepEqual(order, ['parked', 'called']);
    assert.equal(launches(w), 2);
    assert.equal(laneOf(w, first.lane.id).park, null);
    assert.equal(laneOf(w, first.lane.id).device?.id, first.lane.device?.id);
  } finally {
    stubborn.kill('SIGKILL');
  }
});

test('status and lanes --json show a parked lane, since when, and what its next call brings back; doctor says it is parked', async t => {
  const w = deviceWorld(t);
  const first = await up(w.deps(), OPTIONS);
  const device = first.lane.device;
  assert.ok(device);
  await parked(w, first.lane);

  const out: string[] = [];
  assert.equal(await runRegistryCommand('status', [], cliDeps(w, out)), 0);
  const text = out.join('');
  assert.match(
    text,
    new RegExp(
      `parked {7}since \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} \\(\\d+s ago\\); its next call brings back an iOS simulator ${device.name} \\(iPhone 17, iOS 26\\.5\\), the app ${BUNDLE.replaceAll('.', '\\.')}`,
    ),
  );

  out.length = 0;
  assert.equal(await runRegistryCommand('lanes', ['--json'], cliDeps(w, out)), 0);
  const json = JSON.parse(out.join('')) as { lanes: LaneStatus[] };
  const lane = json.lanes.find(c => c.id === first.lane.id);
  assert.ok(lane?.park);
  assert.equal(lane.park.state, 'parked');
  assert.equal(typeof lane.park.parkedAt, 'number');
  assert.equal(lane.park.by, null);
  const { device: gave, ...rest } = lane.park.restarts;
  assert.deepEqual(rest, { services: [], browser: null, app: BUNDLE });
  assert.deepEqual(gave && { ...gave, booted: undefined }, {
    platform: 'ios',
    name: device.name,
    id: device.id,
    deviceType: device.deviceType,
    deviceTypeName: device.deviceTypeName,
    runtime: device.runtime,
    runtimeName: device.runtimeName,
    booted: undefined,
  });
  assert.equal(typeof gave?.booted, 'boolean');
  assert.deepEqual(lane.park.problems, []);

  out.length = 0;
  const deps: EnvDeps = w.deps();
  assert.equal(await runUpCommand('doctor', [], deps, text => out.push(text)), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`warn {2}parked: lane ${first.lane.id} has been parked since`));
  assert.equal(laneOf(w, first.lane.id).park?.state, 'parked', 'doctor brought the lane back');
});

test('up on a parked lane brings it back and records it as awake', async t => {
  const w = deviceWorld(t);
  const first = await up(w.deps(), OPTIONS);
  await parked(w, first.lane);
  const again = await up(w.deps(), { ...OPTIONS, setup: false });
  assert.equal(again.lane.id, first.lane.id);
  assert.equal(again.lane.device?.id, first.lane.device?.id);
  assert.equal(laneOf(w, first.lane.id).park, null);
});

const SIGNIN_SITE = path.join(import.meta.dirname, '..', 'fixtures', 'signin-site');

test("a browser lane's park stops its browser and its web service but keeps the login, and its next call opens both again", async t => {
  const w = world(t);
  for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(SIGNIN_SITE, file), path.join(w.project, file));
  w.write({
    web: { service: 'site', browser: { driver: 'playwright' } },
    services: {
      site: { type: 'web', start: 'exec node site.ts', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 10 },
    },
    hooks: { signin: 'node signin.ts' },
  });
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, w.lines.join('\n'));
  const session = first.lane.browser?.session ?? '';
  const login = browserPaths(w.state, first.lane.id, session).storageState;
  const servicePid = laneOf(w, first.lane.id).processes.find(p => p.service === 'site')?.pid;
  assert.ok(servicePid !== undefined && w.browser.sessions.has(session));

  await parked(w, first.lane);
  const resting = laneOf(w, first.lane.id);
  assert.equal(w.browser.sessions.has(session), false, 'the browser still runs');
  assert.deepEqual(resting.processes, []);
  assert.equal(alive(servicePid), false, 'the web service still runs');
  assert.ok(fs.existsSync(login), 'the park forgot the saved login');
  assert.deepEqual(resting.park?.restarts, { device: null, services: ['site'], browser: 'playwright', app: null });
  assert.deepEqual(resting.ports, first.lane.ports);
  assert.equal(resting.browser?.session, session);

  assert.equal(await execInLane(w.deps(), ['true']), 0, w.lines.join('\n'));
  assert.ok(w.browser.sessions.has(session), 'the call ran with no browser');
  assert.equal(laneOf(w, first.lane.id).park, null);
  assert.equal((await fetch(`${first.url ?? ''}health`)).status, 200);
  const browser = first.lane.browser;
  assert.ok(browser);
  const text = (
    await lookAtBrowser({ tools: w.browser, stateDir: w.state, lane: { ...first.lane, browser }, env: w.deps().env }, {})
  ).text;
  assert.match(text, new RegExp(`Signed in as agent-${first.lane.id}`));
  assert.deepEqual(laneOf(w, first.lane.id).ports, first.lane.ports);
});
