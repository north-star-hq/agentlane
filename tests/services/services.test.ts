import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { systemClock } from '../../src/clock.ts';
import type { ServiceConfig } from '../../src/project/config.ts';
import type { ServiceProcess } from '../../src/registry/types.ts';
import {
  explainInspection,
  inspectService,
  listenersOn,
  probeReady,
  ServiceFailed,
  startService,
  stopService,
  waitForService,
} from '../../src/services/services.ts';
import { realServiceSystem as system } from '../../src/services/system.ts';
import { tempDir } from '../support/fakes.ts';

/** Starts its command in a process group of its own, as pnpm exec does, and passes on no signal. */
const WRAPPER = `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
`;

const SERVER = `import { createServer } from 'node:http';
createServer((req, res) => {
  res.end(req.url === '/status' ? 'packager-status:running' : 'ok');
}).listen(Number(process.env.SVC_PORT), '127.0.0.1');
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });
}

function alive(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = result.stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function project(t: TestContext) {
  const dir = fs.realpathSync(tempDir('services'));
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER);
  fs.writeFileSync(path.join(dir, 'wrap.mjs'), WRAPPER);
  const groups: number[] = [];
  const children: ChildProcess[] = [];
  t.after(() => {
    for (const child of children) child.kill('SIGKILL');
    for (const pgid of groups) for (const below of system.descendants(pgid) ?? []) system.signal(below.pid, 'SIGKILL');
    for (const pgid of groups) system.signalGroup(pgid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const service = (start: string, over: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name: 'api',
    type: 'api',
    ports: null,
    start,
    cwd: dir,
    ready: { kind: 'http', host: '127.0.0.1', path: '/status', status: 200, body: 'packager-status:running' },
    timeoutMs: 8000,
    dial: null,
    platforms: null,
    ...over,
  });
  const start = (config: ServiceConfig, port: number): ServiceProcess => {
    const proc = startService(
      system,
      config,
      { PATH: process.env.PATH, SVC_PORT: String(port) },
      path.join(dir, 'logs', 'api.log'),
    );
    groups.push(proc.pid);
    return proc;
  };
  const foreign = async (port: number): Promise<ChildProcess> => {
    const child = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${String(port)}, '127.0.0.1', () => console.log('up'))`],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    children.push(child);
    await new Promise(resolve => child.stdout.once('data', resolve));
    return child;
  };
  return { dir, service, start, foreign, log: path.join(dir, 'logs', 'api.log') };
}

test('a service starts in its own group, is ready and ours, and its working directory is read back', async t => {
  const p = project(t);
  const port = await freePort();
  const config = p.service('SVC_PORT="$SVC_PORT" exec node server.mjs');
  const proc = p.start(config, port);
  const ready = await waitForService(system, config, port, proc, systemClock, p.log);
  assert.equal(ready.pid, proc.pid);
  assert.equal(ready.cwd, p.dir);
  const seen = await inspectService(system, config, port, ready);
  assert.equal(seen.healthy, true, JSON.stringify(seen));
  assert.deepEqual(
    seen.listeners?.map(l => l.ours),
    [true],
  );
  assert.equal(system.groups([proc.pid])?.get(proc.pid), proc.pid, 'the service leads its own process group');
});

test('stop ends every process in the group the toolkit started, verified by pid and start time', async t => {
  const p = project(t);
  const port = await freePort();
  const config = p.service("node server.mjs & node -e 'setInterval(() => {}, 1e9)' & wait");
  const proc = p.start(config, port);
  const ready = await waitForService(system, config, port, proc, systemClock, p.log);
  const members = system.groupMembers(proc.pid) ?? [];
  assert.equal(members.length, 3, `leader shell plus two children, got ${members.join(',')}`);
  const outcome = await stopService(system, ready, systemClock);
  assert.deepEqual(outcome, { kind: 'stopped', signal: 'SIGTERM' });
  for (const pid of members) assert.equal(alive(pid), false, `pid ${String(pid)} survived`);
  assert.deepEqual(listenersOn(system, port, null), []);
});

test("a server a wrapper starts in a group of its own is the service's: ready, healthy and stopped with it, while another service's is not", async t => {
  const p = project(t);
  const [port, otherPort] = [await freePort(), await freePort()];
  const config = p.service('SVC_PORT="$SVC_PORT" exec node wrap.mjs server.mjs');
  const proc = p.start(config, port);
  const ready = await waitForService(system, config, port, proc, systemClock, p.log);
  const [listener] = system.listeners(port) ?? [];
  assert.ok(listener !== undefined && listener !== proc.pid, 'the wrapper, not the leader, runs the server');
  assert.notEqual(system.groups([listener])?.get(listener), proc.pid, 'the server left the service process group');
  const seen = await inspectService(system, config, port, ready);
  assert.equal(seen.healthy, true, explainInspection(seen));
  assert.deepEqual(
    seen.listeners?.map(l => [l.pid, l.ours]),
    [[listener, true]],
  );

  const other = p.start(config, otherPort);
  await waitForService(system, config, otherPort, other, systemClock, p.log);
  assert.deepEqual(
    listenersOn(system, otherPort, ready.pid)?.map(l => l.ours),
    [false],
    "another service's server, wrapped the same way, is not this one's",
  );

  const outcome = await stopService(system, ready, systemClock);
  assert.deepEqual(outcome, { kind: 'stopped', signal: 'SIGTERM' });
  assert.equal(alive(listener), false, `the server pid ${String(listener)} outlived its service`);
  assert.deepEqual(listenersOn(system, port, null), []);
  assert.equal((await inspectService(system, config, otherPort, { ...other, cwd: p.dir })).healthy, true);
  assert.equal((await stopService(system, other, systemClock)).kind, 'stopped');
  assert.deepEqual(listenersOn(system, otherPort, null), []);
});

