import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { systemClock, type Clock } from '../../src/clock.ts';
import type { ServiceConfig } from '../../src/project/config.ts';
import { startMs } from '../../src/processes.ts';
import type { ServiceProcess } from '../../src/registry/types.ts';
import {
  describeStop,
  explainInspection,
  inspectService,
  judgeLeader,
  leaderAliveAt,
  listenersOn,
  probeReady,
  ServiceFailed,
  startService,
  stopService,
  waitForService,
  type Killed,
  type StopOutcome,
} from '../../src/services/services.ts';
import { realServiceSystem as system, type ServiceSystem } from '../../src/services/system.ts';
import { stopClaimedService } from '../../src/up/lane-services.ts';
import { stopRecordedProcesses } from '../../src/up/release.ts';
import { tempDir } from '../support/fakes.ts';
import { world } from '../support/world.ts';

/** Starts its command in a process group of its own, as pnpm exec does, and passes on no signal. */
const WRAPPER = `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
`;

/** Forks a long-lived worker in its process group, after the delay in ms its argument names. */
const FORKER = `import { spawn } from 'node:child_process';
setTimeout(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' }), Number(process.argv[2]));
setInterval(() => {}, 1e9);
`;

/** On SIGTERM, starts a long-lived helper in its process group and, given 'exit', exits 100 ms later. */
const HELPER = `import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {
  console.log('helper ' + String(spawn('sleep', ['30'], { stdio: 'ignore' }).pid));
  if (process.argv[2] === 'exit') setTimeout(() => process.exit(0), 100);
});
console.log('handling SIGTERM');
setInterval(() => {}, 1e9);
`;

const IGNORER = `process.on('SIGTERM', () => {});
console.log('ignoring SIGTERM');
setInterval(() => {}, 1e9);
`;

/** On SIGTERM, exits 300 ms later. */
const LINGERER = `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));
setInterval(() => {}, 1e9);
`;

/** Starts its argument as a service leader in a process group of its own, then blocks for a minute without reaping it. */
const BLOCKED_PARENT = `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const leader = spawn(process.execPath, ['-e', process.argv[2]], { detached: true, stdio: 'ignore' });
fs.writeSync(1, String(leader.pid) + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
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
  fs.writeFileSync(path.join(dir, 'forker.mjs'), FORKER);
  fs.writeFileSync(path.join(dir, 'helper.mjs'), HELPER);
  fs.writeFileSync(path.join(dir, 'ignorer.mjs'), IGNORER);
  fs.writeFileSync(path.join(dir, 'lingerer.mjs'), LINGERER);
  fs.writeFileSync(path.join(dir, 'parent.mjs'), BLOCKED_PARENT);
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

function reaped(pid: number): boolean {
  return spawnSync('ps', ['-o', 'pid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() === '';
}

/** Starts a service whose leader exits at once, leaving `members` processes in its group, and waits for that state. */
async function orphaned(p: ReturnType<typeof project>, start: string, port: number, members = 1): Promise<ServiceProcess> {
  const proc = p.start(p.service(start), port);
  await until(() => reaped(proc.pid) && (system.groupMembers(proc.pid) ?? []).length === members);
  return proc;
}

test('when the leader has exited, release stops the processes it left in its group', async t => {
  const p = project(t);
  const proc = await orphaned(p, "node -e 'setInterval(() => {}, 1e9)' & exit 0", await freePort());
  const [orphan] = system.groupMembers(proc.pid) ?? [];
  assert.ok(orphan !== undefined && alive(orphan));
  const into = { lane: 'lane', notes: [] as string[], problems: [] as string[] };
  await stopRecordedProcesses({ system, clock: systemClock }, [proc], into);
  assert.deepEqual(into.problems, []);
  assert.match(into.notes.join('\n'), /^stopped api/);
  assert.equal(alive(orphan), false, `pid ${String(orphan)} outlived its service`);
  assert.deepEqual(system.groupMembers(proc.pid), []);
});

test('when the leader has exited, a server its group started in a group of its own is stopped too', async t => {
  const p = project(t);
  const port = await freePort();
  const proc = await orphaned(p, 'SVC_PORT="$SVC_PORT" node wrap.mjs server.mjs & exit 0', port);
  await until(() => (system.listeners(port) ?? []).length === 1);
  const [wrapper] = system.groupMembers(proc.pid) ?? [];
  const [server] = system.listeners(port) ?? [];
  assert.ok(wrapper !== undefined && server !== undefined);
  assert.notEqual(system.groups([server])?.get(server), proc.pid, 'the server left the service process group');
  assert.deepEqual(await stopService(system, proc, systemClock), { kind: 'stopped', signal: 'SIGTERM' });
  assert.equal(alive(wrapper), false, `the wrapper pid ${String(wrapper)} survived`);
  assert.equal(alive(server), false, `the server pid ${String(server)} survived`);
  assert.deepEqual(listenersOn(system, port, null), []);
});

test('when the leader has exited, a group none of whose processes started with the recorded leader is left alone', async t => {
  const p = project(t);
  const proc = await orphaned(p, "node -e 'setInterval(() => {}, 1e9)' & exit 0", await freePort());
  const [orphan] = system.groupMembers(proc.pid) ?? [];
  const older = await stopService(system, { ...proc, start: 'Mon Jan  1 00:00:00 2024' }, systemClock);
  assert.equal(older.kind, 'cant-tell');
  assert.match(
    (older as { reason: string }).reason,
    new RegExp(
      `none of processes ${String(orphan)} left in its group started with it or before it was last seen running, so they can't be proven ours; stop them with kill ${String(orphan)}$`,
    ),
  );
  const unreadable = await stopService(
    { ...system, running: pids => (pids.includes(proc.pid) ? system.running(pids) : undefined) },
    proc,
    systemClock,
  );
  assert.deepEqual(unreadable, { kind: 'cant-tell', reason: `ps could not read when processes ${String(orphan)} started` });
  assert.equal(alive(orphan ?? 0), true, 'a process that failed the ownership check was signalled');
});

