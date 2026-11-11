import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { agentHookChecks } from '../../src/agents/hook-check.ts';
import { GUARDED_WORDS, hookCommand } from '../../src/agents/launcher.ts';
import { systemProcesses } from '../../src/processes.ts';
import type { Agent } from '../../src/registry/owner.ts';
import { AGENTS } from '../../src/registry/owner.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { tempDir } from '../support/fakes.ts';
import { hermeticEnv } from '../support/hermetic.ts';
import { recordingInstaller } from '../support/installer.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const HOOK_SH = path.join(ROOT, 'plugin', 'scripts', 'hook.sh');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

interface Fixture {
  root: string;
  state: string;
  env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  repo: (name: string) => string;
  cleanup: () => void;
}

function fixture(label: string): Fixture {
  const root = fs.realpathSync(tempDir(label));
  const env = (extra: NodeJS.ProcessEnv = {}) => hermeticEnv(root, { ...GIT_ENV, ...extra });
  return {
    root,
    state: path.join(root, 'state'),
    env,
    repo: name => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, env(), 'init', '-q');
      return dir;
    },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function git(dir: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A toolkit at `dir` that writes each call's arguments to `log`, then runs the real CLI. */
function installToolkit(dir: string, log: string): string {
  const bin = path.join(dir, 'node_modules/.bin/agentlane');
  write(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function calls(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

async function init(dir: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  let out = '';
  const code = await runAgentCommand('init', args, {
    env,
    cwd: dir,
    install: recordingInstaller().install,
    stdout: text => (out += text),
    stderr: text => (out += text),
    now: () => Date.UTC(2026, 10, 10, 9, 0, 0),
  });
  assert.equal(code, 0, out);
  return out;
}

function json(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function commandsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(commandsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(commandsIn);
  return [];
}

const HOOK_FILES: Record<Agent, string> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  cursor: '.cursor/hooks.json',
  copilot: '.github/hooks/agentlane.json',
  gemini: '.gemini/settings.json',
  antigravity: '.agents/hooks.json',
};

function hookCommandsOf(dir: string, agent: Agent, event: 'pre-tool-use' | 'session-end'): string[] {
  return commandsIn(json(path.join(dir, HOOK_FILES[agent]))).filter(c => c.includes(` hook ${event} --agent ${agent}`));
}

function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
}

async function claim(f: Fixture, owner: number, worktree: string): Promise<string> {
  const out: string[] = [];
  const code = await runRegistryCommand('claim', ['--worktree', worktree, '--json', '--no-device', '--services', 'none'], {
    env: f.env({ AGENTLANE_OWNER_PID: String(owner) }),
    cwd: worktree,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: {},
  });
  assert.equal(code, 0, out.join(''));
  return (JSON.parse(out.join('')) as { lane: { id: string } }).lane.id;
}

function held(f: Fixture): string[] {
  return readRegistryStatus({ dir: f.state, processes: systemProcesses, devices: {} }).lanes.map(l => l.id);
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
}

function sh(command: string, cwd: string, env: NodeJS.ProcessEnv, input: string) {
  return spawnSync('/bin/sh', ['-c', command], { cwd, env, input, encoding: 'utf8' });
}

for (const plugin of [false, true]) {
  test(`init writes every agent's guard hook, and the session-end hook where the agent has one, ${plugin ? 'with' : 'without'} the Claude plugin enabled`, async () => {
    const f = fixture('hooks-every-agent');
    try {
      const dir = f.repo('app');
      if (plugin)
        write(path.join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'agentlane@agentlane': true } }));
      await init(dir, f.env(), '--all');
      for (const agent of AGENTS) {
        assert.equal(hookCommandsOf(dir, agent, 'pre-tool-use').length, 1, `${agent} guard`);
        assert.equal(hookCommandsOf(dir, agent, 'session-end').length, agent === 'antigravity' ? 0 : 1, `${agent} release`);
      }
      const claude = json(path.join(dir, '.claude/settings.json')) as { hooks: Record<string, unknown> };
      assert.deepEqual(Object.keys(claude.hooks).sort(), ['PreToolUse', 'SessionEnd']);
    } finally {
      f.cleanup();
    }
  });
}

