import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { agentHookChecks, MARK_MAX_AGE_MS } from '../../src/agents/hook-check.ts';
import { GUARDED_WORDS, hookCommand, UNSPLIT_SED } from '../../src/agents/launcher.ts';
import { toolVersion } from '../../src/agents/package.ts';
import { aimsOf } from '../../src/plugin/aims.ts';
import { writeHookMark } from '../../src/plugin/hook-mark.ts';
import { systemProcesses } from '../../src/processes.ts';
import type { Agent } from '../../src/registry/owner.ts';
import { AGENTS } from '../../src/registry/owner.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { tempDir } from '../support/fakes.ts';
import { hermeticEnv } from '../support/hermetic.ts';
import { recordingInstaller } from '../support/installer.ts';
import { writeToolkit } from '../support/toolkit.ts';

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
function installToolkit(dir: string, log: string, run = `exec "${process.execPath}" "${CLI}" "$@"`): string {
  return writeToolkit(dir, `printf '%s\\n' "$*" >> "${log}"\n${run}`);
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

const SPLIT_NAMES = [
  "xcrun 'sim'ctl boot booted",
  'xcrun sim\\ctl boot booted',
  "a''db shell",
  'a\\db shell',
  "emu''lator -avd x",
  "agent-''browser --session x open",
  'playwright\\-cli kill-all',
  "npx @play''wright/cli kill-all",
  `sh -c 'xcrun sim""ctl boot booted'`,
  "a$''db shell",
  "xcrun sim$'c'tl boot booted",
  'xcrun sim\\\nctl boot booted',
  `bash -c "a\\\ndb shell"`,
];

const PLAIN = [
  'git status && pnpm test',
  `printf 'a\\nb\\n' | grep -c "$HOME"`,
  'cd src\ngit diff -- "it\'s.ts"',
  "echo $'tab\\there' \\\n  && ls",
];

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
    for (const shell of SPLIT_NAMES) assert.notDeepEqual(aimsOf(shell, {}, dir), [], `the guard judges ${shell}`);
    const input = (shell: string) => JSON.stringify({ cwd: dir, tool_input: { command: shell } });
    const routes = [
      ...AGENTS.map(agent => ({
        agent,
        command: hookCommandsOf(dir, agent, 'pre-tool-use')[0] ?? '',
        args: ` --agent ${agent}`,
      })),
      { agent: 'plugin', command: `"${HOOK_SH}" pre-tool-use`, args: '' },
    ];
    for (const { agent, command, args } of routes) {
      assert.ok(command, agent);
      for (const plain of PLAIN) {
        const quiet = sh(command, dir, env, input(plain));
        assert.equal(quiet.status, 0, `${agent}: ${quiet.stderr}`);
        assert.equal(quiet.stdout, agent === 'cursor' ? '{"permission":"allow"}\n' : '', agent);
        assert.deepEqual(calls(log), [], `${agent} started the toolkit or node for ${plain}`);
      }
      for (const shell of ['xcrun simctl boot booted', ...SPLIT_NAMES]) {
        const device = sh(command, dir, env, input(shell));
        assert.equal(device.status, 0, `${agent}: ${device.stderr}`);
        assert.deepEqual(
          calls(log),
          [`toolkit hook pre-tool-use${args}`, `node hook pre-tool-use${args}`],
          `${agent}: ${shell} reaches the guard`,
        );
        fs.rmSync(log);
      }
    }
  } finally {
    f.cleanup();
  }
});

const GUARDED_COMMANDS: Record<(typeof GUARDED_WORDS)[number], (name: string) => string> = {
  simctl: name => `xcrun ${name} boot booted`,
  adb: name => `${name} shell`,
  emulator: name => `${name} -avd x`,
  avdmanager: name => `${name} delete avd -n x`,
  'playwright-cli': name => `${name} kill-all`,
  '@playwright/cli': name => `npx ${name} kill-all`,
  'agent-browser': name => `${name} --session x open`,
};