test('when the leader has exited, a process its group started seconds later is not proof the group is still the service', async t => {
  const p = project(t);
  const proc = await orphaned(p, "sleep 2; node -e 'setInterval(() => {}, 1e9)' & exit 0", await freePort());
  const [late] = system.groupMembers(proc.pid) ?? [];
  const outcome = await stopService(system, proc, systemClock);
  assert.equal(outcome.kind, 'cant-tell');
  assert.match((outcome as { reason: string }).reason, new RegExp(`stop them with kill ${String(late)}$`));
  assert.equal(alive(late ?? 0), true);
});

/** The worker an `exec node forker.mjs` service forked, once it has, with its start time as ps prints it. */
async function workerOf(proc: ServiceProcess): Promise<{ pid: number; start: string }> {
  await until(() => (system.groupMembers(proc.pid) ?? []).length === 2, 8000);
  const pid = (system.groupMembers(proc.pid) ?? []).find(member => member !== proc.pid) ?? 0;
  const start = system.processes.startTimes([pid])?.get(pid) ?? '';
  assert.ok(startMs(start) - startMs(proc.start) > 1000, 'the worker started with the leader');
  return { pid, start };
}

async function killLeader(proc: ServiceProcess, worker: number): Promise<void> {
  system.signal(proc.pid, 'SIGKILL');
  await until(() => reaped(proc.pid) && (system.groupMembers(proc.pid) ?? []).join() === String(worker));
}

test('when an exec leader has exited, release stops a worker it forked seconds later, since the leader was seen running after', async t => {
  const p = project(t);
  const proc = p.start(p.service('exec node forker.mjs 2200'), 0);
  const worker = await workerOf(proc);
  await until(() => Date.now() >= startMs(worker.start) + 1000, 3000);
  const aliveAt = leaderAliveAt(system, proc, systemClock);
  assert.ok(aliveAt !== undefined, 'the leader was not seen running');
  const w = world();
  t.after(() => {
    w.close();
  });
  const owner = w.procs.owner();
  const { lane } = await w.registry().claim(w.request(owner, w.folder('a'), { device: null }));
  const ref = { id: lane.id, token: lane.token };
  w.registry().recordProcess(ref, proc);
  assert.equal(w.registry().recordLeaderAlive(lane.id, proc, aliveAt), true);
  await killLeader(proc, worker.pid);

  const unproven = await stopService(system, proc, systemClock);
  assert.equal(unproven.kind, 'cant-tell', 'without the moment the leader was seen running, the worker is not proven');
  assert.equal(alive(worker.pid), true);
  const ended = w.registry().release(ref, owner);
  assert.deepEqual(ended.processes, [{ ...proc, aliveAt }]);
  const into = { lane: lane.id, notes: [] as string[], problems: [] as string[] };
  await stopRecordedProcesses({ system, clock: systemClock }, ended.processes ?? [], into);
  assert.deepEqual(into.problems, []);
  assert.match(into.notes.join('\n'), /^stopped api/);
  assert.equal(alive(worker.pid), false, `the worker pid ${String(worker.pid)} outlived its service`);
});

test('when the leader has exited, a process that started after the leader was last seen running, and not with it, is left alone', async t => {
  const p = project(t);
  const proc = p.start(p.service('exec node forker.mjs 2200'), 0);
  const aliveAt = leaderAliveAt(system, proc, systemClock);
  assert.ok(aliveAt !== undefined);
  const worker = await workerOf(proc);
  await killLeader(proc, worker.pid);
  const outcome = await stopService(system, { ...proc, aliveAt }, systemClock);
  assert.equal(outcome.kind, 'cant-tell');
  assert.match((outcome as { reason: string }).reason, new RegExp(`stop them with kill ${String(worker.pid)}$`));
  assert.equal(alive(worker.pid), true, 'a process that failed the ownership check was signalled');
});

