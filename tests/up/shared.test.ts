import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Clock } from '../../src/clock.ts';
import { systemClock } from '../../src/clock.ts';
import { identityOf, systemProcesses, type ProcessIdentity } from '../../src/processes.ts';
import { resolveOwner } from '../../src/registry/owner.ts';
import { RETURN_WINDOW_MS } from '../../src/registry/owner-checks.ts';
import { databasePath } from '../../src/registry/paths.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus, Registry } from '../../src/registry/registry.ts';
import { SHARED_IDLE_MS } from '../../src/registry/shared.ts';
import type { Lane } from '../../src/registry/types.ts';
import { runRegistryCommand, type CliDeps } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import { execInLane } from '../../src/up/exec.ts';
import { laneDir, lastCallFile } from '../../src/up/lane-files.ts';
import { SharedServiceFailed, startSharedForTeardown } from '../../src/up/shared.ts';
import { runSweep } from '../../src/up/sweep.ts';
import { up } from '../../src/up/up.ts';
import type { FakeDevices } from '../support/fakes.ts';
import { CONFIG, clockAt, failures, foundGoneAt, OPTIONS, sleeper, until, world, type World } from '../support/up-world.ts';

const SITE_SERVER = `import { createServer } from 'node:http';
createServer((req, res) => res.end('ok')).listen(Number(process.env.AGENTLANE_SITE_PORT), '127.0.0.1');
`;

/** A shared service whose commands log what ran, and which runs while its `up` file exists. */
interface Db {
  up: string;
  log: string;
  /** While this file exists, its start fails. */
  broken: string;
  /** While this file exists, the resource's teardown fails. */
  stuck: string;
  lines: () => string[];
}