function splitsOf(word: string): string[] {
  const cuts = ["''", '""', "$''", '\\', '\\\n'];
  const at = Array.from({ length: word.length }, (_, i) => i);
  const between = at.slice(1).flatMap(i => cuts.map(cut => word.slice(0, i) + cut + word.slice(i)));
  const around = at.map(i => `${word.slice(0, i)}$'${word.slice(i, i + 1)}'${word.slice(i + 1)}`);
  return [...between, ...around];
}

/** The `case` statement that decides whether a guard hook starts the toolkit, and the variable it reads the input from. */
function filterOf(route: Agent | 'plugin'): { variable: string; filter: string } {
  if (route === 'plugin') {
    const script = /^ {2}case .*?\n {2}esac$/ms.exec(fs.readFileSync(HOOK_SH, 'utf8'));
    assert.ok(script, 'hook.sh has its filter');
    return { variable: 'input', filter: script[0] };
  }
  const settings = /^i=\$\(cat\); (case .*? esac);/s.exec(hookCommand(route, 'pre-tool-use'));
  assert.ok(settings?.[1], `${route}'s hook has its filter`);
  return { variable: 'i', filter: settings[1] };
}

test('every way of splitting a guarded tool name with quotes, backslashes or line continuations passes all seven guard filters', () => {
  const f = fixture('hooks-split-names');
  try {
    const bare = GUARDED_WORDS.flatMap(word => splitsOf(word).map(split => GUARDED_COMMANDS[word](split)));
    for (const command of bare) assert.notDeepEqual(aimsOf(command, {}, f.root), [], `the guard judges ${command}`);
    const cases = bare.flatMap(command => [command, `sh -c '${command}'`, `bash -c "${command}"`]);
    const inputs = path.join(f.root, 'inputs');
    fs.writeFileSync(
      inputs,
      cases.map(command => `${JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: f.root })}\n`).join(''),
    );
    const routes = [...AGENTS, 'plugin' as const].map(filterOf);
    const distinct = new Map(routes.map(route => [`${route.variable}\0${route.filter}`, route]));
    for (const { variable, filter } of distinct.values()) {
      const driver = `n=0; while IFS= read -r line; do n=$((n + 1)); ${variable}=$line; (\n${filter}\necho "$n"\n); done < "${inputs}"`;
      const result = spawnSync('/bin/sh', ['-c', driver], { encoding: 'utf8', env: f.env() });
      assert.equal(result.status, 0, result.stderr);
      const passed = new Set(result.stdout.split('\n').filter(line => /^\d+$/.test(line)));
      const skipped = cases.filter((_, at) => !passed.has(String(at + 1)));
      assert.deepEqual(skipped, [], `the filter skips these:\n${filter}`);
    }
  } finally {
    f.cleanup();
  }
});

test('the plugin’s hook script checks the same words as the hooks init writes', () => {
  const text = fs.readFileSync(HOOK_SH, 'utf8');
  assert.ok(text.includes(`case $(printf '%s' "$input" | ${UNSPLIT_SED}) in`), 'hook.sh rejoins split names the same way');
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
    for (const [route, command] of [
      ['settings', hookCommand('claude', 'session-end')],
      ['plugin', `"${HOOK_SH}" session-end`],
    ] as const) {
      const lane = await claim(f, owner.pid ?? 0, worktree);
      const end = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: route, reason: 'other', cwd: main });
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

function shAsync(command: string, cwd: string, env: NodeJS.ProcessEnv, input: string): Promise<Reply> {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', status => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

interface Reply {
  status: number | null;
  stdout: string;
  stderr: string;
}

test('with the plugin enabled and the hooks in the settings, both copies of the guard give one answer, and two session-end hooks racing release the lane once', async () => {
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

    const guarded = JSON.stringify({
      session_id: 's',
      tool_name: 'Bash',
      tool_input: { command: 'xcrun simctl list' },
      cwd: dir,
    });
    const answers = [settings('pre-tool-use'), plugin('pre-tool-use')].map(command => sh(command, dir, env, guarded));
    assert.deepEqual(
      answers.map(r => [r.status, r.stdout, r.stderr]),
      [
        [0, '', ''],
        [0, '', ''],
      ],
    );
    assert.deepEqual(calls(log), ['hook pre-tool-use --agent claude', 'hook pre-tool-use']);

    await claim(f, owner.pid ?? 0, dir);
    const end = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's', reason: 'other', cwd: dir });
    const replies = await Promise.all([settings('session-end'), plugin('session-end')].map(c => shAsync(c, dir, env, end)));
    assert.ok(
      replies.every(r => r.status === 0),
      replies.map(r => r.stderr).join(''),
    );
    assert.equal(replies.filter(r => r.stderr.includes('releasing 1 lane')).length, 1);
    assert.equal(replies.filter(r => r.stderr.includes('another copy of this hook is already releasing')).length, 1);
    await until(() => held(f).length === 0);
    assert.deepEqual(held(f), []);
    await until(() => (fs.readFileSync(path.join(f.state, 'session-end.log'), 'utf8').match(/released lane /g) ?? []).length > 0);
    const released = fs.readFileSync(path.join(f.state, 'session-end.log'), 'utf8').match(/releasing every lane of /g) ?? [];
    assert.equal(released.length, 1);
  } finally {
    owner.kill('SIGKILL');
    f.cleanup();
  }
});