for (const after of ['exit', 'stay']) {
  test(`after the grace, SIGKILL ends a helper the leader started in its group on SIGTERM (leader ${after}s)`, async t => {
    const p = project(t);
    const proc = p.start(p.service(`exec node helper.mjs ${after}`), 0);
    await until(() => fs.readFileSync(p.log, 'utf8').includes('handling SIGTERM'));
    const outcome = await stopService(system, proc, systemClock, 1000, 50);
    const helper = Number(/^helper (\d+)$/m.exec(fs.readFileSync(p.log, 'utf8'))?.[1]);
    assert.ok(helper > 0, 'the leader started no helper');
    assert.equal(alive(helper), false, `the helper pid ${String(helper)} outlived its service`);
    assert.ok(outcome.kind === 'stopped' && outcome.signal === 'SIGKILL', describeStop(proc, outcome));
    assert.equal(outcome.killed.group, true);
    assert.ok(
      outcome.killed.pids.every(pid => pid === proc.pid),
      describeStop(proc, outcome),
    );
  });
}

const listings: [string, number[] | undefined][] = [
  ['seen empty', []],
  ['unlisted', undefined],
];
for (const [seen, listing] of listings) {
  test(`after the grace, a group ${seen} once since SIGTERM gets no SIGKILL, and a process that joined it since is reported, not signalled`, async t => {
    const p = project(t);
    const proc = await orphaned(p, "(trap '' TERM; exec sleep 30) & exit 0", 0);
    const [stubborn] = system.groupMembers(proc.pid) ?? [];
    assert.ok(stubborn !== undefined);
    const stray = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1e9)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    t.after(() => stray.kill('SIGKILL'));
    await new Promise(resolve => stray.stdout.once('data', resolve));
    const strayPid = stray.pid ?? 0;
    const strayGroup = system.groups([strayPid])?.get(strayPid) ?? 0;
    assert.notEqual(strayGroup, proc.pid);
    const newcomer = spawn('sleep', ['30'], { stdio: 'ignore' });
    t.after(() => newcomer.kill('SIGKILL'));
    const joined = newcomer.pid ?? 0;
    const sent: string[] = [];
    let polls = 0;
    const watched: ServiceSystem = {
      ...system,
      descendants: pid => (pid === stubborn ? [{ pid: strayPid, pgid: strayGroup }] : system.descendants(pid)),
      groupMembers: pgid => {
        const members = system.groupMembers(pgid);
        if (sent.length === 0 || !members) return members;
        polls += 1;
        return polls === 1 ? listing : [...members, joined];
      },
      signalGroup: (pgid, signal) => {
        sent.push(`group ${String(pgid)} ${signal}`);
        return system.signalGroup(pgid, signal);
      },
      signal: (pid, signal) => {
        sent.push(`${String(pid)} ${signal}`);
        return system.signal(pid, signal);
      },
    };
    const outcome = await stopService(watched, proc, systemClock, 300, 50);
    assert.ok(polls > 1, 'the group was not listed again after it was seen empty');
    assert.deepEqual(sent, [
      `group ${String(proc.pid)} SIGTERM`,
      `${String(strayPid)} SIGTERM`,
      `${String(stubborn)} SIGKILL`,
      `${String(strayPid)} SIGKILL`,
    ]);
    assert.equal(alive(stubborn), false);
    assert.equal(alive(joined), true, 'a process outside the proven set was signalled');
    assert.deepEqual(outcome, {
      kind: 'cant-tell',
      sent: 'SIGKILL',
      killed: { group: false, pids: [stubborn, strayPid] },
      reason: `processes ${String(joined)} in a process group of id ${String(proc.pid)} can't be proven ours; stop them with kill ${String(joined)}`,
    });
    assert.match(
      describeStop(proc, outcome),
      new RegExp(
        `^sent SIGTERM to api \\(pid \\d+, .*\\), then SIGKILL to processes ${String(stubborn)}, ${String(strayPid)}, but processes \\d+ in `,
      ),
    );
  });
}