function db(w: World): Db {
  const dir = path.join(w.root, 'db');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'log');
  return {
    up: path.join(dir, 'up'),
    log,
    broken: path.join(dir, 'broken'),
    stuck: path.join(dir, 'stuck'),
    lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

function shared(d: Db): Record<string, unknown> {
  return {
    db: {
      start: `if [ -f '${d.broken}' ]; then echo "cannot reach the docker daemon" >&2; exit 3; fi; echo start >> '${d.log}' && touch '${d.up}'`,
      stop: `echo stop >> '${d.log}' && rm -f '${d.up}'`,
      ready: `test -f '${d.up}'`,
      timeoutSeconds: 5,
    },
  };
}

interface Needs {
  resource?: string[];
  site?: string[];
}

/** A web app with a site and a resource, each of which fails without the shared service when it needs it. */
function webConfig(d: Db, needs: Needs = { resource: ['db'] }): Record<string, unknown> {
  const requires = (names: string[] = []) => (names.includes('db') ? `test -f '${d.up}' && ` : '');
  return {
    web: { path: '/' },
    services: {
      site: {
        type: 'web',
        start: `echo service >> '${d.log}' && ${requires(needs.site)}exec node site.mjs`,
        ready: { kind: 'http', path: '/' },
        timeoutSeconds: 10,
        needs: needs.site ?? [],
      },
    },
    shared: shared(d),
    resources: {
      appdb: {
        create: `${requires(needs.resource)}echo "create $AGENTLANE_LANE" >> '${d.log}' && echo "DATABASE_URL=db-$AGENTLANE_LANE" >> "$AGENTLANE_EXPORTS"`,
        exports: ['DATABASE_URL'],
        teardown: `if [ -f '${d.stuck}' ]; then echo "the database is busy" >&2; exit 4; fi; ${requires(needs.resource)}echo "teardown $AGENTLANE_LANE" >> '${d.log}'`,
        needs: needs.resource ?? [],
      },
    },
  };
}

function setUp(w: World, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(w.project, 'site.mjs'), SITE_SERVER);
  w.write(config);
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

function sweep(w: World, clock: Clock = systemClock) {
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

async function stops(w: World, at: number): Promise<string[]> {
  const report = await sweep(w, clockAt(at));
  return report.shared.map(s => `${s.name} ${s.outcome}`);
}

/** Checks the sweep leaves the shared service up to 5 minutes after nothing needed it, and stops it then. */
async function stopsFiveMinutesAfter(w: World, since: number): Promise<void> {
  assert.deepEqual(await stops(w, since + SHARED_IDLE_MS - 1), [], 'the sweep stopped it before 5 minutes');
  assert.equal(service(w).state, 'running');
  assert.deepEqual(await stops(w, since + SHARED_IDLE_MS), ['db stopped']);
  assert.equal(service(w).state, 'stopped');
}

function age(w: World, lane: { id: string }): void {
  const sql = new DatabaseSync(databasePath(w.state), { timeout: 5000 });
  try {
    sql.prepare("UPDATE claims SET last_used_at = ?, last_action = 'aged' WHERE id = ?").run(Date.now() - 31 * 60_000, lane.id);
  } finally {
    sql.close();
  }
  fs.rmSync(lastCallFile(laneDir(w.state, lane.id)), { force: true });
}

/** Parks the lane, then sweeps 5 minutes later, which stops the shared service it alone needed. */
async function parkedAndStopped(w: World, lane: Lane): Promise<void> {
  age(w, lane);
  const report = await sweep(w);
  assert.deepEqual(
    report.outcomes.map(o => [o.kind, o.lane]),
    [['parked', lane.id]],
    JSON.stringify(report),
  );
  const since = service(w).unneededSince;
  assert.ok(since !== null, 'the park did not mark the shared service as unneeded');
  await stopsFiveMinutesAfter(w, since);
}

function cli(w: World, out: string[], cwd = w.project, clock?: Clock): CliDeps {
  const deps = w.deps();
  return {
    env: deps.env,
    cwd,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: deps.devices,
    sim: w.sim,
    system: realServiceSystem,
    browser: w.browser,
    ...(clock ? { clock } : {}),
  };
}

function teardowns(w: World) {
  return readRegistryStatus({ dir: w.state, processes: systemProcesses }).teardowns;
}

test("up starts the shared service its resource needs before the create, in a step of its own, and the next up finds it running and doesn't start it again", async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, `${failures(first)}\n${w.lines.join('\n')}`);
  const id = first.lane.id;
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service']);
  assert.deepEqual(
    first.steps.map(s => s.step),
    ['preflight', 'claim', 'build preconditions', 'shared', 'resources', 'service site', 'browser', 'doctor'],
  );
  assert.ok(
    w.lines.some(l => /^agentlane up: shared: db started \(\d+\.\d s\)$/.test(l)),
    w.lines.join('\n'),
  );
  assert.ok(w.lines.some(l => l.startsWith('agentlane up: shared: starting shared service db: ')));
  assert.deepEqual(
    look(w, r => r.needsOf(id)),
    ['db'],
  );
  assert.deepEqual([service(w).state, service(w).lanes], ['running', [id]]);

  w.lines.length = 0;
  const second = await up(w.deps(), OPTIONS);
  assert.equal(second.lane.id, id);
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service'], 'the second up started the shared service again');
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane up: shared: db running (')),
    w.lines.join('\n'),
  );
});

test('a lane that needs no shared service runs the shared step as none needed and starts nothing; once it stops needing one, that one stops 5 minutes later', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d, {}));
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane up: shared: none needed (')),
    w.lines.join('\n'),
  );
  assert.deepEqual(d.lines(), [`create ${id}`, 'service']);
  assert.deepEqual(
    look(w, r => r.needsOf(id)),
    [],
  );
  assert.deepEqual(
    look(w, r => r.sharedServices()),
    [],
  );

  setUp(w, webConfig(d, { site: ['db'] }));
  fs.writeFileSync(d.up, '');
  w.lines.length = 0;
  await up(w.deps(), OPTIONS);
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane up: shared: db already up, so its start did not run (')),
    w.lines.join('\n'),
  );
  assert.deepEqual(
    look(w, r => r.needsOf(id)),
    ['db'],
  );
  assert.deepEqual([service(w).state, service(w).unneededSince], ['running', null]);

  setUp(w, webConfig(d, {}));
  w.lines.length = 0;
  await up(w.deps(), OPTIONS);
  assert.ok(w.lines.some(l => l.startsWith('agentlane up: shared: none needed (')));
  assert.deepEqual(
    look(w, r => r.needsOf(id)),
    [],
  );
  const since = service(w).unneededSince;
  assert.ok(since !== null, 'the up that stopped needing it did not mark it');
  await stopsFiveMinutesAfter(w, since);
  assert.deepEqual(d.lines(), [`create ${id}`, 'service', 'stop']);
});