test('a recycled pid or a moved working directory is never signalled', async t => {
  const p = project(t);
  const port = await freePort();
  const config = p.service('SVC_PORT="$SVC_PORT" exec node server.mjs');
  const proc = p.start(config, port);
  const ready = await waitForService(system, config, port, proc, systemClock, p.log);
  const recycled = await stopService(system, { ...ready, start: 'Mon Jan  1 00:00:00 2024' }, systemClock);
  assert.equal(recycled.kind, 'not-ours');
  const moved = await stopService(system, { ...ready, cwd: '/somewhere/else' }, systemClock);
  assert.equal(moved.kind, 'not-ours');
  assert.equal(alive(proc.pid), true, 'a process that failed the ownership check was signalled');
  assert.equal((await inspectService(system, config, port, ready)).healthy, true);
});

test('when the leader has exited, processes left in its group are reported, not killed', async t => {
  const p = project(t);
  const port = await freePort();
  const config = p.service("node -e 'setInterval(() => {}, 1e9)' & exit 0");
  const proc = p.start(config, port);
  const reaped = () => spawnSync('ps', ['-o', 'pid=', '-p', String(proc.pid)], { encoding: 'utf8' }).stdout.trim() === '';
  await until(() => reaped() && (system.groupMembers(proc.pid) ?? []).length === 1);
  const [orphan] = system.groupMembers(proc.pid) ?? [];
  const outcome = await stopService(system, proc, systemClock);
  assert.equal(outcome.kind, 'cant-tell');
  assert.match((outcome as { reason: string }).reason, new RegExp(`processes ${String(orphan)} remain`));
  assert.equal(alive(orphan ?? 0), true);
});

test('a service that exits before it is ready fails with the tail of its log', async t => {
  const p = project(t);
  const port = await freePort();
  const config = p.service('echo "cannot find module"; exit 3');
  const proc = p.start(config, port);
  await assert.rejects(waitForService(system, config, port, proc, systemClock, p.log), (error: unknown) => {
    return (
      error instanceof ServiceFailed &&
      error.message.includes('exited before it was ready') &&
      error.message.includes('cannot find module') &&
      error.message.includes(p.log)
    );
  });
});

test('a service that never becomes ready fails after its timeout, naming the last check', async t => {
  const p = project(t);
  const port = await freePort();
  const config = p.service("exec node -e 'setInterval(() => {}, 1e9)'", { timeoutMs: 1200 });
  const proc = p.start(config, port);
  await assert.rejects(
    waitForService(system, config, port, proc, systemClock, p.log),
    (error: unknown) =>
      error instanceof ServiceFailed &&
      /was not ready after 1\.2 s: GET http:\/\/127\.0\.0\.1:\d+\/status failed/.test(error.message),
  );
});

test("a port held by a process the toolkit didn't start is never treated as ready, and that process survives", async t => {
  const p = project(t);
  const port = await freePort();
  const stranger = await p.foreign(port);
  const config = p.service("exec node -e 'setInterval(() => {}, 1e9)'", { ready: { kind: 'tcp', host: '127.0.0.1' } });
  const proc = p.start(config, port);
  await assert.rejects(
    waitForService(system, config, port, proc, systemClock, p.log),
    (error: unknown) =>
      error instanceof ServiceFailed &&
      error.message.includes(`held by a process the toolkit did not start: pid ${String(stranger.pid)}`),
  );
  assert.equal((await probeReady(config.ready, port)).ready, true, 'the stranger answers TCP');
  const seen = await inspectService(system, config, port, { ...proc, cwd: null });
  assert.equal(seen.healthy, false);
  assert.deepEqual(
    seen.listeners?.map(l => [l.pid, l.ours]),
    [[stranger.pid, false]],
  );
  await stopService(system, { ...proc, cwd: null }, systemClock);
  assert.equal(stranger.exitCode, null);
  assert.equal(alive(stranger.pid ?? 0), true);
});

test('an HTTP check wants the status and the body text it names', async t => {
  const p = project(t);
  const port = await freePort();
  const config = p.service('SVC_PORT="$SVC_PORT" exec node server.mjs');
  const proc = p.start(config, port);
  await waitForService(system, config, port, proc, systemClock, p.log);
  const wrongBody = await probeReady(
    { kind: 'http', host: '127.0.0.1', path: '/health', status: 200, body: 'packager-status:running' },
    port,
  );
  assert.equal(wrongBody.ready, false);
  assert.match(wrongBody.detail, /returned 200 without 'packager-status:running'/);
  const wrongStatus = await probeReady({ kind: 'http', host: '127.0.0.1', path: '/health', status: 204, body: null }, port);
  assert.match(wrongStatus.detail, /returned 200, not 204/);
});