test('a group seen empty after SIGTERM that a process joins once the service has exited is reported, and nothing is sent it', async t => {
  const p = project(t);
  const proc = await orphaned(p, 'node lingerer.mjs & exit 0', 0);
  const [lingerer] = system.groupMembers(proc.pid) ?? [];
  assert.ok(lingerer !== undefined);
  const newcomer = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => newcomer.kill('SIGKILL'));
  const joined = newcomer.pid ?? 0;
  const sent: string[] = [];
  let polls = 0;
  const watched: ServiceSystem = {
    ...system,
    groupMembers: pgid => {
      const members = system.groupMembers(pgid);
      if (sent.length === 0 || !members) return members;
      polls += 1;
      return polls === 1 ? [] : [...members, joined];
    },
    signalGroup: (pgid, signal) => {
      sent.push(`group ${String(pgid)} ${signal}`);
      return system.signalGroup(pgid, signal);
    },
    signal: (pid, signal) => {
      sent.push(`${String(pid)} ${signal}`);
      return system.signal(pid, signal);
    },
  };
  const outcome = await stopService(watched, proc, systemClock, 2000, 50);
  assert.deepEqual(sent, [`group ${String(proc.pid)} SIGTERM`]);
  assert.equal(alive(lingerer), false);
  assert.equal(alive(joined), true, 'a process outside the proven set was signalled');
  assert.deepEqual(outcome, {
    kind: 'cant-tell',
    sent: 'SIGTERM',
    reason: `processes ${String(joined)} in a process group of id ${String(proc.pid)} can't be proven ours; stop them with kill ${String(joined)}`,
  });
  assert.match(describeStop(proc, outcome), /^sent SIGTERM to api \(pid \d+, .*\), but processes \d+ in /);
});

test('once its group was seen empty, a process of the service that exits between the two listings of a poll is not taken for a newcomer', async t => {
  const p = project(t);
  const proc = await orphaned(p, "node -e 'setInterval(() => {}, 1e9)' & exit 0", 0);
  const [orphan] = system.groupMembers(proc.pid) ?? [];
  assert.ok(orphan !== undefined);
  const start = system.processes.startTimes([orphan])?.get(orphan) ?? '';
  let termed = false;
  let listings = 0;
  let groupListings = 0;
  const running = () => {
    listings += 1;
    return listings <= 3;
  };
  const exitsMidPoll: ServiceSystem = {
    ...system,
    running: pids => {
      if (!termed || !pids.includes(orphan)) return system.running(pids);
      return new Map(running() ? [[orphan, start]] : []);
    },
    groupMembers: pgid => {
      if (!termed) return system.groupMembers(pgid);
      groupListings += 1;
      return running() && groupListings > 1 ? [orphan] : [];
    },
    signalGroup: (pgid, signal) => {
      if (signal === 'SIGTERM') termed = true;
      return system.signalGroup(pgid, signal);
    },
  };
  assert.deepEqual(await stopService(exitsMidPoll, proc, systemClock, 1000, 50), { kind: 'stopped', signal: 'SIGTERM' });
});

const failures: [string, boolean][] = [
  ['one listing of its group fails right after SIGTERM', false],
  ['every listing fails after SIGTERM', true],
];
for (const [what, every] of failures) {
  test(`a live leader that ignores SIGTERM is not reported stopped, nor restarted beside itself, when ${what}`, async t => {
    const p = project(t);
    const proc = p.start(p.service('exec node ignorer.mjs'), 0);
    await until(() => fs.readFileSync(p.log, 'utf8').includes('ignoring SIGTERM'));
    let termed = false;
    let failed = 0;
    const failing: ServiceSystem = {
      ...system,
      running: pids => (termed && every ? undefined : system.running(pids)),
      groupMembers: pgid => {
        if (termed && (every || failed === 0)) {
          failed += 1;
          return undefined;
        }
        return system.groupMembers(pgid);
      },
      signalGroup: (pgid, signal) => {
        if (signal === 'SIGTERM') termed = true;
        return system.signalGroup(pgid, signal);
      },
    };
    const w = world();
    t.after(() => {
      w.close();
    });
    const owner = w.procs.owner();
    const { lane } = await w.registry().claim(w.request(owner, w.folder('a'), { device: null }));
    const ref = { id: lane.id, token: lane.token };
    w.registry().recordProcess(ref, proc);
    const services = {
      deps: { system: failing, clock: systemClock },
      registry: w.registry(),
      ref,
      lane,
      dir: p.dir,
      env: {},
    };
    const recorded = () =>
      w
        .registry()
        .status()
        .lanes[0]?.processes.map(r => r.pid);
    if (every) {
      await assert.rejects(stopClaimedService(services, proc), {
        message: new RegExp(
          `^service api can't be restarted: sent SIGTERM to api \\(pid ${String(proc.pid)}, .*\\), but ps could not read when processes ${String(proc.pid)} started, nor list process group ${String(proc.pid)}, so processes ${String(proc.pid)} can't be proven stopped; stop them with kill ${String(proc.pid)}$`,
        ),
      });
      assert.equal(alive(proc.pid), true);
      assert.deepEqual(recorded(), [proc.pid], 'the lane forgot a process that may still run');
    } else {
      assert.match(
        await stopClaimedService(services, proc),
        new RegExp(`^stopped api .* with SIGKILL to processes ${String(proc.pid)}, which SIGTERM did not end$`),
      );
      assert.equal(alive(proc.pid), false, 'the lane forgot a leader that still runs');
      assert.deepEqual(recorded(), []);
    }
    assert.ok(failed >= 1);
  });
}

