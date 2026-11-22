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
import { realServiceSystem } from '../../src/services/system.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { execInLane } from '../../src/up/exec.ts';
import { tempDir } from '../support/fakes.ts';
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
  'while its caller lives, exec checks on it about once a second and stops checking when the command ends',
  LIMIT,
  async () => {
    const lane = await heldLane();
    let reads = 0;
    const startedAt = Date.now();
    const code = await execInLane(
      deps(lane, {
        parentPid: () => {
          reads++;
          return process.ppid;
        },
      }),
      ['sleep', '2.5'],
    );
    const seconds = (Date.now() - startedAt) / 1000;
    assert.equal(code, 0);
    assert.ok(reads >= 3 && reads <= seconds + 3, `${String(reads)} reads of the parent pid in ${seconds.toFixed(1)} s`);
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