test('with the plugin enabled and a settings file Claude Code cannot load, the plugin’s hooks still judge a guarded command and release the lane', async () => {
  const f = fixture('hooks-unloaded-settings');
  const owner = sleeper();
  try {
    const dir = f.repo('app');
    write(path.join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'agentlane@agentlane': true } }));
    await init(dir, f.env(), '--agents', 'claude');
    const settings = path.join(dir, '.claude/settings.json');
    const good = fs.readFileSync(settings, 'utf8');
    fs.writeFileSync(settings, `<<<<<<< HEAD\n${good}=======\n{}\n>>>>>>> other\n`);
    const log = path.join(f.root, 'calls.log');
    installToolkit(dir, log);
    const env = f.env({
      AGENTLANE_OWNER_PID: String(owner.pid),
      CLAUDE_PROJECT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: path.dirname(HOOK_SH),
    });

    const guarded = JSON.stringify({
      session_id: 's',
      tool_name: 'Bash',
      tool_input: { command: 'xcrun simctl boot booted' },
      cwd: dir,
    });
    assert.equal(sh(`"${HOOK_SH}" pre-tool-use`, dir, env, guarded).status, 0);
    assert.deepEqual(calls(log), ['hook pre-tool-use'], 'the guard judged the command');

    const lane = await claim(f, owner.pid ?? 0, dir);
    const end = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's', reason: 'other', cwd: dir });
    const reply = sh(`"${HOOK_SH}" session-end`, dir, env, end);
    assert.equal(reply.status, 0, reply.stderr);
    assert.match(reply.stderr, new RegExp(`releasing 1 lane\\(s\\) .*: ${lane}`));
    await until(() => held(f).length === 0);
    assert.deepEqual(held(f), []);
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