function zombie(pid: number): boolean {
  return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    .stdout.trim()
    .startsWith('Z');
}

function recording(sent: string[]): ServiceSystem {
  return {
    ...system,
    signalGroup: (pgid, signal) => {
      sent.push(`group ${String(pgid)} ${signal}`);
      return system.signalGroup(pgid, signal);
    },
    signal: (pid, signal) => {
      sent.push(`${String(pid)} ${signal}`);
      return system.signal(pid, signal);
    },
  };
}

/** A leader that exits on SIGTERM, started by a parent blocked as in a long synchronous call, so it isn't reaped. */
async function unreapedLeader(t: TestContext, p: ReturnType<typeof project>): Promise<ServiceProcess> {
  const parent = spawn(process.execPath, [path.join(p.dir, 'parent.mjs'), 'setInterval(() => {}, 1e9)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  parent.stdout.on('data', (chunk: Buffer) => {
    out += String(chunk);
  });
  t.after(() => {
    const below = parent.pid;
    if (below !== undefined && parent.exitCode === null && parent.signalCode === null) {
      for (const child of system.descendants(below) ?? []) system.signal(child.pid, 'SIGKILL');
    }
    parent.kill('SIGKILL');
  });
  await until(() => out.endsWith('\n'));
  const pid = Number(out.trim());
  await until(() => system.groups([pid])?.get(pid) === pid);
  const start = system.processes.startTimes([pid])?.get(pid);
  assert.ok(start !== undefined);
  return { service: 'api', pid, start, cwd: null };
}

test('a leader that exits on SIGTERM while its parent does not reap it is reported stopped, and nothing more is sent', async t => {
  const p = project(t);
  const proc = await unreapedLeader(t, p);
  const sent: string[] = [];
  const outcome = await stopService(recording(sent), proc, systemClock, 1000, 50);
  assert.ok(zombie(proc.pid), 'the leader was reaped, so it was never a zombie here');
  assert.deepEqual(sent, [`group ${String(proc.pid)} SIGTERM`]);
  assert.deepEqual(outcome, { kind: 'stopped', signal: 'SIGTERM' });
});

test('a leader its parent left a zombie has exited: it is judged gone, and a stop sends nothing', async t => {
  const p = project(t);
  const proc = await unreapedLeader(t, p);
  system.signal(proc.pid, 'SIGTERM');
  await until(() => zombie(proc.pid));
  assert.equal(judgeLeader(system, proc), 'gone');
  assert.equal(judgeLeader(system, { ...proc, cwd: p.dir }), 'gone');
  const sent: string[] = [];
  assert.deepEqual(await stopService(recording(sent), proc, systemClock, 1000, 50), { kind: 'already-gone' });
  assert.deepEqual(sent, []);
  assert.ok(zombie(proc.pid), 'the leader was reaped, so it was never a zombie here');
});

const LEADER = 4242;
const STRAY = 6161;
const NEWCOMER = 5151;
const FAKE_START = 'Wed Nov 11 00:00:00 2026';
const fakeLeader: ServiceProcess = { service: 'api', pid: LEADER, start: FAKE_START, cwd: null };
const FAKE_GRACE_MS = 300;
const FAKE_POLL_MS = 100;
const GRACE_POLLS = FAKE_GRACE_MS / FAKE_POLL_MS + 1;

interface FakeProcess {
  pgid: number;
  ppid: number;
  endsOn: NodeJS.Signals[];
}

const leaderEndingOn = (...signals: NodeJS.Signals[]): FakeProcess => ({ pgid: LEADER, ppid: 1, endsOn: signals });
const strayEndingOn = (...signals: NodeJS.Signals[]): FakeProcess => ({ pgid: STRAY, ppid: LEADER, endsOn: signals });

interface Faults {
  /** Whether the nth read of start times since SIGTERM fails. */
  starts?: (n: number) => boolean;
  /** Whether the nth listing of the group since SIGTERM fails. */
  group?: (n: number) => boolean;
  /** Whether the nth read before SIGTERM of start times that include `pid` fails. */
  startsOf?: { pid: number; fails: (n: number) => boolean };
  /** Whether the nth listing of the processes below a pid fails. */
  descendants?: (n: number) => boolean;
  /** A process that is in the leader's group from the listing after the nth since SIGTERM. */
  joins?: { pid: number; after: number };
}

