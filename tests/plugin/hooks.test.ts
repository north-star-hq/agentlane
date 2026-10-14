import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { HookDeps } from '../../src/plugin/hook-cli.ts';
import { runHookCommand, SESSION_END_OWNER_ENV } from '../../src/plugin/hook-cli.ts';
import { claudeSessionName } from '../../src/plugin/session-name.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { FakeDevices, tempDir } from '../support/fakes.ts';
import { portBlock } from '../support/ports.ts';

const PORTS = await portBlock();

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const SESSION_END_TIMEOUT_S = (
  JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'claude.json'), 'utf8')) as {
    hooks: { SessionEnd: [{ hooks: [{ timeout: number }] }] };
  }
).hooks.SessionEnd[0].hooks[0].timeout;

function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
}

interface Setup {
  root: string;
  stateDir: string;
  devices: FakeDevices;
  folder: (name: string) => string;
}

function setup(label: string): Setup {
  const root = tempDir(label);
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({
      poolSize: 3,
      ports: { metro: [PORTS, PORTS + 3], api: [PORTS + 10, PORTS + 13], web: [PORTS + 20, PORTS + 23] },
    }),
  );
  return {
    root,
    stateDir,
    devices: new FakeDevices(path.join(root, 'devices')),
    folder: name => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      return fs.realpathSync(dir);
    },
  };
}

function deps(s: Setup, env: NodeJS.ProcessEnv, out: string[], extra: Partial<HookDeps> = {}): HookDeps {
  return {
    env: { AGENTLANE_STATE_DIR: s.stateDir, ...env },
    cwd: s.root,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: { ios: s.devices },
    stdin: '',
    startWorker: () => {
      throw new Error('no worker expected');
    },
    ...extra,
  };
}

async function lane(s: Setup, env: NodeJS.ProcessEnv, folder: string, ...args: string[]): Promise<string> {
  const out: string[] = [];
  const code = await runRegistryCommand('claim', ['--worktree', folder, '--json', ...args], deps(s, env, out));
  assert.equal(code, 0, out.join(''));
  return (JSON.parse(out.join('')) as { lane: { id: string; device: { id: string } | null } }).lane.device?.id ?? '';
}

function laneIds(s: Setup): string[] {
  return readRegistryStatus({ dir: s.stateDir, processes: systemProcesses, devices: {} }).lanes.map(c => c.worktree);
}

