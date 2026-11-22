import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { systemClock } from '../../src/clock.ts';
import { systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { realServiceSystem, type ServiceSystem } from '../../src/services/system.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { execInLane } from '../../src/up/exec.ts';
import { FakeProcesses, tempDir } from '../support/fakes.ts';
import { alive, API, METRO, toolchain, until, WEB } from '../support/up-world.ts';

const CLI = path.resolve(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const CALLER_GONE = 129;
const LIMIT = { timeout: 30_000 };

interface HeldLane {
  worktree: string;
  state: string;
  env: NodeJS.ProcessEnv;
}

async function heldLane(): Promise<HeldLane> {
  const root = fs.realpathSync(tempDir('exec'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(state, 'config.json'),
    JSON.stringify({ ports: { metro: [METRO, METRO + 3], api: [API, API + 3], web: [WEB, WEB + 3] } }),
  );
  const worktree = path.join(root, 'work');
  fs.mkdirSync(worktree);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTLANE_STATE_DIR: state,
    AGENTLANE_OWNER_PID: String(process.pid),
  };
  const out: string[] = [];
  const code = await runRegistryCommand('claim', ['--no-device', '--worktree', worktree], {
    env,
    cwd: worktree,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: {},
  });
  assert.equal(code, 0, out.join(''));
  return { worktree, state, env };
}

function deps(lane: HeldLane, over: Partial<EnvDeps> = {}): EnvDeps {
  return {
    env: lane.env,
    cwd: lane.worktree,
    log: () => undefined,
    processes: systemProcesses,
    ports: tcpProbe,
    devices: {},
    sim: null,
    system: realServiceSystem,
    toolchain: toolchain(),
    startDriver: () => Promise.resolve(),
    clock: systemClock,
    ...over,
  };
}

function recordedPids(file: string): number[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(Number)
    : [];
}

function killLeftovers(t: TestContext, pids: () => readonly number[]): void {
  t.after(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        continue;
      }
    }
  });
}

function lastUsedAt(lane: HeldLane): number | undefined {
  return readRegistryStatus({ dir: lane.state, processes: systemProcesses }).lanes[0]?.lastUsedAt;
}

const STUBBORN = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

const TREE = `pids=$1
sleep 300 &
echo $! >> "$pids"
/bin/sh -c 'sleep 300 & echo $! >> "$1"; wait' inner "$pids" &
echo $! >> "$pids"
echo $$ >> "$pids"
echo $PPID >> "$pids"
wait
`;

test('killing the shell that ran exec ends exec, its command and every process below it within seconds', LIMIT, async t => {
  const lane = await heldLane();
  const pids = path.join(lane.worktree, 'pids');
  const fixture = path.join(lane.worktree, 'tree.sh');
  fs.writeFileSync(fixture, TREE);
  const log = path.join(lane.worktree, 'exec.log');
  const logFd = fs.openSync(log, 'a');
  const shell = spawn(
    '/bin/sh',
    ['-c', '"$@"; echo "exec exited $?"', 'sh', process.execPath, CLI, 'exec', '--', '/bin/sh', fixture, pids],
    { cwd: lane.worktree, env: lane.env, detached: true, stdio: ['ignore', logFd, logFd] },
  );
  fs.closeSync(logFd);
  const shellPid = shell.pid ?? 0;
  killLeftovers(t, () => [-shellPid, ...recordedPids(pids)]);
  const told = () => fs.readFileSync(log, 'utf8');

  await until(() => recordedPids(pids).length === 5, 20_000).catch(() => assert.fail(`the tree never started:\n${told()}`));
  const tree = recordedPids(pids);
  assert.ok(
    tree.every(pid => alive(pid)),
    `every process of the tree runs before the shell is killed: ${tree.join(' ')}`,
  );

  process.kill(shellPid, 'SIGKILL');
  const killedAt = Date.now();
  await until(() => tree.every(pid => !alive(pid)), 10_000).catch(() =>
    assert.fail(`still running: ${tree.filter(pid => alive(pid)).join(' ')} of ${tree.join(' ')}\n${told()}`),
  );
  const tookMs = Date.now() - killedAt;
  assert.ok(tookMs < 5000, `the tree took ${String(tookMs)} ms to go`);
  assert.doesNotMatch(told(), /exec exited/, 'the shell was killed before exec ended');
});

const RUNNER = `echo $$ > "$1"
shift
"$@"
echo "exec exited $?"
`;