/** Fake processes, a clock each sleep moves on, and a record of the signals sent, with ps failing as `faults` say. */
function fakeStop(processes: Record<number, FakeProcess>, faults: Faults = {}) {
  let now = 0;
  const clock: Clock = {
    now: () => now,
    sleep: ms => {
      now += ms;
      return Promise.resolve();
    },
  };
  const live = new Map(Object.entries(processes).map(([pid, p]) => [Number(pid), p]));
  const sent: string[] = [];
  const reads = { starts: 0, group: 0, startsOf: 0, descendants: 0 };
  let termed = false;
  const deliver = (pid: number, signal: NodeJS.Signals) => {
    const p = live.get(pid);
    if (p?.endsOn.includes(signal)) live.delete(pid);
    return p !== undefined;
  };
  const members = (pgid: number) => [...live].filter(([, p]) => p.pgid === pgid).map(([pid]) => pid);
  const running = (pids: readonly number[]) => {
    if (termed && pids.length > 0) {
      reads.starts += 1;
      if (faults.starts?.(reads.starts)) return undefined;
    }
    if (!termed && faults.startsOf && pids.includes(faults.startsOf.pid)) {
      reads.startsOf += 1;
      if (faults.startsOf.fails(reads.startsOf)) return undefined;
    }
    return new Map(pids.filter(pid => live.has(pid)).map(pid => [pid, FAKE_START] as const));
  };
  const fake: ServiceSystem = {
    processes: { startTimes: running, info: () => undefined, cwd: () => undefined },
    running,
    spawnGroup: () => {
      throw new Error('the fake starts nothing');
    },
    listeners: () => [],
    groups: pids => new Map(pids.flatMap(pid => (live.has(pid) ? [[pid, live.get(pid)?.pgid ?? 0] as const] : []))),
    groupMembers: pgid => {
      if (!termed) return members(pgid);
      reads.group += 1;
      if (faults.joins && reads.group > faults.joins.after) {
        live.set(faults.joins.pid, { pgid: LEADER, ppid: 1, endsOn: ['SIGTERM', 'SIGKILL'] });
      }
      return faults.group?.(reads.group) ? undefined : members(pgid);
    },
    descendants: pid => {
      reads.descendants += 1;
      if (faults.descendants?.(reads.descendants)) return undefined;
      return [...live].filter(([, p]) => p.ppid === pid).map(([child, p]) => ({ pid: child, pgid: p.pgid }));
    },
    signalGroup: (pgid, signal) => {
      sent.push(`group ${String(pgid)} ${signal}`);
      if (signal === 'SIGTERM') termed = true;
      return members(pgid).filter(pid => deliver(pid, signal)).length > 0;
    },
    signal: (pid, signal) => {
      sent.push(`${String(pid)} ${signal}`);
      return deliver(pid, signal);
    },
  };
  return {
    stop: (proc = fakeLeader) => stopService(fake, proc, clock, FAKE_GRACE_MS, FAKE_POLL_MS),
    system: fake,
    sent,
    live,
  };
}

const fakeWho = `api (pid ${String(LEADER)}, started ${FAKE_START} UTC)`;

const notSentSigkill = (pids: string) =>
  `processes ${pids} remain: ps could not read when they started, so they were not sent SIGKILL; stop them with kill ${pids}`;

const groupKilled: Killed = { group: true, pids: [] };

const unsentKills: {
  what: string;
  processes: Record<number, FakeProcess>;
  faults: Faults;
  sent: string[];
  killed?: Killed;
  reason: string;
}[] = [
  {
    what: 'a leader that ignored SIGTERM, when a listing of its group failed during the grace',
    processes: { [LEADER]: leaderEndingOn('SIGKILL') },
    faults: { group: n => n === 1, starts: n => n === GRACE_POLLS + 1 },
    sent: [`group ${String(LEADER)} SIGTERM`],
    reason: notSentSigkill(String(LEADER)),
  },
  {
    what: 'a process that left the group, when the group got SIGKILL',
    processes: { [LEADER]: leaderEndingOn('SIGKILL'), [STRAY]: strayEndingOn('SIGKILL') },
    faults: { starts: n => n === GRACE_POLLS + 1 },
    sent: [`group ${String(LEADER)} SIGTERM`, `${String(STRAY)} SIGTERM`, `group ${String(LEADER)} SIGKILL`],
    killed: groupKilled,
    reason: notSentSigkill(String(STRAY)),
  },
  {
    what: 'a process that left the group, beside a leader that survived the SIGKILL it was sent',
    processes: { [LEADER]: leaderEndingOn(), [STRAY]: strayEndingOn('SIGKILL') },
    faults: { starts: n => n === GRACE_POLLS + 1 },
    sent: [`group ${String(LEADER)} SIGTERM`, `${String(STRAY)} SIGTERM`, `group ${String(LEADER)} SIGKILL`],
    killed: groupKilled,
    reason: `${notSentSigkill(String(STRAY))}; processes ${String(LEADER)} survived SIGKILL`,
  },
];
for (const c of unsentKills) {
  test(`${c.what}, is not said to have survived a SIGKILL it was not sent because its start time could not be read`, async () => {
    const f = fakeStop(c.processes, c.faults);
    const outcome = await f.stop();
    assert.deepEqual(f.sent, c.sent);
    assert.deepEqual(
      outcome,
      c.killed
        ? { kind: 'cant-tell', sent: 'SIGKILL', killed: c.killed, reason: c.reason }
        : { kind: 'cant-tell', sent: 'SIGTERM', reason: c.reason },
    );
    assert.equal(
      describeStop(fakeLeader, outcome),
      `sent SIGTERM to ${fakeWho}${c.killed ? `, then SIGKILL to process group ${String(LEADER)}` : ''}, but ${c.reason}`,
    );
  });
}