for (const route of ['settings', 'plugin'] as const) {
  test(`doctor stops trusting a hook's mark once the toolkit changes, its version differs or the mark is a day old, on the ${route} route`, async () => {
    const f = fixture(`hooks-stale-mark-${route}`);
    try {
      const dir = f.repo('app');
      const agent: Agent = route === 'settings' ? 'codex' : 'claude';
      if (route === 'settings') await init(dir, f.env(), '--agents', 'codex');
      else {
        write(path.join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'agentlane@agentlane': true } }));
        write(
          path.join(f.root, 'home/.claude/plugins/installed_plugins.json'),
          JSON.stringify({
            version: 2,
            plugins: { 'agentlane@agentlane': [{ scope: 'user', installPath: path.dirname(path.dirname(HOOK_SH)) }] },
          }),
        );
      }
      const log = path.join(f.root, 'calls.log');
      installToolkit(dir, log);
      const check = (now?: number) => agentHookChecks(dir, [agent], f.env(), now)[0];
      const where = route === 'settings' ? '\\.codex\\/hooks\\.json' : 'the plugin in .*\\/plugin';
      assert.match(
        check()?.detail ?? '',
        new RegExp(`^doctor ran the guard hook in ${where} on a command it allows, and it reached `),
      );
      assert.match(check()?.detail ?? '', /^the pre-tool-use hook in .* reached /, 'a fresh mark spares the run');
      const runs = () => calls(log).length;

      const probes = runs();
      assert.equal(check(Date.now() + MARK_MAX_AGE_MS + 60_000)?.ok, true);
      assert.equal(runs(), probes + 1, 'a mark over a day old is checked again');

      const manifest = path.join(dir, 'node_modules/agentlane/package.json');
      const { mtime } = fs.statSync(manifest);
      fs.writeFileSync(manifest, JSON.stringify({ name: 'agentlane', version: '0.0.1' }));
      fs.utimesSync(manifest, mtime, mtime);
      assert.equal(check()?.ok, true);
      assert.equal(runs(), probes + 2, 'a mark from another version is checked again');

      installToolkit(dir, log, `echo "node: bad option" >&2; exit 9`);
      const broken = check();
      assert.equal(broken?.ok, false, broken?.detail);
      assert.match(broken.detail, new RegExp(`never reached the toolkit: it exited ${route === 'settings' ? '9' : '1'}`));
      assert.equal(broken.fix, `node_modules/.bin/agentlane init --agents ${agent}, then node_modules/.bin/agentlane doctor`);
    } finally {
      f.cleanup();
    }
  });
}

test('doctor says the hook exited 0 without reaching the toolkit when an old hook command finds none', () => {
  const f = fixture('hooks-old-command');
  try {
    const main = f.repo('main');
    write(path.join(main, 'README.md'), 'main\n');
    git(main, f.env(), 'add', '-A');
    git(main, f.env(), 'commit', '-q', '-m', 'main');
    const worktree = path.join(f.root, 'feature');
    git(main, f.env(), 'worktree', 'add', '-q', worktree);
    const bin = installToolkit(worktree, path.join(f.root, 'calls.log'));
    const old = `d="\${CLAUDE_PROJECT_DIR:-$PWD}"; while [ ! -x "$d/node_modules/.bin/agentlane" ] && [ "$d" != / ]; do d=$(dirname "$d"); done; if [ -x "$d/node_modules/.bin/agentlane" ]; then exec "$d/node_modules/.bin/agentlane" hook pre-tool-use --agent claude; fi; exit 0`;
    write(
      path.join(main, '.claude/settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: old }] }] } }),
    );
    const [line] = agentHookChecks(main, ['claude'], f.env());
    assert.equal(line?.ok, false);
    assert.equal(
      line.detail,
      `doctor ran the guard hook in .claude/settings.json on a command it allows, and it exited 0 without reaching the toolkit at ${bin}: its command found no toolkit to run, or predates the one init writes`,
    );
    assert.equal(line.fix, 'node_modules/.bin/agentlane init --agents claude, then node_modules/.bin/agentlane doctor');
  } finally {
    f.cleanup();
  }
});

test('a mark left from a worktree nested in the project does not vouch for the project’s own hook', async () => {
  const f = fixture('hooks-nested-mark');
  try {
    const dir = f.repo('app');
    await init(dir, f.env(), '--agents', 'codex');
    const bin = installToolkit(dir, path.join(f.root, 'calls.log'), 'exit 9');
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const file of [bin, path.join(dir, 'node_modules/agentlane/package.json'), path.join(dir, '.codex/hooks.json')])
      fs.utimesSync(file, hourAgo, hourAgo);
    const nested = path.join(dir, '.claude/worktrees/x');
    fs.mkdirSync(nested, { recursive: true });
    writeHookMark(f.state, {
      agent: 'codex',
      event: 'pre-tool-use',
      project: nested,
      at: Date.now(),
      toolkit: bin,
      version: toolVersion(),
      probe: null,
    });
    const [line] = agentHookChecks(dir, ['codex'], f.env());
    assert.equal(line?.ok, false, line?.detail);
    assert.match(line.detail, /never reached the toolkit: it exited 9/);
  } finally {
    f.cleanup();
  }
});