test('a project that declares no shared service has no shared step', async t => {
  const w = world(t);
  const d = db(w);
  const config = webConfig(d, {});
  delete config.shared;
  setUp(w, config);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  assert.equal(
    result.steps.some(s => s.step === 'shared'),
    false,
  );
  assert.deepEqual(
    look(w, r => r.needsOf(result.lane.id)),
    [],
  );
});

test('a shared service that fails to start fails up with its name and the end of its output, runs no create, and keeps the lane for the next up', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  fs.writeFileSync(d.broken, '');
  await assert.rejects(up(w.deps(), OPTIONS), (error: unknown) => {
    assert.ok(error instanceof SharedServiceFailed, String(error));
    assert.equal(error.service, 'db');
    assert.match(error.message, /^shared service db: start exited 3: if \[ -f /);
    assert.match(error.message, /\n {2}\| cannot reach the docker daemon\n/);
    assert.match(error.message, /\nfull log: .*db\.log$/);
    return true;
  });
  assert.deepEqual(d.lines(), [], 'the create or a service ran after the shared start failed');
  const [lane] = readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes;
  assert.ok(lane);
  assert.deepEqual(lane.resources, []);
  assert.deepEqual(w.processes(), []);

  w.lines.length = 0;
  assert.equal(await runUpCommand('up', [], w.deps(), () => undefined), 1);
  assert.match(
    w.lines.join('\n'),
    /shared service db: start exited 3[\s\S]*the lane stays: fix this and run node_modules\/\.bin\/agentlane up again/,
  );

  fs.rmSync(d.broken);
  const fixed = await up(w.deps(), OPTIONS);
  assert.equal(fixed.doctor.ok, true, failures(fixed));
  assert.equal(fixed.lane.id, lane.id);
  assert.deepEqual(d.lines(), ['start', `create ${lane.id}`, 'service']);
});

test("waking a parked lane starts its shared service again, which the sweep stopped 5 minutes after the park, before the lane's services", async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d, { resource: ['db'], site: ['db'] }));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  await parkedAndStopped(w, first.lane);
  assert.deepEqual(d.lines(), ['start', `create ${first.lane.id}`, 'service', 'stop']);
  assert.equal(fs.existsSync(d.up), false);

  w.lines.length = 0;
  assert.equal(await execInLane(w.deps(), ['test', '-f', d.up]), 0, w.lines.join('\n'));
  assert.deepEqual(d.lines(), ['start', `create ${first.lane.id}`, 'service', 'stop', 'start', 'service']);
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane up: shared: db started (')),
    w.lines.join('\n'),
  );
  assert.equal(
    readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes.find(l => l.id === first.lane.id)?.park,
    null,
  );
  assert.deepEqual([service(w).state, service(w).lanes], ['running', [first.lane.id]]);
});