test(
  'killing the shell above a runner that waits on exec, as npx does, ends exec and every process below it, and exec exits 129',
  LIMIT,
  async t => {
    const lane = await heldLane();
    const pids = path.join(lane.worktree, 'pids');
    const runnerPid = path.join(lane.worktree, 'runner-pid');
    const fixture = path.join(lane.worktree, 'tree.sh');
    const runner = path.join(lane.worktree, 'runner.sh');
    fs.writeFileSync(fixture, TREE);
    fs.writeFileSync(runner, RUNNER);
    const log = path.join(lane.worktree, 'exec.log');
    const logFd = fs.openSync(log, 'a');
    const shell = spawn(
      '/bin/sh',
      [
        '-c',
        '"$@"; echo "runner exited $?"',
        'sh',
        '/bin/sh',
        runner,
        runnerPid,
        process.execPath,
        CLI,
        'exec',
        '--',
        '/bin/sh',
        fixture,
        pids,
      ],
      { cwd: lane.worktree, env: lane.env, detached: true, stdio: ['ignore', logFd, logFd] },
    );
    fs.closeSync(logFd);
    const shellPid = shell.pid ?? 0;
    killLeftovers(t, () => [-shellPid, ...recordedPids(runnerPid), ...recordedPids(pids)]);
    const told = () => fs.readFileSync(log, 'utf8');

    await until(() => recordedPids(pids).length === 5, 20_000).catch(() => assert.fail(`the tree never started:\n${told()}`));
    const tree = recordedPids(pids);
    const [middle = 0] = recordedPids(runnerPid);
    const parentOf = (pid: number) => Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout);
    assert.ok(
      tree.some(pid => parentOf(pid) === middle),
      `exec, in ${tree.join(' ')}, runs under the runner ${String(middle)}, not under the shell`,
    );

    process.kill(shellPid, 'SIGKILL');
    const killedAt = Date.now();
    await until(() => tree.every(pid => !alive(pid)), 10_000).catch(() =>
      assert.fail(`still running: ${tree.filter(pid => alive(pid)).join(' ')} of ${tree.join(' ')}\n${told()}`),
    );
    const tookMs = Date.now() - killedAt;
    assert.ok(tookMs < 5000, `the tree took ${String(tookMs)} ms to go`);
    await until(() => told().includes('exec exited'), 5000).catch(() => assert.fail(`the runner never saw exec end:\n${told()}`));
    assert.match(told(), /^exec exited 129$/m, 'the runner outlived the shell and saw exec exit 129');
    assert.doesNotMatch(told(), /runner exited/, 'the shell was killed before the runner ended');
  },
);

test('a command that ignores SIGTERM gets SIGKILL once the grace is over, and exec then exits 129', LIMIT, async t => {
  const lane = await heldLane();
  const pidFile = path.join(lane.worktree, 'pid');
  const lines: string[] = [];
  let gone = false;
  const graceMs = 1500;
  const running = execInLane(
    deps(lane, {
      parentPid: () => (gone ? 1 : process.ppid),
      callerPollMs: 20,
      stopGraceMs: graceMs,
      heartbeatMs: 20,
      log: line => lines.push(line),
    }),
    [process.execPath, '-e', `${STUBBORN} require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`],
  );
  killLeftovers(t, () => recordedPids(pidFile));
  await until(() => recordedPids(pidFile).length === 1, 20_000);
  const [pid = 0] = recordedPids(pidFile);

  gone = true;
  const goneAt = Date.now();
  await sleep(graceMs / 2);
  assert.ok(alive(pid), 'SIGTERM did not end the command');
  assert.equal(await running, CALLER_GONE);
  assert.ok(Date.now() - goneAt >= graceMs, 'exec waited out the grace');
  assert.equal(alive(pid), false, 'SIGKILL ended the command');

  const touched = lastUsedAt(lane);
  await sleep(200);
  assert.equal(lastUsedAt(lane), touched, 'nothing touches the lane once exec has returned');
  assert.deepEqual(lines, [], 'exec writes nothing, since its stderr may have no reader left');
});

test(
  'a process the command started that ignores SIGTERM is killed after the grace even once its parent is gone',
  LIMIT,
  async t => {
    const lane = await heldLane();
    const pids = path.join(lane.worktree, 'pids');
    let gone = false;
    const graceMs = 2000;
    const running = execInLane(
      deps(lane, { parentPid: () => (gone ? 1 : process.ppid), callerPollMs: 20, stopGraceMs: graceMs }),
      ['/bin/sh', '-c', '"$1" -e "$2" & echo $! > "$3"; echo $$ >> "$3"; wait', 'sh', process.execPath, STUBBORN, pids],
    );
    killLeftovers(t, () => recordedPids(pids));
    await until(() => recordedPids(pids).length === 2, 20_000);
    const [stubborn = 0, shell = 0] = recordedPids(pids);

    gone = true;
    await until(() => !alive(shell), graceMs - 500);
    assert.ok(alive(stubborn), 'the shell took SIGTERM and left the stubborn process behind');
    assert.equal(await running, CALLER_GONE);
    await until(() => !alive(stubborn), 2000).catch(() => assert.fail('SIGKILL reached the process the shell left behind'));
  },
);

const WRITE_PID_THEN_SLEEP = ['/bin/sh', '-c', 'echo $$ > "$1"; exec sleep 30', 'sh'];

