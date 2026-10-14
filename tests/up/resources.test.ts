import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { systemProcesses } from '../../src/processes.ts';
import { resolveOwner } from '../../src/registry/owner.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { releaseEveryLaneOf, runRegistryCommand, type CliDeps } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import { laneDir } from '../../src/up/lane-files.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { ResourceFailed } from '../../src/up/resources.ts';
import { up } from '../../src/up/up.ts';
import { alive, failures, OPTIONS, sleeper, until, WEB, world, type World } from '../support/up-world.ts';

const SITE_SERVER = `import { createServer } from 'node:http';
createServer((req, res) => res.end(JSON.stringify({ path: req.url, db: process.env.DATABASE_URL ?? null })))
  .listen(Number(process.env.AGENTLANE_SITE_PORT), '127.0.0.1');
`;

const STAGING = 'postgres://staging.example/app';

interface Paths {
  dbs: string;
  trace: string;
}

function paths(w: World): Paths {
  return { dbs: path.join(w.root, 'dbs'), trace: path.join(w.root, 'resources.trace') };
}

function db(p: Paths, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    create: `mkdir -p '${p.dbs}' && echo "create $AGENTLANE_LANE \${DATABASE_URL:-unset}" >> '${p.trace}' && touch "${p.dbs}/$AGENTLANE_LANE.db" && echo "DATABASE_URL=file:${p.dbs}/$AGENTLANE_LANE.db" >> "$AGENTLANE_EXPORTS"`,
    exports: ['DATABASE_URL'],
    teardown: `echo "teardown $AGENTLANE_LANE $DATABASE_URL $(pwd)" >> '${p.trace}' && rm -f "${p.dbs}/$AGENTLANE_LANE.db"`,
    ...over,
  };
}

function webConfig(p: Paths, resource: Record<string, unknown> = db(p)): Record<string, unknown> {
  return {
    web: { path: '/dashboard' },
    services: {
      site: { type: 'web', start: 'exec node site.mjs', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 10 },
    },
    hooks: {
      setup: 'echo "setup ${DATABASE_URL:-unset}" >> trace.log',
      teardown: 'echo "teardown hook ${DATABASE_URL:-unset}" >> trace.log',
    },
    resources: { db: resource },
    preconditions: [
      { name: "the caller's DATABASE_URL stays out", run: 'test -z "${DATABASE_URL:-}"', fix: 'clear it' },
      { name: 'no resource value before create', run: 'test -z "${DATABASE_URL:-}"', fix: 'clear it', before: 'build' },
    ],
  };
}

function setUp(w: World, config: Record<string, unknown> = webConfig(paths(w))): Paths {
  fs.writeFileSync(path.join(w.project, 'site.mjs'), SITE_SERVER);
  w.write(config);
  return paths(w);
}

function caller(w: World, over: Partial<EnvDeps> & { owner?: number } = {}): EnvDeps {
  const deps = w.deps(over);
  return { ...deps, env: { ...deps.env, DATABASE_URL: STAGING } };
}

function cli(w: World, out: string[], deps: EnvDeps = caller(w), cwd = w.project): CliDeps {
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
  };
}

function lines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
}

function status(w: World) {
  return readRegistryStatus({ dir: w.state, processes: systemProcesses });
}

function dbOf(p: Paths, lane: string): string {
  return `file:${path.join(p.dbs, `${lane}.db`)}`;
}