test('a wake whose shared service fails to start fails the call before any service starts and leaves the lane parked; the next call wakes it once it starts', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d, { resource: ['db'], site: ['db'] }));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  await parkedAndStopped(w, first.lane);
  fs.writeFileSync(d.broken, '');

  await assert.rejects(
    execInLane(w.deps(), ['true']),
    new RegExp(`could not bring lane ${first.lane.id} back: shared service db: start exited 3`),
  );
  const park = readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes.find(l => l.id === first.lane.id)?.park;
  assert.equal(park?.state, 'parked');
  assert.match(park.problems.join('\n'), /shared service db: start exited 3/);
  assert.deepEqual(d.lines(), ['start', `create ${first.lane.id}`, 'service', 'stop']);

  fs.rmSync(d.broken);
  assert.equal(await execInLane(w.deps(), ['test', '-f', d.up]), 0, w.lines.join('\n'));
  assert.deepEqual(d.lines().slice(-2), ['start', 'service']);
});

test('a lane brought up for two platforms keeps needing what the first one runs, and its wake starts the shared service once', async t => {
  const w = world(t);
  const d = db(w);
  const ios = w.deps().devices.ios as FakeDevices;
  ios.during = (call, udid) => {
    if (call === 'shutdown' && w.sim.devices.get(udid)?.info.state === 'Booted') void w.sim.shutdown(udid);
  };
  const site = (webConfig(d).services as { site: Record<string, unknown> }).site;
  setUp(w, {
    ...CONFIG,
    app: { ...CONFIG.app, launch: 'hook' },
    web: { service: 'site' },
    services: { site: { ...site, platforms: ['web'], needs: ['db'] } },
    hooks: { build: CONFIG.hooks.build, launch: 'echo launched >> launch.log' },
    preconditions: [],
    shared: shared(d),
  });
  const web = await up(w.deps(), { ...OPTIONS, platform: 'web' });
  assert.equal(web.doctor.ok, true, failures(web));
  const mobile = await up(w.deps(), { ...OPTIONS, platform: 'ios' });
  assert.equal(mobile.lane.id, web.lane.id);
  assert.ok(mobile.lane.device);
  assert.deepEqual(
    look(w, r => r.needsOf(web.lane.id)),
    ['db'],
    'the ios up dropped what the web services need',
  );
  assert.deepEqual(d.lines(), ['start', 'service']);

  await parkedAndStopped(w, web.lane);
  w.lines.length = 0;
  assert.equal(await execInLane(w.deps(), ['test', '-f', d.up]), 0, w.lines.join('\n'));
  assert.deepEqual(d.lines(), ['start', 'service', 'stop', 'start', 'service']);
  assert.deepEqual(
    w.lines.filter(l => l.startsWith('agentlane up: shared: db ')).map(l => l.replace(/ \(\d+\.\d s\)$/, '')),
    ['agentlane up: shared: db started', 'agentlane up: shared: db running'],
  );
});

test('a wake of a lane up never ran records no shared service it needs', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d, { resource: ['db'], site: ['db'] }));
  const registry = Registry.open({ dir: w.state, processes: systemProcesses, ports: tcpProbe, devices: w.deps().devices });
  let lane: Lane;
  try {
    const request = {
      owner: resolveOwner(w.deps().env, systemProcesses),
      worktree: w.project,
      projectRoot: w.project,
      services: [],
      device: null,
      waitMs: 0,
    };
    lane = (await registry.claim(request)).lane;
  } finally {
    registry.close();
  }
  age(w, lane);
  assert.deepEqual(
    (await sweep(w)).outcomes.map(o => [o.kind, o.lane]),
    [['parked', lane.id]],
  );
  assert.equal(await execInLane(w.deps(), ['true']), 0, w.lines.join('\n'));
  assert.equal(readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes.find(l => l.id === lane.id)?.park, null);
  assert.deepEqual(
    look(w, r => r.needsOf(lane.id)),
    [],
  );
  assert.deepEqual(
    look(w, r => r.sharedServices()),
    [],
  );
  assert.deepEqual(d.lines(), []);
});

