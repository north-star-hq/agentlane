import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { HookDeps } from '../../src/plugin/hook-cli.ts';
import { runHookCommand, SESSION_END_OWNER_ENV, SESSION_END_WAIT_ENV } from '../../src/plugin/hook-cli.ts';
import { readHookInput } from '../../src/plugin/conventions.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import type { Agent } from '../../src/registry/owner.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { FakeClock, FakeDevices, tempDir } from '../support/fakes.ts';
import { portBlock } from '../support/ports.ts';

const PORTS = await portBlock();

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
  const root = fs.realpathSync(tempDir(label));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ poolSize: 3, ports: { metro: [PORTS, PORTS + 3], api: [PORTS + 10, PORTS + 13] } }),
  );
  return {
    root,
    stateDir,
    devices: new FakeDevices(path.join(root, 'devices')),
    folder: name => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

function deps(s: Setup, env: NodeJS.ProcessEnv, out: string[], extra: Partial<HookDeps> = {}): HookDeps {
  return {
    env: { AGENTLANE_STATE_DIR: s.stateDir, ...env },
    cwd: s.root,
    stdout: text => out.push(`stdout:${text}`),
    stderr: text => out.push(`stderr:${text}`),
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

async function claimDevice(s: Setup, ownerPid: number, folder: string, device = true): Promise<string> {
  const out: string[] = [];
  const args = ['--worktree', folder, '--json', '--services', 'metro', ...(device ? [] : ['--no-device'])];
  const code = await runRegistryCommand('claim', args, deps(s, { AGENTLANE_OWNER_PID: String(ownerPid) }, out));
  assert.equal(code, 0, out.join(''));
  const json = out.join('').replace(/^stdout:/, '');
  return (JSON.parse(json) as { lane: { device: { id: string } | null } }).lane.device?.id ?? '';
}

function stdoutOf(out: string[]): string {
  return out
    .filter(line => line.startsWith('stdout:'))
    .map(line => line.slice('stdout:'.length))
    .join('');
}

function stderrOf(out: string[]): string {
  return out
    .filter(line => line.startsWith('stderr:'))
    .map(line => line.slice('stderr:'.length))
    .join('');
}

const DOCUMENTED_INPUT: Record<Agent | 'copilot-claude-format', (command: string, cwd: string) => object> = {
  claude: (command, cwd) => ({
    session_id: 's-1',
    transcript_path: '/tmp/t.jsonl',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  }),
  codex: (command, cwd) => ({
    session_id: 'thr_123',
    transcript_path: '/tmp/rollout.jsonl',
    cwd,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    tool_use_id: 'call-1',
    tool_input: { command },
    permission_mode: 'default',
  }),
  gemini: (command, cwd) => ({
    session_id: 'g-1',
    transcript_path: '/tmp/g.json',
    cwd,
    hook_event_name: 'BeforeTool',
    timestamp: '2026-10-12T09:00:00.000Z',
    tool_name: 'run_shell_command',
    tool_input: { command, description: 'install the app' },
  }),
  copilot: (command, cwd) => ({
    sessionId: 'cp-1',
    timestamp: 1_791_795_600_000,
    cwd,
    toolName: 'bash',
    toolArgs: JSON.stringify({ command, description: 'install the app' }),
  }),
  'copilot-claude-format': (command, cwd) => ({
    hook_event_name: 'PreToolUse',
    session_id: 'cp-1',
    timestamp: '2026-10-12T09:00:00.000Z',
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  }),
  cursor: (command, cwd) => ({
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    model: 'some-model',
    hook_event_name: 'beforeShellExecution',
    cursor_version: '2.4.0',
    workspace_roots: [cwd],
    user_email: null,
    transcript_path: null,
    command,
    cwd,
    sandbox: false,
  }),
  antigravity: (command, cwd) => ({
    toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd, WaitMsBeforeAsync: 5000 } },
    stepIdx: 19,
    conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
    workspacePaths: [cwd],
    transcriptPath: '/tmp/a.json',
    artifactDirectoryPath: '/tmp/a',
    modelName: 'gemini-3.6-flash-medium',
  }),
};

function blockReason(agent: Agent, code: number, out: string[]): string {
  const stdout = stdoutOf(out);
  switch (agent) {
    case 'claude': {
      assert.equal(code, 0);
      const reply = JSON.parse(stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
      return reply.hookSpecificOutput.permissionDecisionReason;
    }
    case 'codex':
    case 'gemini':
      assert.equal(code, 2, 'exit 2 blocks');
      assert.equal(stdout, '');
      return stderrOf(out);
    case 'copilot': {
      assert.equal(code, 0);
      const reply = JSON.parse(stdout) as { permissionDecision: string; permissionDecisionReason: string };
      assert.equal(reply.permissionDecision, 'deny');
      return reply.permissionDecisionReason;
    }
    case 'cursor': {
      assert.equal(code, 0);
      const reply = JSON.parse(stdout) as { permission: string; user_message: string; agent_message: string };
      assert.equal(reply.permission, 'deny');
      assert.match(reply.user_message, /^agentlane: blocked: /);
      return reply.agent_message;
    }
    case 'antigravity': {
      assert.equal(code, 0);
      const reply = JSON.parse(stdout) as { decision: string; reason: string };
      assert.equal(reply.decision, 'deny');
      return reply.reason;
    }
  }
}

const ALLOW: Record<Agent, string> = {
  claude: '',
  codex: '',
  gemini: '',
  copilot: '',
  cursor: '{"permission":"allow"}\n',
  antigravity: '',
};

test('each agent’s documented hook input yields the command, the folder and the session', () => {
  const cwd = '/work/app';
  for (const [agent, make] of Object.entries(DOCUMENTED_INPUT)) {
    const input = readHookInput(JSON.stringify(make('xcrun simctl boot X', cwd)));
    assert.equal(input.command, 'xcrun simctl boot X', agent);
    assert.equal(input.cwd, cwd, agent);
    assert.ok(input.sessionId, agent);
  }
  const gemini = readHookInput(
    JSON.stringify({ cwd, tool_name: 'run_shell_command', tool_input: { command: 'adb devices', dir_path: 'apps/mobile' } }),
  );
  assert.equal(gemini.cwd, '/work/app/apps/mobile');
  assert.deepEqual(readHookInput(''), { command: null, cwd: null, sessionId: null, reason: null });
  assert.equal(readHookInput(JSON.stringify({ toolName: 'view', toolArgs: '{not json' })).command, null);
});

test('in every agent the guard blocks an xcrun simctl install on another lane’s simulator, the way that agent blocks', async () => {
  const s = setup('agent-guard');
  const other = sleeper();
  const me = sleeper();
  try {
    const theirs = await claimDevice(s, other.pid ?? 0, s.folder('other'));
    const mine = await claimDevice(s, me.pid ?? 0, s.folder('mine'));
    const env = { AGENTLANE_OWNER_PID: String(me.pid) };
    for (const [format, make] of Object.entries(DOCUMENTED_INPUT)) {
      const agent = (format === 'copilot-claude-format' ? 'claude' : format) as Agent;
      const blocked: string[] = [];
      const stdin = JSON.stringify(make(`xcrun simctl install ${theirs} App.app`, s.folder('mine')));
      const code = await runHookCommand(['pre-tool-use', '--agent', agent], deps(s, env, blocked, { stdin }));
      const reason = blockReason(agent, code, blocked);
      assert.match(reason, /^agentlane: blocked: `xcrun simctl install .*` aims at simulator /, format);
      assert.ok(reason.includes(`held by process ${String(other.pid)} in ${s.folder('other')}`), `${format}: ${reason}`);
      assert.ok(reason.includes(`aim at your own simulator: ${mine}`), `${format}: ${reason}`);

      for (const command of [`xcrun simctl install ${mine} App.app`, 'git status && pnpm test']) {
        const allowed: string[] = [];
        const input = JSON.stringify(make(command, s.folder('mine')));
        const allowCode = await runHookCommand(['pre-tool-use', '--agent', agent], deps(s, env, allowed, { stdin: input }));
        assert.equal(allowCode, 0, `${format}: ${command}`);
        assert.equal(stdoutOf(allowed), ALLOW[agent], `${format}: ${command}`);
        assert.equal(stderrOf(allowed), '', `${format}: ${command}`);
      }
    }
  } finally {
    other.kill('SIGKILL');
    me.kill('SIGKILL');
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('a command that aims at no device is allowed without reading the registry, and a broken guard never blocks by accident', async () => {
  const s = setup('agent-guard-broken');
  try {
    const notADir = path.join(s.root, 'state-is-a-file');
    fs.writeFileSync(notADir, '');
    const env = { AGENTLANE_STATE_DIR: notADir, AGENTLANE_OWNER_PID: String(process.pid) };
    const failExit: Record<Agent, number> = { claude: 1, codex: 1, gemini: 1, copilot: 0, cursor: 1, antigravity: 0 };
    for (const agent of Object.keys(failExit) as Agent[]) {
      const make = DOCUMENTED_INPUT[agent];
      const quiet: string[] = [];
      const stdin = JSON.stringify(make('pnpm test', s.root));
      assert.equal(await runHookCommand(['pre-tool-use', '--agent', agent], deps(s, env, quiet, { stdin })), 0, agent);
      assert.equal(stdoutOf(quiet), ALLOW[agent], agent);

      const broken: string[] = [];
      const device = JSON.stringify(make('xcrun simctl boot booted', s.root));
      const code = await runHookCommand(['pre-tool-use', '--agent', agent], deps(s, env, broken, { stdin: device }));
      assert.equal(code, failExit[agent], `${agent} fails open: ${broken.join('')}`);
      assert.match(stderrOf(broken), /the device guard failed, so this command runs unguarded/, agent);
      assert.equal(stdoutOf(broken), '', agent);
    }
    const unknown: string[] = [];
    assert.equal(await runHookCommand(['pre-tool-use', '--agent', 'kiro'], deps(s, env, unknown)), 2);
    assert.match(stderrOf(unknown), /'kiro' is not an agent; pass --agent claude\|codex\|cursor\|copilot\|gemini\|antigravity/);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

const SESSION_END_INPUT: Partial<Record<Agent, (reason: string) => object>> = {
  gemini: reason => ({ session_id: 'g-1', cwd: '/w', hook_event_name: 'SessionEnd', timestamp: 't', reason }),
  copilot: reason => ({ sessionId: 'cp-1', timestamp: 1_791_795_600_000, cwd: '/w', reason }),
  cursor: reason => ({
    conversation_id: 'conv-1',
    session_id: 'conv-1',
    hook_event_name: 'sessionEnd',
    reason,
    duration_ms: 1000,
    is_background_agent: false,
    final_status: 'completed',
  }),
};

test('session end in Gemini, Copilot and Cursor hands the worker the owner and a wait, and Gemini’s /clear keeps the lanes', async () => {
  const s = setup('agent-end');
  const me = sleeper();
  try {
    await claimDevice(s, me.pid ?? 0, s.folder('mine'), false);
    const env = { AGENTLANE_OWNER_PID: String(me.pid) };
    const cases: [Agent, string][] = [
      ['gemini', 'exit'],
      ['copilot', 'user_exit'],
      ['copilot', 'complete'],
      ['cursor', 'window_close'],
      ['cursor', 'completed'],
    ];
    for (const [agent, reason] of cases) {
      const workers: NodeJS.ProcessEnv[] = [];
      const out: string[] = [];
      const stdin = JSON.stringify(SESSION_END_INPUT[agent]?.(reason));
      const code = await runHookCommand(
        ['session-end', '--agent', agent],
        deps(s, env, out, { stdin, startWorker: worker => workers.push(worker) }),
      );
      assert.equal(code, 0, out.join(''));
      assert.equal(workers.length, 1, `${agent} ${reason}`);
      assert.equal(workers[0]?.[SESSION_END_WAIT_ENV], '30000', `${agent} ${reason}`);
      assert.match(stderrOf(out), /in the background once that process exits/);
    }
    const workers: NodeJS.ProcessEnv[] = [];
    const stdin = JSON.stringify(SESSION_END_INPUT.gemini?.('clear'));
    const cleared = await runHookCommand(
      ['session-end', '--agent', 'gemini'],
      deps(s, env, [], { stdin, startWorker: worker => workers.push(worker) }),
    );
    assert.equal(cleared, 0);
    assert.equal(workers.length, 0, 'Gemini keeps running after /clear, so its lanes stay');
  } finally {
    me.kill('SIGKILL');
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('the release worker keeps the lanes of an owner still running when the wait ends, and releases them once it exits', async () => {
  const s = setup('agent-end-wait');
  const me = sleeper();
  try {
    await claimDevice(s, me.pid ?? 0, s.folder('mine'), false);
    const identity = identityOf(systemProcesses, me.pid ?? 0);
    assert.ok(identity);
    const owner = JSON.stringify({ kind: 'process', process: identity, sessionId: null, threadId: null });
    const worker = { [SESSION_END_OWNER_ENV]: owner, [SESSION_END_WAIT_ENV]: '30000' };
    const held = () => readRegistryStatus({ dir: s.stateDir, processes: systemProcesses, devices: {} }).lanes.length;

    const clock = new FakeClock();
    const kept: string[] = [];
    const keeping = runHookCommand(['session-end'], deps(s, worker, kept, { clock, pollMs: 250 }));
    await clock.advance(30_000);
    assert.equal(await keeping, 0);
    assert.match(stderrOf(kept), /still running after 30 s .* so its lanes stay; they are freed once it exits/);
    assert.equal(held(), 1);

    const released: string[] = [];
    const releasing = runHookCommand(['session-end'], deps(s, worker, released, { clock, pollMs: 250 }));
    const exited = new Promise(resolve => me.once('exit', resolve));
    me.kill('SIGKILL');
    await exited;
    await clock.advance(250);
    assert.equal(await releasing, 0, released.join(''));
    assert.match(stderrOf(released), new RegExp(`releasing every lane of process ${String(me.pid)}`));
    assert.equal(held(), 0);
  } finally {
    me.kill('SIGKILL');
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