test("a resource is created once per lane, after setup; its values reach the services, the hooks after setup, exec, restart and up's exports, never the caller's own value; release runs the teardown hook, then the resource's teardown", async t => {
  const w = world(t);
  const p = setUp(w);
  const first = await up(caller(w), OPTIONS);
  assert.equal(first.doctor.ok, true, `${failures(first)}\n${w.lines.join('\n')}`);
  const id = first.lane.id;
  const url = dbOf(p, id);
  assert.equal(first.platform, 'web');
  assert.equal(first.env.DATABASE_URL, url);
  assert.deepEqual(first.lane.resources, [{ name: 'db', exports: { DATABASE_URL: url } }]);
  assert.equal(first.url, `http://localhost:${String(WEB)}/dashboard`);
  assert.deepEqual(await (await fetch(first.url)).json(), { path: '/dashboard', db: url });
  assert.deepEqual(lines(p.trace), [`create ${id} unset`]);
  assert.ok(
    first.doctor.checks.some(c => c.name === 'resource db' && c.ok && c.detail.includes('exports DATABASE_URL')),
    JSON.stringify(first.doctor.checks),
  );

  const second = await up(caller(w), OPTIONS);
  assert.equal(second.lane.id, id);
  assert.equal(second.env.DATABASE_URL, url);
  assert.deepEqual(lines(p.trace), [`create ${id} unset`], 'the second up created the resource again');
  assert.ok(w.lines.some(l => l.includes('resources: kept db from an earlier up of this lane')));
  assert.deepEqual(w.read('trace.log').trim().split('\n'), ['setup unset', 'setup unset']);

  const code = await runUpCommand('exec', ['--', 'sh', '-c', 'echo "$DATABASE_URL" > exec.out'], caller(w), () => undefined);
  assert.equal(code, 0, w.lines.join('\n'));
  assert.equal(w.read('exec.out').trim(), url);
  assert.equal(await runUpCommand('restart', ['site'], caller(w), () => undefined), 0, w.lines.join('\n'));
  assert.deepEqual(await (await fetch(first.url)).json(), { path: '/dashboard', db: url });

  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource db \\(`));
  assert.deepEqual(lines(path.join(w.project, 'trace.log')).slice(-1), [`teardown hook ${url}`]);
  assert.deepEqual(lines(p.trace), [`create ${id} unset`, `teardown ${id} ${url} ${w.project}`]);
  assert.equal(fs.existsSync(path.join(p.dbs, `${id}.db`)), false);
  assert.deepEqual(status(w).lanes, []);
  assert.deepEqual(status(w).teardowns, []);
});

test('the teardown recorded when create ran is the one release runs, after the config changed it or dropped the resource', async t => {
  const w = world(t);
  const p = setUp(w);
  const result = await up(caller(w), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  w.write({ ...webConfig(p), resources: { cache: { create: 'true', teardown: `echo "the new config's" >> '${p.trace}'` } } });
  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 0, out.join(''));
  assert.deepEqual(lines(p.trace), [
    `create ${result.lane.id} unset`,
    `teardown ${result.lane.id} ${dbOf(p, result.lane.id)} ${w.project}`,
  ]);
});

test('the resources of a lane whose owner died are torn down by the next claim that frees it', async t => {
  const w = world(t);
  const p = setUp(w);
  const owner = sleeper();
  t.after(() => owner.kill('SIGKILL'));
  const result = await up(w.deps({ owner: owner.pid ?? 0 }), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const [site] = w.processes();
  const reaped = new Promise(resolve => owner.once('exit', resolve));
  owner.kill('SIGKILL');
  await reaped;

  const other = fs.mkdtempSync(path.join(w.root, 'other-'));
  const out: string[] = [];
  const code = await runRegistryCommand(
    'claim',
    ['--worktree', other, '--services', 'none', '--no-device'],
    cli(w, out, caller(w), other),
  );
  assert.equal(code, 0, out.join(''));
  assert.match(out.join(''), new RegExp(`freed lane ${result.lane.id} of process \\d+ in `));
  assert.match(out.join(''), new RegExp(`lane ${result.lane.id}: tore down resource db`));
  assert.deepEqual(lines(p.trace).slice(-1), [`teardown ${result.lane.id} ${dbOf(p, result.lane.id)} ${w.project}`]);
  assert.equal(fs.existsSync(path.join(p.dbs, `${result.lane.id}.db`)), false);
  await until(() => !alive(site?.pid ?? 0));
  assert.deepEqual(status(w).teardowns, []);
});

test('the session-end release tears down the resources of every lane the session held', async t => {
  const w = world(t);
  const p = setUp(w);
  const result = await up(caller(w), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const out: string[] = [];
  const deps = cli(w, out);
  assert.equal(await releaseEveryLaneOf(deps, resolveOwner(deps.env, systemProcesses)), 0, out.join(''));
  assert.deepEqual(lines(p.trace).slice(-1), [`teardown ${result.lane.id} ${dbOf(p, result.lane.id)} ${w.project}`]);
  assert.deepEqual(status(w).lanes, []);
});

test('up --no-setup skips the setup hook and still creates the lane its resources', async t => {
  const w = world(t);
  const p = setUp(w);
  const result = await up(caller(w), { ...OPTIONS, setup: false });
  assert.equal(result.doctor.ok, true, failures(result));
  assert.equal(fs.existsSync(path.join(w.project, 'trace.log')), false, 'the setup hook ran');
  assert.deepEqual(lines(p.trace), [`create ${result.lane.id} unset`]);
  assert.equal(result.env.DATABASE_URL, dbOf(p, result.lane.id));
});

test('a failing create stops up with its output before any service starts, keeps the lane, and the next up creates it again', async t => {
  const w = world(t);
  const p = paths(w);
  setUp(w, webConfig(p, db(p, { create: 'echo "no database server on 54329" >&2; exit 3' })));
  await assert.rejects(
    up(caller(w), OPTIONS),
    (error: unknown) =>
      error instanceof ResourceFailed &&
      error.message.startsWith('resource db: create exited 3: echo') &&
      error.message.includes('| no database server on 54329') &&
      error.message.includes('full log: '),
  );
  assert.deepEqual(w.processes(), [], 'a service started after the create failed');
  const [lane] = status(w).lanes;
  assert.deepEqual(lane?.resources, [{ name: 'db', exports: null }]);

  w.lines.length = 0;
  assert.equal(await runUpCommand('up', [], caller(w), () => undefined), 1);
  assert.match(
    w.lines.join('\n'),
    /resource db: create exited 3[\s\S]*the lane stays: fix this and run node_modules\/\.bin\/agentlane up again/,
  );
  const out: string[] = [];
  assert.equal(await runUpCommand('doctor', ['--json'], caller(w), text => out.push(text)), 1);
  const check = (JSON.parse(out.join('')) as { checks: { name: string; ok: boolean; detail: string }[] }).checks.find(
    c => c.name === 'resource db',
  );
  assert.equal(check?.ok, false);
  assert.match(check.detail, /its create failed or did not finish/);

  w.write(webConfig(p));
  w.lines.length = 0;
  const fixed = await up(caller(w), OPTIONS);
  assert.equal(fixed.doctor.ok, true, failures(fixed));
  assert.equal(fixed.lane.id, lane.id);
  assert.ok(
    w.lines.some(l => l.includes('resource db: creating it again: create exited 3')),
    w.lines.join('\n'),
  );
  assert.deepEqual(lines(p.trace), [`create ${lane.id} unset`]);
});

test('a create that exits 0 without writing a declared value fails, naming it and how to write it', async t => {
  const w = world(t);
  const p = paths(w);
  setUp(w, webConfig(p, db(p, { create: 'echo "made it"' })));
  await assert.rejects(
    up(caller(w), OPTIONS),
    (error: unknown) =>
      error instanceof ResourceFailed &&
      error.message.includes('create exited 0 without writing DATABASE_URL to $AGENTLANE_EXPORTS') &&
      error.message.includes('echo "DATABASE_URL=..." >> "$AGENTLANE_EXPORTS"'),
  );
  setUp(
    w,
    webConfig(p, db(p, { create: 'echo "DATABASE_URL=x" >> "$AGENTLANE_EXPORTS"; echo "SECRET=y" >> "$AGENTLANE_EXPORTS"' })),
  );
  await assert.rejects(
    up(caller(w), OPTIONS),
    (error: unknown) =>
      error instanceof ResourceFailed && error.message.includes('create wrote SECRET, which the resource does not declare'),
  );
});

test('a failing teardown is reported and keeps its record; a reap within the retry interval leaves it, and release <id> runs it again and forgets it once it passes', async t => {
  const w = world(t);
  const p = paths(w);
  const ok = path.join(w.root, 'teardown-ok');
  setUp(
    w,
    webConfig(
      p,
      db(p, {
        teardown: `if [ -f '${ok}' ]; then echo "teardown $AGENTLANE_LANE" >> '${p.trace}'; else echo "database server down" >&2; exit 4; fi`,
      }),
    ),
  );
  const result = await up(caller(w), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const id = result.lane.id;

  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 1);
  const said = out.join('');
  assert.match(said, new RegExp(`lane ${id}: PROBLEM: resource db: teardown exited 4 \\(attempt 1\\): if \\[ -f`));
  assert.match(said, /\| database server down/);
  assert.match(
    said,
    new RegExp(
      `its record is kept: the next release or reap tries again, and node_modules/.bin/agentlane release ${id} runs it now`,
    ),
  );
  assert.deepEqual(status(w).lanes, []);
  assert.deepEqual(
    status(w).teardowns.map(td => [td.lane, td.name, td.attempts]),
    [[id, 'db', 1]],
  );
  out.length = 0;
  assert.equal(await runRegistryCommand('status', [], cli(w, out)), 0);
  assert.match(
    out.join(''),
    new RegExp(
      `teardowns pending[\\s\\S]*${id}  resource db of ${w.project}, created .*; failed 1 time, last at .*: teardown exited 4: if \\[ -f`,
    ),
  );

  const other = fs.mkdtempSync(path.join(w.root, 'other-'));
  out.length = 0;
  assert.equal(
    await runRegistryCommand('claim', ['--worktree', other, '--services', 'none', '--no-device'], cli(w, out, caller(w), other)),
    0,
    out.join(''),
  );
  assert.equal(status(w).teardowns[0]?.attempts, 1, 'a reap retried the teardown within the retry interval');

  fs.writeFileSync(ok, '');
  out.length = 0;
  assert.equal(await runRegistryCommand('release', [id], cli(w, out)), 0, out.join(''));
  assert.match(out.join(''), new RegExp(`lane ${id}: tore down resource db`));
  assert.deepEqual(lines(p.trace).slice(-1), [`teardown ${id}`]);
  assert.deepEqual(status(w).teardowns, []);
});

test("a resource whose worktree was deleted is torn down from the lane's log folder when the lane is reaped", async t => {
  const w = world(t);
  const p = setUp(w);
  const result = await up(caller(w), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  fs.rmSync(w.project, { recursive: true, force: true });

  const other = fs.mkdtempSync(path.join(w.root, 'other-'));
  const out: string[] = [];
  assert.equal(
    await runRegistryCommand('claim', ['--worktree', other, '--services', 'none', '--no-device'], cli(w, out, caller(w), other)),
    0,
    out.join(''),
  );
  const logs = laneDir(w.state, result.lane.id);
  assert.match(out.join(''), /worktree gone/);
  assert.match(
    out.join(''),
    new RegExp(`tore down resource db \\(.*; ${w.project} is gone, so it ran in the lane's log folder\\)`),
  );
  assert.deepEqual(lines(p.trace).slice(-1), [`teardown ${result.lane.id} ${dbOf(p, result.lane.id)} ${logs}`]);
});

test('a teardown that runs past its timeout is stopped with its process group, and kept for the next try', async t => {
  const w = world(t);
  const p = paths(w);
  const pidFile = path.join(w.root, 'teardown.pid');
  setUp(w, webConfig(p, db(p, { teardown: `sh -c 'echo $$ > "${pidFile}"; exec sleep 30'`, teardownTimeoutSeconds: 0.5 })));
  const result = await up(caller(w), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const out: string[] = [];
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli(w, out)), 1);
  assert.match(out.join(''), /resource db: teardown ran past its 0.5 s and was stopped \(attempt 1\)/);
  await until(() => !alive(Number(fs.readFileSync(pidFile, 'utf8'))));
  assert.deepEqual(
    status(w).teardowns.map(td => td.lane),
    [result.lane.id],
  );
});