test('a process above exec whose pid now belongs to a process started later counts as gone', LIMIT, async t => {
  const lane = await heldLane();
  const pidFile = path.join(lane.worktree, 'pid');
  const table = new FakeProcesses();
  const [runner, shell] = table.tree(['npm exec', 'zsh']);
  assert.ok(runner && shell);
  const system: ServiceSystem = { ...realServiceSystem, processes: table, running: pids => table.startTimes(pids) };
  const running = execInLane(deps(lane, { system, parentPid: () => runner.pid, callerPollMs: 20 }), [
    ...WRITE_PID_THEN_SLEEP,
    pidFile,
  ]);
  killLeftovers(t, () => recordedPids(pidFile));
  await until(() => recordedPids(pidFile).length === 1, 20_000);
  const [pid = 0] = recordedPids(pidFile);
  await sleep(200);
  assert.ok(alive(pid), 'the command runs while every process above exec does');

  table.recycle(shell.pid);
  assert.equal(await running, CALLER_GONE);
  assert.equal(alive(pid), false);
});

test("when exec can't read the processes above it, it runs the command and watches its parent alone", LIMIT, async t => {
  const lane = await heldLane();
  const pidFile = path.join(lane.worktree, 'pid');
  const listed: number[][] = [];
  const system: ServiceSystem = {
    ...realServiceSystem,
    processes: { ...systemProcesses, info: () => undefined },
    running: pids => {
      listed.push([...pids]);
      return realServiceSystem.running(pids);
    },
  };
  let gone = false;
  const running = execInLane(deps(lane, { system, parentPid: () => (gone ? 1 : process.ppid), callerPollMs: 20 }), [
    ...WRITE_PID_THEN_SLEEP,
    pidFile,
  ]);
  killLeftovers(t, () => recordedPids(pidFile));
  await until(() => recordedPids(pidFile).length === 1, 20_000);
  const [pid = 0] = recordedPids(pidFile);
  await sleep(200);
  assert.ok(alive(pid), 'the command runs');
  assert.deepEqual(listed, [], 'with no processes above it recorded, a check lists none');

  gone = true;
  assert.equal(await running, CALLER_GONE);
  assert.equal(alive(pid), false);
});

test('a caller gone before the command starts means the command never runs', LIMIT, async () => {
  const lane = await heldLane();
  const marker = path.join(lane.worktree, 'ran');
  let reads = 0;
  const code = await execInLane(deps(lane, { parentPid: () => (reads++ === 0 ? process.ppid : 1) }), [
    '/bin/sh',
    '-c',
    `touch '${marker}'`,
  ]);
  assert.equal(code, CALLER_GONE);
  assert.equal(fs.existsSync(marker), false);
});

test(
  'while its caller lives, exec checks on it about once a second, with one process listing a check, and stops checking when the command ends',
  LIMIT,
  async () => {
    const lane = await heldLane();
    let reads = 0;
    let listings = 0;
    let listingsAtFirstCheck = 0;
    const system: ServiceSystem = {
      ...realServiceSystem,
      processes: {
        ...systemProcesses,
        info: pid => {
          listings++;
          return systemProcesses.info(pid);
        },
      },
      running: pids => {
        listings++;
        return realServiceSystem.running(pids);
      },
    };
    const startedAt = Date.now();
    const code = await execInLane(
      deps(lane, {
        system,
        parentPid: () => {
          reads++;
          if (reads === 2) listingsAtFirstCheck = listings;
          return process.ppid;
        },
      }),
      ['sleep', '2.5'],
    );
    const seconds = (Date.now() - startedAt) / 1000;
    assert.equal(code, 0);
    assert.ok(reads >= 3 && reads <= seconds + 3, `${String(reads)} reads of the parent pid in ${seconds.toFixed(1)} s`);
    assert.ok(listingsAtFirstCheck > 0, 'exec read the processes above it at start');
    assert.equal(listings - listingsAtFirstCheck, reads - 1, 'each check lists processes once');
    const atEnd = reads;
    await sleep(1500);
    assert.equal(reads, atEnd, 'the checks stopped with the command');
  },
);

test('Ctrl-C reaches the command through the process group, and exec returns the code the command exits with', LIMIT, async t => {
  const lane = await heldLane();
  const ready = path.join(lane.worktree, 'ready');
  const exec = spawn(
    process.execPath,
    [
      CLI,
      'exec',
      '--',
      process.execPath,
      '-e',
      `process.on('SIGINT', () => process.exit(42)); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000);`,
    ],
    { cwd: lane.worktree, env: lane.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const group = exec.pid ?? 0;
  killLeftovers(t, () => [-group]);
  let stderr = '';
  exec.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const ended = new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
    exec.once('close', (code, signal) => {
      resolve([code, signal]);
    });
  });
  await until(() => fs.existsSync(ready), 20_000).catch(() => assert.fail(`the command never started:\n${stderr}`));

  process.kill(-group, 'SIGINT');
  assert.deepEqual(await ended, [42, null], stderr);
});

test('a command under exec reads what was piped to exec', LIMIT, async () => {
  const lane = await heldLane();
  const result = spawnSync(process.execPath, [CLI, 'exec', '--', '/bin/sh', '-c', 'read line; echo "got: $line"'], {
    cwd: lane.worktree,
    env: lane.env,
    input: 'hello from the caller\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'got: hello from the caller\n');
});
