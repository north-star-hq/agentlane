import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { systemClock } from '../../src/clock.ts';
import type { ServiceConfig } from '../../src/project/config.ts';
import { startMs } from '../../src/processes.ts';
import type { ServiceProcess } from '../../src/registry/types.ts';
import {
  describeStop,
  explainInspection,
  inspectService,
  leaderAliveAt,
  listenersOn,
  probeReady,
  ServiceFailed,
  startService,
  stopService,
  waitForService,
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
    {
      ...system,
      processes: {
        ...system.processes,
        startTimes: pids => (pids.includes(proc.pid) ? system.processes.startTimes(pids) : undefined),
      },
    },
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
    assert.deepEqual(outcome, { kind: 'stopped', signal: 'SIGKILL' });
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
      reason: `processes ${String(joined)} in a process group of id ${String(proc.pid)} can't be proven ours; stop them with kill ${String(joined)}`,
    });
    assert.match(describeStop(proc, outcome), /^sent SIGTERM, then SIGKILL, to api \(pid \d+, .*\), but processes \d+ in /);
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
    processes: {
      ...system.processes,
      startTimes: pids => {
        if (!termed || !pids.includes(orphan)) return system.processes.startTimes(pids);
        return new Map(running() ? [[orphan, start]] : []);
      },
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
      processes: {
        ...system.processes,
        startTimes: pids => (termed && every ? undefined : system.processes.startTimes(pids)),
      },
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
          `^service api can't be restarted: sent SIGTERM to api \\(pid ${String(proc.pid)}, .*\\), but ps could not list what is left in process group ${String(proc.pid)}, so processes ${String(proc.pid)} can't be proven stopped; stop them with kill ${String(proc.pid)}$`,
        ),
      });
      assert.equal(alive(proc.pid), true);
      assert.deepEqual(recorded(), [proc.pid], 'the lane forgot a process that may still run');
    } else {
      assert.match(await stopClaimedService(services, proc), /^stopped api .* with SIGKILL after SIGTERM was ignored$/);
      assert.equal(alive(proc.pid), false, 'the lane forgot a leader that still runs');
      assert.deepEqual(recorded(), []);
    }
    assert.ok(failed >= 1);
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