test('a process that survives SIGKILL is reported with a process in its group not proven ours, and only the proven one is signalled', async () => {
  const f = fakeStop({ [LEADER]: leaderEndingOn() }, { group: n => n === 1, joins: { pid: NEWCOMER, after: 1 } });
  const outcome = await f.stop();
  assert.deepEqual(f.sent, [`group ${String(LEADER)} SIGTERM`, `${String(LEADER)} SIGKILL`]);
  assert.ok(f.live.has(NEWCOMER));
  assert.deepEqual(outcome, { kind: 'survived', members: [LEADER], unproven: [NEWCOMER] });
  assert.equal(
    describeStop(fakeLeader, outcome),
    `api (pid ${String(LEADER)}, started ${FAKE_START} UTC) survived SIGKILL: processes ${String(LEADER)} remain; processes ${String(NEWCOMER)} in a process group of id ${String(LEADER)} can't be proven ours; stop them with kill ${String(NEWCOMER)}`,
  );
});

const failedReads: { what: string; faults: Faults; sent: string[]; killed: Killed; reason: string }[] = [
  {
    what: 'read start times, though it could list the group',
    faults: { starts: () => true },
    sent: [`group ${String(LEADER)} SIGTERM`, `group ${String(LEADER)} SIGKILL`],
    killed: groupKilled,
    reason: `ps could not read when processes ${String(LEADER)} started, so processes ${String(LEADER)} can't be proven stopped; stop them with kill ${String(LEADER)}`,
  },
  {
    what: 'list the group, though it could read start times',
    faults: { group: () => true },
    sent: [`group ${String(LEADER)} SIGTERM`, `${String(LEADER)} SIGKILL`],
    killed: { group: false, pids: [LEADER] },
    reason: `ps could not list process group ${String(LEADER)}, so it can't be proven stopped`,
  },
];
for (const c of failedReads) {
  test(`a stop whose last poll could not ${c.what}, names the read that failed`, async () => {
    const f = fakeStop({ [LEADER]: leaderEndingOn('SIGKILL') }, c.faults);
    const outcome = await f.stop();
    assert.deepEqual(f.sent, c.sent);
    assert.deepEqual(outcome, { kind: 'cant-tell', sent: 'SIGKILL', killed: c.killed, reason: c.reason });
  });
}

const strayReads: { what: string; twice: Faults; once: Faults; reason: string }[] = [
  {
    what: 'list the processes below its leader',
    twice: { descendants: n => n <= 2 },
    once: { descendants: n => n === 1 },
    reason: `ps could not list the processes below pid ${String(LEADER)}, so any of them outside process group ${String(LEADER)} were not found and were sent nothing`,
  },
  {
    what: 'read when the processes below its leader started',
    twice: { startsOf: { pid: STRAY, fails: n => n <= 2 } },
    once: { startsOf: { pid: STRAY, fails: n => n === 1 } },
    reason: `ps could not read when processes ${String(STRAY)} started, so they were sent nothing; stop them with kill ${String(STRAY)}`,
  },
];
const leaderEnds: { on: string; leader: FakeProcess; sent: string[]; killed?: Killed }[] = [
  { on: 'SIGTERM', leader: leaderEndingOn('SIGTERM'), sent: [`group ${String(LEADER)} SIGTERM`] },
  {
    on: 'the SIGKILL after the grace',
    leader: leaderEndingOn('SIGKILL'),
    sent: [`group ${String(LEADER)} SIGTERM`, `group ${String(LEADER)} SIGKILL`],
    killed: groupKilled,
  },
];
for (const c of strayReads) {
  for (const l of leaderEnds) {
    test(`a stop that could not ${c.what}, though it asked twice, stops a leader that ends on ${l.on}, sends nothing outside its group, and names the read`, async () => {
      const f = fakeStop({ [LEADER]: l.leader, [STRAY]: strayEndingOn('SIGTERM', 'SIGKILL') }, c.twice);
      const outcome = await f.stop();
      assert.deepEqual(f.sent, l.sent);
      assert.ok(!f.live.has(LEADER), 'the leader outlived the stop');
      assert.ok(f.live.has(STRAY), "a process not proven the service's was signalled");
      assert.deepEqual(
        outcome,
        l.killed
          ? { kind: 'cant-tell', sent: 'SIGKILL', killed: l.killed, reason: c.reason }
          : { kind: 'cant-tell', sent: 'SIGTERM', reason: c.reason },
      );
      assert.equal(
        describeStop(fakeLeader, outcome),
        `sent SIGTERM to ${fakeWho}${l.killed ? `, then SIGKILL to process group ${String(LEADER)}` : ''}, but ${c.reason}`,
      );
    });
  }
  test(`a stop that could not ${c.what} once, and could when it asked again, stops as if ps had not failed`, async () => {
    const processes = { [LEADER]: leaderEndingOn('SIGTERM'), [STRAY]: strayEndingOn('SIGKILL') };
    const unfailing = fakeStop(processes);
    const expected = await unfailing.stop();
    const f = fakeStop(processes, c.once);
    const outcome = await f.stop();
    assert.deepEqual(outcome, expected);
    assert.deepEqual(f.sent, unfailing.sent);
    assert.deepEqual(f.sent, [`group ${String(LEADER)} SIGTERM`, `${String(STRAY)} SIGTERM`, `${String(STRAY)} SIGKILL`]);
    assert.deepEqual(outcome, { kind: 'stopped', signal: 'SIGKILL', killed: { group: false, pids: [STRAY] } });
    assert.equal(f.live.size, 0);
  });
}