test('release of a lane whose shared service the sweep stopped starts it before the teardown, and it stops 5 minutes after', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  await parkedAndStopped(w, result.lane);

  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`lane ${id}: resource appdb: starting shared service db: `));
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource appdb \\(`));
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service', 'stop', 'start', `teardown ${id}`]);
  assert.deepEqual(teardowns(w), []);
  const since = service(w).unneededSince;
  assert.ok(since !== null, 'the teardown did not mark the shared service as unneeded');
  await stopsFiveMinutesAfter(w, since);
  assert.deepEqual(d.lines().slice(-1), ['stop']);
});

test('a reap starts the shared service the sweep stopped after the park before the teardown, and it stops 5 minutes after', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const owner = sleeper();
  t.after(() => owner.kill('SIGKILL'));
  const result = await up(w.deps({ owner: owner.pid ?? 0 }), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  const reaped = new Promise(resolve => owner.once('exit', resolve));
  owner.kill('SIGKILL');
  await reaped;

  const other = fs.mkdtempSync(path.join(w.root, 'other-'));
  const out: string[] = [];
  assert.equal(
    await runRegistryCommand('claim', ['--worktree', other, '--services', 'none', '--no-device'], cli(w, out, other)),
    0,
    out.join(''),
  );
  const found = foundGoneAt(w, id);
  assert.equal(await runRegistryCommand('reap', [], cli(w, out, other)), 0, out.join(''));
  const parkedSince = service(w).unneededSince;
  assert.ok(parkedSince !== null);
  await stopsFiveMinutesAfter(w, parkedSince);
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service', 'stop']);

  out.length = 0;
  const at = found + RETURN_WINDOW_MS;
  assert.equal(await runRegistryCommand('reap', [], cli(w, out, other, clockAt(at))), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`ended lane ${id}: its owner was found gone`));
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource appdb`));
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service', 'stop', 'start', `teardown ${id}`]);
  assert.deepEqual(teardowns(w), []);
  assert.equal(service(w).unneededSince, at);
  await stopsFiveMinutesAfter(w, at);
});