test('pre-tool-use denies an install on another session’s simulator, naming the holder, and allows my own', async () => {
  const s = setup('hook-pre');
  const other = sleeper();
  const me = sleeper();
  try {
    const theirs = await lane(s, { AGENTLANE_OWNER_PID: String(other.pid) }, s.folder('other'));
    const mine = await lane(s, { AGENTLANE_OWNER_PID: String(me.pid) }, s.folder('mine'));
    const input = (command: string, tool = 'Bash') =>
      JSON.stringify({
        session_id: 's',
        cwd: s.folder('mine'),
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: { command },
      });

    const out: string[] = [];
    const code = await runHookCommand(
      ['pre-tool-use'],
      deps(s, { AGENTLANE_OWNER_PID: String(me.pid) }, out, { stdin: input(`xcrun simctl install ${theirs} App.app`) }),
    );
    assert.equal(code, 0);
    const decision = JSON.parse(out.join('')) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
    const reason = decision.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes(`held by process ${String(other.pid)} in ${s.folder('other')}`), reason);
    assert.match(reason, /agentlane release --lane \w+ --force/);
    assert.ok(reason.includes(`aim at your own simulator: ${mine}`), reason);

    for (const stdin of [input(`xcrun simctl install ${mine} App.app`), input('xcrun simctl list'), input('ls', 'Read'), '']) {
      const quiet: string[] = [];
      assert.equal(await runHookCommand(['pre-tool-use'], deps(s, { AGENTLANE_OWNER_PID: String(me.pid) }, quiet, { stdin })), 0);
      assert.equal(quiet.join(''), '', stdin);
    }
  } finally {
    other.kill('SIGKILL');
    me.kill('SIGKILL');
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('session-end releases every lane of the session in a worker, leaves other sessions’ lanes, and skips /clear', async () => {
  const s = setup('hook-end');
  const other = sleeper();
  const me = sleeper();
  try {
    const mine = { AGENTLANE_OWNER_PID: String(me.pid) };
    await lane(s, mine, s.folder('mine-a'));
    await lane(s, mine, s.folder('mine-b'), '--no-device');
    await lane(s, { AGENTLANE_OWNER_PID: String(other.pid) }, s.folder('other'));
    assert.equal(laneIds(s).length, 3);

    const workers: NodeJS.ProcessEnv[] = [];
    const out: string[] = [];
    const startWorker = (env: NodeJS.ProcessEnv) => workers.push(env);
    for (const reason of ['clear', 'resume']) {
      const stdin = JSON.stringify({ hook_event_name: 'SessionEnd', reason });
      assert.equal(await runHookCommand(['session-end'], deps(s, mine, out, { stdin, startWorker })), 0);
    }
    assert.equal(workers.length, 0);

    const stdin = JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    assert.equal(await runHookCommand(['session-end'], deps(s, mine, out, { stdin, startWorker })), 0);
    assert.equal(workers.length, 1);
    assert.match(out.join(''), /releasing 2 lane\(s\) of process \d+ in the background/);
    assert.equal(laneIds(s).length, 3, 'the hook itself releases nothing');

    const [worker] = workers;
    assert.ok(worker?.[SESSION_END_OWNER_ENV]);
    assert.equal(await runHookCommand(['session-end'], deps(s, worker, out)), 0, out.join(''));
    assert.deepEqual(laneIds(s), [s.folder('other')]);

    workers.length = 0;
    assert.equal(await runHookCommand(['session-end'], deps(s, mine, out, { stdin, startWorker })), 0);
    assert.equal(workers.length, 0, 'a session with no lanes starts no worker');
  } finally {
    other.kill('SIGKILL');
    me.kill('SIGKILL');
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('session-end --codex releases the ended thread’s lanes by the hook’s session_id', async () => {
  const s = setup('hook-codex');
  try {
    await lane(s, { CODEX_THREAD_ID: 'thread-1' }, s.folder('t1'), '--no-device');
    await lane(s, { CODEX_THREAD_ID: 'thread-2' }, s.folder('t2'), '--no-device');
    const workers: NodeJS.ProcessEnv[] = [];
    const out: string[] = [];
    const stdin = JSON.stringify({ session_id: 'thread-1', hook_event_name: 'SessionEnd', cwd: s.root });
    assert.equal(
      await runHookCommand(['session-end', '--codex'], deps(s, {}, out, { stdin, startWorker: env => workers.push(env) })),
      0,
      out.join(''),
    );
    const [worker] = workers;
    assert.ok(worker);
    assert.equal(await runHookCommand(['session-end'], deps(s, worker, out)), 0, out.join(''));
    assert.deepEqual(laneIds(s), [s.folder('t2')]);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('session-end from the real CLI detaches a worker that outlives the hook and releases the lanes', async () => {
  const s = setup('hook-detached');
  const me = sleeper();
  try {
    const env = { AGENTLANE_OWNER_PID: String(me.pid) };
    await lane(s, env, s.folder('x'), '--no-device');
    const started = Date.now();
    const result = spawnSync(process.execPath, [CLI, 'hook', 'session-end'], {
      input: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: s.stateDir, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /releasing 1 lane\(s\)/);
    const hookMs = Date.now() - started;
    const log = path.join(s.stateDir, 'session-end.log');
    const released = () => /released lane \w+ of process/.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (laneIds(s).length > 0 || !released())) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(laneIds(s), []);
    assert.match(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(no log)', /released lane \w+ of process/);
    assert.ok(
      hookMs < (SESSION_END_TIMEOUT_S * 1000) / 2,
      `the hook returned in ${String(hookMs)} ms, against the ${String(SESSION_END_TIMEOUT_S)} s timeout the plugin declares`,
    );
  } finally {
    me.kill('SIGKILL');
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('release has no --all: an agent can only release its own folder’s lane', async () => {
  const s = setup('hook-noall');
  try {
    const out: string[] = [];
    assert.equal(await runRegistryCommand('release', ['--all'], deps(s, { AGENTLANE_OWNER_PID: String(process.pid) }, out)), 2);
    assert.match(out.join(''), /Unknown option '--all'/);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('a Claude session’s name comes from its session record, only when the record is the same process', () => {
  const config = tempDir('claude-config');
  try {
    fs.mkdirSync(path.join(config, 'sessions'));
    const self = identityOf(systemProcesses, process.pid);
    assert.ok(self);
    const owner = { kind: 'claude' as const, process: self, sessionId: null, threadId: null };
    const env = { CLAUDE_CONFIG_DIR: config };
    const write = (record: object) => {
      fs.writeFileSync(path.join(config, 'sessions', `${String(process.pid)}.json`), JSON.stringify(record));
    };
    assert.equal(claudeSessionName(owner, env), null, 'no record');
    write({ pid: process.pid, procStart: self.start, name: 'map polish' });
    assert.equal(claudeSessionName(owner, env), 'map polish');
    write({ pid: process.pid, startedAt: Date.parse(`${self.start} UTC`) + 400, name: 'by start time' });
    assert.equal(claudeSessionName(owner, env), 'by start time');
    write({ pid: process.pid, startedAt: Date.parse(`${self.start} UTC`) - 3_600_000, name: 'an older process' });
    assert.equal(claudeSessionName(owner, env), null, 'a recycled pid');
    write({ pid: process.pid, procStart: self.start });
    assert.equal(claudeSessionName(owner, env), null, 'an unnamed session');
    assert.equal(claudeSessionName({ ...owner, kind: 'process' }, env), null, 'not a Claude owner');
  } finally {
    fs.rmSync(config, { recursive: true, force: true });
  }
});

test('setup runs the project’s setup hook in the worktree without claiming, and status shows no lane', () => {
  const root = tempDir('setup');
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    fs.writeFileSync(
      path.join(repo, 'agentlane.json'),
      JSON.stringify({
        app: { platform: 'ios', bundleId: 'com.example.app', launch: 'dev-client' },
        services: { metro: { type: 'metro', start: 'true', ready: { kind: 'tcp' } } },
        hooks: { setup: 'env | grep ^AGENTLANE_ > setup.env; echo installed > setup.out; echo to-stdout' },
      }),
    );
    const stateDir = path.join(root, 'state');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: stateDir, AGENTLANE_LANE: 'stale' };
    const result = spawnSync(process.execPath, [CLI, 'setup'], { cwd: repo, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /to-stdout/);
    assert.equal(fs.readFileSync(path.join(repo, 'setup.out'), 'utf8'), 'installed\n');
    const vars = fs.readFileSync(path.join(repo, 'setup.env'), 'utf8').trim().split('\n').sort();
    assert.deepEqual(vars, [`AGENTLANE_STATE_DIR=${stateDir}`, `AGENTLANE_WORKTREE=${fs.realpathSync(repo)}`]);
    assert.equal(fs.existsSync(path.join(stateDir, 'registry.sqlite')), false, 'no registry was created');

    fs.writeFileSync(
      path.join(repo, 'agentlane.json'),
      JSON.stringify({
        app: { platform: 'ios', bundleId: 'com.example.app', launch: 'dev-client' },
        services: { metro: { type: 'metro', start: 'true', ready: { kind: 'tcp' } } },
        hooks: { setup: 'exit 7' },
      }),
    );
    const failed = spawnSync(process.execPath, [CLI, 'setup'], { cwd: repo, encoding: 'utf8', env });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /the setup hook exited 7/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