const strayFates: { on: string; stray: FakeProcess; sent: string[]; outcome: StopOutcome; line: string }[] = [
  {
    on: 'SIGTERM',
    stray: strayEndingOn('SIGTERM'),
    sent: [`group ${String(LEADER)} SIGTERM`, `${String(STRAY)} SIGTERM`],
    outcome: { kind: 'stopped', signal: 'SIGTERM' },
    line: `stopped ${fakeWho}`,
  },
  {
    on: 'SIGKILL only',
    stray: strayEndingOn('SIGKILL'),
    sent: [`group ${String(LEADER)} SIGTERM`, `${String(STRAY)} SIGTERM`, `${String(STRAY)} SIGKILL`],
    outcome: { kind: 'stopped', signal: 'SIGKILL', killed: { group: false, pids: [STRAY] } },
    line: `stopped ${fakeWho} with SIGKILL to processes ${String(STRAY)}, which SIGTERM did not end`,
  },
];
for (const c of strayFates) {
  test(`when the first read of start times after SIGTERM fails, a process outside the group that ends on ${c.on} is sent SIGTERM before any SIGKILL, and the line says what it was sent`, async () => {
    const f = fakeStop({ [LEADER]: leaderEndingOn('SIGTERM'), [STRAY]: c.stray }, { starts: n => n === 1 });
    const outcome = await f.stop();
    assert.deepEqual(f.sent, c.sent);
    assert.equal(f.live.size, 0);
    assert.deepEqual(outcome, c.outcome);
    assert.equal(describeStop(fakeLeader, outcome), c.line);
  });
}

const leaderReads: { what: string; faults: Faults; proc: ServiceProcess; unread: string }[] = [
  {
    what: 'start time',
    faults: { startsOf: { pid: LEADER, fails: () => true } },
    proc: fakeLeader,
    unread: 'ps could not read when it started',
  },
  {
    what: 'working directory',
    faults: {},
    proc: { ...fakeLeader, cwd: '/srv/api' },
    unread: 'its working directory could not be read',
  },
];
for (const c of leaderReads) {
  test(`a leader whose ${c.what} can't be read is left alone, and the stop and the inspection name that read`, async () => {
    const f = fakeStop({ [LEADER]: leaderEndingOn('SIGTERM') }, c.faults);
    const outcome = await f.stop(c.proc);
    const reason = `pid ${String(LEADER)} could not be checked: ${c.unread}`;
    assert.deepEqual(f.sent, []);
    assert.deepEqual(outcome, { kind: 'cant-tell', reason });
    assert.equal(describeStop(c.proc, outcome), `left ${fakeWho} alone: ${reason}`);
    const config: ServiceConfig = {
      name: 'api',
      type: 'api',
      ports: null,
      start: 'true',
      cwd: '/srv/api',
      ready: { kind: 'tcp', host: '127.0.0.1' },
      timeoutMs: 1000,
      dial: null,
      platforms: null,
    };
    assert.ok(explainInspection(await inspectService(f.system, config, 1, c.proc)).startsWith(`${reason}; `));
  });
}

test('a start time is read only in the form ps prints it', () => {
  assert.equal(startMs('Mon Jan  1 00:00:00 2024'), Date.UTC(2024, 0, 1));
  assert.equal(startMs('Tue Nov 10 21:05:09 2026'), Date.UTC(2026, 10, 10, 21, 5, 9));
  assert.ok(Number.isNaN(startMs('lun. 10 nov. 2026 21:05:09')));
  assert.ok(Number.isNaN(startMs('2026-11-10T21:05:09Z')));
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