test('a teardown kept after it failed is retried by a later pass with its shared service started again, which stops 5 minutes after', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  fs.writeFileSync(d.stuck, '');
  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 1);
  assert.match(out.join(''), /resource appdb: teardown exited 4 \(attempt 1\)/);
  const failedAt = service(w).unneededSince;
  assert.ok(failedAt !== null, 'the failed teardown did not mark the shared service as unneeded');
  await stopsFiveMinutesAfter(w, failedAt);

  fs.rmSync(d.stuck);
  out.length = 0;
  assert.equal(await runRegistryCommand('release', [id], cli(w, out)), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource appdb`));
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service', 'stop', 'start', `teardown ${id}`]);
  assert.deepEqual(teardowns(w), []);
  const since = service(w).unneededSince;
  assert.ok(since !== null);
  await stopsFiveMinutesAfter(w, since);
});

test("a teardown whose shared service fails to start does not run, keeps its record with the shared service's problem, and runs once it starts", async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  await parkedAndStopped(w, result.lane);
  fs.writeFileSync(d.broken, '');

  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 1);
  const said = out.join('');
  assert.match(
    said,
    new RegExp(
      `lane ${id}: PROBLEM: resource appdb: teardown did not run, since shared service db did not start \\(attempt 1\\): start exited 3: if \\[ -f `,
    ),
  );
  assert.match(said, /\| cannot reach the docker daemon/);
  assert.match(said, /full log: .*db\.log/);
  assert.match(
    said,
    new RegExp(
      `its record is kept: the next release or reap tries again, and node_modules/.bin/agentlane release ${id} runs it now`,
    ),
  );
  const [kept] = teardowns(w);
  assert.deepEqual([kept?.lane, kept?.name, kept?.attempts], [id, 'appdb', 1]);
  assert.match(kept?.problem ?? '', /^teardown did not run, since shared service db did not start: start exited 3: if \[ -f /);
  assert.equal(
    d.lines().some(l => l.startsWith('teardown')),
    false,
  );
  const failed = service(w);
  assert.deepEqual([failed.state, failed.problem?.split(':')[0]], ['running', 'start exited 3']);
  assert.ok(failed.unneededSince !== null, 'the failed teardown did not mark the shared service as unneeded');
  await stopsFiveMinutesAfter(w, failed.unneededSince);
  assert.deepEqual(d.lines().slice(-1), ['stop']);

  fs.rmSync(d.broken);
  out.length = 0;
  assert.equal(await runRegistryCommand('release', [id], cli(w, out)), 0, out.join(''));
  assert.deepEqual(d.lines().slice(-2), ['start', `teardown ${id}`]);
  assert.deepEqual(teardowns(w), []);
});

async function deadProcess(): Promise<ProcessIdentity> {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  const found: ProcessIdentity[] = [];
  await until(() => {
    const identity = identityOf(systemProcesses, child.pid ?? 0);
    if (identity) found.push(identity);
    return identity !== undefined;
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const [identity] = found;
  assert.ok(identity);
  return identity;
}

test('a teardown whose process died mid-run is taken over by the next pass, which starts the shared service the sweep stopped meanwhile', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  look(w, r => r.release({ id, token: result.lane.token }, result.lane.owner));

  const dead = await deadProcess();
  const dying = Registry.open({
    dir: w.state,
    processes: systemProcesses,
    ports: tcpProbe,
    devices: w.deps().devices,
    self: dead,
  });
  try {
    const [held] = dying.takeTeardowns();
    assert.ok(held);
    assert.deepEqual(
      (await startSharedForTeardown({ env: w.deps().env, clock: systemClock }, dying, held)).map(s => s.outcome),
      ['kept'],
    );
  } finally {
    dying.close();
  }
  assert.deepEqual(service(w).holding, [{ lane: id, resource: 'appdb' }]);

  const later = Date.now() + 60 * 60_000;
  assert.deepEqual(await stops(w, later), []);
  assert.deepEqual(await stops(w, later + SHARED_IDLE_MS), ['db stopped']);
  assert.deepEqual(
    teardowns(w).map(td => [td.lane, td.name]),
    [[id, 'appdb']],
  );

  const other = fs.mkdtempSync(path.join(w.root, 'other-'));
  const out: string[] = [];
  assert.equal(
    await runRegistryCommand('claim', ['--worktree', other, '--services', 'none', '--no-device'], cli(w, out, other)),
    0,
    out.join(''),
  );
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource appdb`));
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service', 'stop', 'start', `teardown ${id}`]);
  assert.deepEqual(teardowns(w), []);
});

/** The config with its resource using the shared service without naming it in needs, as before the project declared it shared. */
function undeclared(config: Record<string, unknown>): Record<string, unknown> {
  const { appdb } = config.resources as { appdb: Record<string, unknown> };
  return { ...config, resources: { appdb: { ...appdb, needs: [] } } };
}

/** Each resource row's name, its needs, and whether its repository is its lane's. */
function resourceRows(w: World): unknown[][] {
  const sql = new DatabaseSync(databasePath(w.state), { timeout: 5000 });
  try {
    return sql
      .prepare(
        'SELECT r.name, r.needs, r.repository = c.project_root AS ours FROM resources r JOIN claims c ON c.id = r.claim_id ORDER BY r.seq',
      )
      .all()
      .map(row => [row.name, row.needs, row.ours]);
  } finally {
    sql.close();
  }
}