test('the guard hooks init writes start no node process for a command with no device or browser tool in it', async () => {
  const f = fixture('hooks-no-node');
  try {
    const dir = f.repo('app');
    await init(dir, f.env(), '--all');
    const log = path.join(f.root, 'calls.log');
    const bin = path.join(f.root, 'bin');
    write(path.join(bin, 'node'), `#!/bin/sh\nprintf 'node %s\\n' "$*" >> "${log}"\nexit 0\n`);
    fs.chmodSync(path.join(bin, 'node'), 0o755);
    const toolkit = path.join(dir, 'node_modules/.bin/agentlane');
    write(toolkit, `#!/bin/sh\nprintf 'toolkit %s\\n' "$*" >> "${log}"\nexec node "$@"\n`);
    fs.chmodSync(toolkit, 0o755);
    const env = f.env({
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CLAUDE_PROJECT_DIR: dir,
      CURSOR_PROJECT_DIR: dir,
    });
    for (const agent of AGENTS) {
      const [command] = hookCommandsOf(dir, agent, 'pre-tool-use');
      assert.ok(command, agent);
      const input = (shell: string) => JSON.stringify({ cwd: dir, tool_input: { command: shell } });
      const quiet = sh(command, dir, env, input('git status && pnpm test'));
      assert.equal(quiet.status, 0, `${agent}: ${quiet.stderr}`);
      assert.equal(quiet.stdout, agent === 'cursor' ? '{"permission":"allow"}\n' : '', agent);
      assert.deepEqual(calls(log), [], `${agent} started the toolkit or node for a plain command`);
      const device = sh(command, dir, env, input('xcrun simctl boot booted'));
      assert.equal(device.status, 0, `${agent}: ${device.stderr}`);
      assert.deepEqual(
        calls(log),
        [`toolkit hook pre-tool-use --agent ${agent}`, `node hook pre-tool-use --agent ${agent}`],
        `${agent}: a device command reaches the guard`,
      );
      fs.rmSync(log);
    }
  } finally {
    f.cleanup();
  }
});

test('the plugin’s hook script checks the same words as the hooks init writes', () => {
  const text = fs.readFileSync(HOOK_SH, 'utf8');
  const pattern = /^\s*(\*simctl\*.*)\) ;;$/m.exec(text)?.[1] ?? '';
  assert.deepEqual(
    pattern.split('|').map(word => word.trim()),
    GUARDED_WORDS.map(word => `*${word}*`),
  );
});

test('a session-end hook run from a main checkout with no toolkit releases the lane held in its worktree that has one', async () => {
  const f = fixture('hooks-worktree');
  const owner = sleeper();
  try {
    const main = f.repo('main');
    write(path.join(main, 'README.md'), 'main\n');
    git(main, f.env(), 'add', '-A');
    git(main, f.env(), 'commit', '-q', '-m', 'main');
    const worktree = path.join(f.root, 'main-worktrees', 'feature');
    git(main, f.env(), 'worktree', 'add', '-q', worktree);
    const log = path.join(f.root, 'calls.log');
    installToolkit(worktree, log);
    const env = f.env({ AGENTLANE_OWNER_PID: String(owner.pid), CLAUDE_PROJECT_DIR: main });
    const end = JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other', cwd: main });

    for (const [route, command] of [
      ['settings', hookCommand('claude', 'session-end')],
      ['plugin', `"${HOOK_SH}" session-end`],
    ] as const) {
      const lane = await claim(f, owner.pid ?? 0, worktree);
      const result = sh(command, main, env, end);
      assert.equal(result.status, 0, `${route}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`releasing 1 lane\\(s\\) .*: ${lane}`), route);
      await until(() => held(f).length === 0);
      assert.deepEqual(held(f), [], `${route}: the worktree's lane is released`);
    }
    assert.deepEqual(calls(log), ['hook session-end --agent claude', 'hook session-end']);
  } finally {
    owner.kill('SIGKILL');
    f.cleanup();
  }
});

test('with the plugin enabled and the hooks in the settings, one session end releases once and one guarded command is judged once', async () => {
  const f = fixture('hooks-once');
  const owner = sleeper();
  try {
    const dir = f.repo('app');
    write(path.join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'agentlane@agentlane': true } }));
    await init(dir, f.env(), '--agents', 'claude');
    const log = path.join(f.root, 'calls.log');
    installToolkit(dir, log);
    const env = f.env({
      AGENTLANE_OWNER_PID: String(owner.pid),
      CLAUDE_PROJECT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: path.dirname(HOOK_SH),
    });
    const settings = (event: 'pre-tool-use' | 'session-end') => hookCommandsOf(dir, 'claude', event)[0] ?? '';
    const plugin = (event: string) => `"${HOOK_SH}" ${event}`;

    const guarded = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'xcrun simctl list' }, cwd: dir });
    for (const command of [settings('pre-tool-use'), plugin('pre-tool-use')])
      assert.equal(sh(command, dir, env, guarded).status, 0);
    assert.deepEqual(calls(log), ['hook pre-tool-use --agent claude']);

    await claim(f, owner.pid ?? 0, dir);
    const end = JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other', cwd: dir });
    const replies = [settings('session-end'), plugin('session-end')].map(command => sh(command, dir, env, end));
    assert.ok(replies.every(r => r.status === 0));
    assert.equal(replies.filter(r => r.stderr.includes('releasing 1 lane')).length, 1);
    await until(() => held(f).length === 0);
    assert.deepEqual(held(f), []);
    assert.deepEqual(calls(log), ['hook pre-tool-use --agent claude', 'hook session-end --agent claude']);
    const released = fs.readFileSync(path.join(f.state, 'session-end.log'), 'utf8').match(/released lane /g) ?? [];
    assert.equal(released.length, 1);
  } finally {
    owner.kill('SIGKILL');
    f.cleanup();
  }
});