async function releaseTearsDown(w: World, id: string): Promise<void> {
  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource appdb \\(`));
  assert.deepEqual(teardowns(w), []);
}

test('a resource kept by a later up records the shared service its config now needs, so its teardown after a park starts it', async t => {
  const w = world(t);
  const d = db(w);
  fs.writeFileSync(d.up, '');
  setUp(w, undeclared(webConfig(d)));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  const id = first.lane.id;
  assert.deepEqual(resourceRows(w), [['appdb', '[]', 1]]);

  setUp(w, webConfig(d));
  w.lines.length = 0;
  const second = await up(w.deps(), OPTIONS);
  assert.equal(second.lane.id, id);
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane up: resources: kept appdb ')),
    w.lines.join('\n'),
  );
  assert.deepEqual(resourceRows(w), [['appdb', '["db"]', 1]]);

  await parkedAndStopped(w, first.lane);
  await releaseTearsDown(w, id);
  assert.deepEqual(d.lines(), [`create ${id}`, 'service', 'stop', 'start', `teardown ${id}`]);
});

test('a resource row a 0.5.x registry wrote gets its repository and needs at the next up, so its teardown after a park starts the shared service', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  const id = first.lane.id;
  const sql = new DatabaseSync(databasePath(w.state), { timeout: 5000 });
  try {
    sql.prepare("UPDATE resources SET repository = NULL, needs = '[]'").run();
  } finally {
    sql.close();
  }
  assert.deepEqual(resourceRows(w), [['appdb', '[]', null]]);

  const second = await up(w.deps(), OPTIONS);
  assert.equal(second.lane.id, id);
  assert.deepEqual(resourceRows(w), [['appdb', '["db"]', 1]]);

  await parkedAndStopped(w, first.lane);
  await releaseTearsDown(w, id);
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service', 'stop', 'start', `teardown ${id}`]);
});

test("a wake records what the lane's resources need now, so their teardown after a later park starts the shared service", async t => {
  const w = world(t);
  const d = db(w);
  fs.writeFileSync(d.up, '');
  setUp(w, undeclared(webConfig(d)));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  const id = first.lane.id;

  setUp(w, webConfig(d));
  age(w, first.lane);
  assert.deepEqual(
    (await sweep(w)).outcomes.map(o => [o.kind, o.lane]),
    [['parked', id]],
  );
  assert.equal(await execInLane(w.deps(), ['true']), 0, w.lines.join('\n'));
  assert.deepEqual(resourceRows(w), [['appdb', '["db"]', 1]]);

  await parkedAndStopped(w, first.lane);
  await releaseTearsDown(w, id);
  assert.deepEqual(d.lines(), [`create ${id}`, 'service', 'service', 'stop', 'start', `teardown ${id}`]);
});

test('a resource kept by a later up whose config no longer names its shared service keeps needing it, so the teardown its create recorded starts it after a park', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  const id = first.lane.id;

  setUp(w, undeclared(webConfig(d)));
  w.lines.length = 0;
  const second = await up(w.deps(), OPTIONS);
  assert.equal(second.doctor.ok, true, failures(second));
  assert.equal(second.lane.id, id);
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane up: resources: kept appdb ')),
    w.lines.join('\n'),
  );
  assert.deepEqual(resourceRows(w), [['appdb', '["db"]', 1]]);

  await parkedAndStopped(w, first.lane);
  await releaseTearsDown(w, id);
  assert.deepEqual(d.lines(), ['start', `create ${id}`, 'service', 'stop', 'start', `teardown ${id}`]);
});

test("an up whose shared start fails still records what the lane's resources need now, so their teardown starts the shared service", async t => {
  const w = world(t);
  const d = db(w);
  fs.writeFileSync(d.up, '');
  setUp(w, undeclared(webConfig(d)));
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  const id = first.lane.id;

  setUp(w, webConfig(d));
  fs.rmSync(d.up);
  fs.writeFileSync(d.broken, '');
  await assert.rejects(up(w.deps(), OPTIONS), SharedServiceFailed);
  assert.deepEqual(resourceRows(w), [['appdb', '["db"]', 1]]);

  fs.rmSync(d.broken);
  await releaseTearsDown(w, id);
  assert.deepEqual(d.lines(), [`create ${id}`, 'service', 'start', `teardown ${id}`]);
});

test('one pass starts a shared service that fails once: each later teardown that needs it fails without another start and keeps its record with the same problem', async t => {
  const w = world(t);
  const d = db(w);
  const attempts = path.join(w.root, 'db', 'attempts');
  const tries = () => (fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').trim().split('\n').length : 0);
  const config = webConfig(d);
  const { db: spec } = config.shared as { db: { start: string } };
  const names = ['one', 'two', 'three'];
  setUp(w, {
    ...config,
    shared: { db: { ...spec, start: `echo attempt >> '${attempts}'; ${spec.start}` } },
    resources: Object.fromEntries(
      names.map(name => [
        name,
        {
          create: `test -f '${d.up}' && echo "create ${name}" >> '${d.log}' && echo "${name.toUpperCase()}_URL=x" >> "$AGENTLANE_EXPORTS"`,
          exports: [`${name.toUpperCase()}_URL`],
          teardown: `test -f '${d.up}' && echo "teardown ${name}" >> '${d.log}'`,
          needs: ['db'],
        },
      ]),
    ),
  });
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  await parkedAndStopped(w, result.lane);
  fs.writeFileSync(d.broken, '');
  const before = tries();

  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 1);
  assert.equal(tries() - before, 1, 'the pass started the failing shared service more than once');
  const problems = out
    .join('')
    .split('\n')
    .filter(l => l.startsWith(`agentlane: lane ${id}: PROBLEM: resource `));
  assert.deepEqual(
    problems.map(l => l.replace(/ \(attempt 1\): start exited 3: .*$/, '')),
    ['three', 'two', 'one'].map(
      name => `agentlane: lane ${id}: PROBLEM: resource ${name}: teardown did not run, since shared service db did not start`,
    ),
    out.join(''),
  );
  const kept = teardowns(w);
  assert.deepEqual(kept.map(td => [td.name, td.attempts]).sort(), names.map(name => [name, 1]).sort());
  const [firstProblem] = kept.map(td => td.problem);
  assert.match(firstProblem ?? '', /^teardown did not run, since shared service db did not start: start exited 3: /);
  assert.deepEqual(
    kept.map(td => td.problem),
    kept.map(() => firstProblem),
  );
  assert.equal(
    d.lines().some(l => l.startsWith('teardown')),
    false,
  );

  fs.rmSync(d.broken);
  out.length = 0;
  assert.equal(await runRegistryCommand('release', [id], cli(w, out)), 0, out.join(''));
  assert.equal(tries() - before, 2);
  assert.deepEqual(d.lines().slice(-4), ['start', 'teardown three', 'teardown two', 'teardown one']);
  assert.deepEqual(teardowns(w), []);
});

test('restart starts the shared service the restarted service now needs before starting it, records the need, and changes nothing when that start fails', async t => {
  const w = world(t);
  const d = db(w);
  setUp(w, webConfig(d, {}));
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;
  const site = () =>
    readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes[0]?.processes.find(p => p.service === 'site')?.pid;
  const running = site();
  assert.ok(running !== undefined);

  setUp(w, webConfig(d, { site: ['db'] }));
  fs.writeFileSync(d.broken, '');
  w.lines.length = 0;
  assert.equal(await runUpCommand('restart', ['site'], w.deps(), () => undefined), 1);
  assert.match(w.lines.join('\n'), /shared service db: start exited 3: /);
  assert.deepEqual(d.lines(), [`create ${id}`, 'service'], 'the restart restarted the site without its shared service');
  assert.equal(site(), running);

  fs.rmSync(d.broken);
  w.lines.length = 0;
  assert.equal(await runUpCommand('restart', ['site'], w.deps(), () => undefined), 0, w.lines.join('\n'));
  assert.deepEqual(d.lines(), [`create ${id}`, 'service', 'start', 'service']);
  assert.notEqual(site(), running);
  assert.ok(
    w.lines.some(l => l.startsWith('agentlane restart: shared: starting shared service db: ')),
    w.lines.join('\n'),
  );
  assert.deepEqual(
    look(w, r => r.needsOf(id)),
    ['db'],
  );
  assert.deepEqual([service(w).state, service(w).lanes, service(w).unneededSince], ['running', [id], null]);
});