test('doctor fails a hook that points at a missing toolkit, naming the fix, and passes once the toolkit is back', async () => {
  const f = fixture('hooks-doctor');
  try {
    const dir = f.repo('app');
    await init(dir, f.env(), '--agents', 'codex,claude');
    const missing = agentHookChecks(dir, ['claude', 'codex'], f.env());
    for (const line of missing) {
      assert.equal(line.ok, false, line.name);
      assert.match(
        line.detail,
        /^the hooks in \S+ find no node_modules\/\.bin\/agentlane in .*\/app, the folders above it or this repository's other worktrees, so they never run agentlane$/,
      );
      assert.match(
        line.fix,
        /^install the project's dependencies, so node_modules\/\.bin\/agentlane exists \(package\.json lists agentlane/,
      );
    }

    const bin = path.join(dir, 'node_modules/.bin/agentlane');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.symlinkSync('../agentlane/dist/cli.js', bin);
    assert.ok(
      agentHookChecks(dir, ['codex'], f.env()).every(line => !line.ok),
      'a link to a removed package',
    );
    fs.rmSync(bin);

    installToolkit(dir, path.join(f.root, 'calls.log'));
    const probed = agentHookChecks(dir, ['claude', 'codex'], f.env());
    for (const line of probed) {
      assert.equal(line.ok, true, `${line.name}: ${line.detail}`);
      assert.match(line.detail, /^doctor ran the guard hook in \S+ on a command it allows, and it reached .*src\/cli\.ts/);
    }
    assert.deepEqual(calls(path.join(f.root, 'calls.log')), [
      'hook pre-tool-use --agent claude',
      'hook pre-tool-use --agent codex',
    ]);
    const marked = agentHookChecks(dir, ['codex'], f.env());
    assert.match(marked[0]?.detail ?? '', /^the pre-tool-use hook in \.codex\/hooks\.json reached /);
    assert.equal(calls(path.join(f.root, 'calls.log')).length, 2, 'a mark spares doctor the run');

    const file = path.join(dir, '.codex/hooks.json');
    const elsewhere = path.join(f.root, 'gone', 'node_modules/.bin/agentlane');
    const hooks = JSON.stringify(json(file)).replaceAll(
      JSON.stringify('"$d/node_modules/.bin/agentlane" hook pre-tool-use').slice(1, -1),
      JSON.stringify(`"${elsewhere}" hook pre-tool-use`).slice(1, -1),
    );
    fs.writeFileSync(file, hooks);
    const broken = agentHookChecks(dir, ['codex'], f.env())[0];
    assert.equal(broken?.ok, false, 'a hook changed since its mark is run again');
    assert.match(
      broken.detail,
      /^doctor ran the guard hook in \.codex\/hooks\.json on a command it allows, and it never reached the toolkit: it exited 127: .*gone/,
    );
    assert.equal(broken.fix, 'node_modules/.bin/agentlane init --agents codex, then node_modules/.bin/agentlane doctor');
    await init(dir, f.env(), '--agents', 'codex');
    assert.equal(agentHookChecks(dir, ['codex'], f.env())[0]?.ok, true, 'init puts the hook back');
  } finally {
    f.cleanup();
  }
});
