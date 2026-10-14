import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import type { Terminal } from '../../src/agents/detect.ts';
import { AGENT_FILES, detectAgents } from '../../src/agents/detect.ts';
import { addCommand, packageManagerOf, shellLine, toolVersion } from '../../src/agents/package.ts';
import type { Agent } from '../../src/registry/owner.ts';
import { AGENTS } from '../../src/registry/owner.ts';
import { tempDir } from '../support/fakes.ts';
import type { RecordingInstaller } from '../support/installer.ts';
import { recordingInstaller } from '../support/installer.ts';

const VERSION = toolVersion();
const MARKERS: Record<Agent, string[]> = {
  claude: ['CLAUDE_PID'],
  codex: ['CODEX_THREAD_ID'],
  cursor: ['CURSOR_AGENT', 'CURSOR_CONVERSATION_ID'],
  copilot: ['COPILOT_CLI', 'COPILOT_AGENT_SESSION_ID', 'COPILOT_RUN_APP'],
  gemini: ['GEMINI_CLI'],
  antigravity: ['ANTIGRAVITY_AGENT', 'ANTIGRAVITY_TRAJECTORY_ID'],
};

interface Project {
  dir: string;
  env: NodeJS.ProcessEnv;
  write: (file: string, text: string) => void;
  has: (file: string) => boolean;
  cleanup: () => void;
}

function project(files: Record<string, string> = {}): Project {
  const root = fs.realpathSync(tempDir('init-front-door'));
  const dir = path.join(root, 'app');
  fs.mkdirSync(dir);
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  for (const [file, text] of Object.entries(files)) write(file, text);
  return {
    dir,
    env: { AGENTLANE_STATE_DIR: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') },
    write,
    has: file => fs.existsSync(path.join(dir, file)),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function init(
  p: Project,
  args: string[],
  options: { installer?: RecordingInstaller; env?: NodeJS.ProcessEnv; terminal?: Terminal } = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runAgentCommand('init', args, {
    env: { ...p.env, ...options.env },
    cwd: p.dir,
    install: (options.installer ?? recordingInstaller()).install,
    terminal: options.terminal ?? null,
    stdout: text => (stdout += text),
    stderr: text => (stderr += text),
  });
  return { code, stdout, stderr };
}

function manifest(p: Project): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8')) as Record<string, unknown>;
}

const PACKAGE = '{\n  "name": "app",\n  "private": true\n}\n';

test('each agent is found by each of its own project files, and by each variable it sets in the shell it runs', () => {
  for (const agent of AGENTS) {
    for (const file of AGENT_FILES[agent]) {
      const p = project();
      try {
        if (file.startsWith('.') && !file.includes('.', 1)) fs.mkdirSync(path.join(p.dir, file), { recursive: true });
        else p.write(file, '# notes\n');
        assert.deepEqual(
          detectAgents(p.dir, {}).map(d => d.agent),
          [agent],
          `${file} names ${agent}`,
        );
      } finally {
        p.cleanup();
      }
    }
    for (const variable of MARKERS[agent]) {
      const p = project();
      try {
        const [found] = detectAgents(p.dir, { [variable]: '1' });
        assert.equal(found?.agent, agent, variable);
        assert.match(found.signal, new RegExp(`^${variable} is set, so .+ runs this command$`));
      } finally {
        p.cleanup();
      }
    }
  }
});

test('AGENTS.md, .mcp.json and .agents/skills, which several agents read, name no agent', () => {
  const p = project({ 'AGENTS.md': '# agents\n', '.mcp.json': '{}\n', '.agents/skills/own/SKILL.md': '---\n---\n' });
  try {
    assert.deepEqual(detectAgents(p.dir, { TERM_PROGRAM: 'vscode' }), []);
  } finally {
    p.cleanup();
  }
});

test('a bare init with no terminal wires the agents it finds, says why, and adds the toolkit with the project’s package manager', async () => {
  const p = project({ 'package.json': PACKAGE, 'CLAUDE.md': '# app\n', 'package-lock.json': '{}\n' });
  const installer = recordingInstaller();
  try {
    const run = await init(p, [], { installer });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /agentlane init: found these agents \(pass --agents to pick others\):\n {2}claude {2}CLAUDE\.md\n/);
    assert.match(run.stdout, /for claude:/);
    assert.ok(p.has('.mcp.json') && p.has('.claude/settings.json'));
    assert.equal(p.has('.codex'), false, 'only the agents it found');
    assert.deepEqual(
      installer.calls.map(c => [shellLine(c.command), c.cwd]),
      [[`npm install --save-dev agentlane@${VERSION}`, p.dir]],
    );
    assert.match(
      run.stdout,
      new RegExp(
        `Added agentlane@${VERSION} to package\\.json as a dev dependency with npm, because package-lock\\.json is its lockfile: npm install`,
      ),
    );
    assert.match(run.stdout, /Then ask your agent: "Set this project up with agentlane\."/);

    const again = await init(p, [], { installer });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(installer.calls.length, 1, 'a project that lists the toolkit gets no second install');
    assert.ok(again.stdout.includes(`lists agentlane ^${VERSION}, but it isn't installed: run npm install there`), again.stdout);
  } finally {
    p.cleanup();
  }
});

test('the agent running init is found by its variable, beside the files of others', async () => {
  const p = project({ 'package.json': PACKAGE, '.cursor/rules/style.mdc': 'x\n' });
  try {
    const run = await init(p, [], { env: { CODEX_THREAD_ID: 'thread-1' } });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /codex {3}CODEX_THREAD_ID is set, so Codex runs this command\n {2}cursor {2}\.cursor\/\n/);
    assert.ok(p.has('.codex/config.toml') && p.has('.cursor/mcp.json'));
  } finally {
    p.cleanup();
  }
});

test('with no agent found and no terminal, init exits 2, says so and names --agents and --all, and writes nothing', async () => {
  const p = project({ 'AGENTS.md': '# agents\n' });
  const installer = recordingInstaller();
  try {
    const run = await init(p, [], { installer });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /found no agent's files in .+app and no agent's variable in this shell/);
    assert.match(
      run.stderr,
      /to fix: pass --agents with the ones you use \(claude,codex,cursor,copilot,gemini,antigravity\), or --all/,
    );
    assert.deepEqual(fs.readdirSync(p.dir).sort(), ['.git', 'AGENTS.md']);
    assert.equal(installer.calls.length, 0);
  } finally {
    p.cleanup();
  }
});

const KEY = { down: '\x1b[B', space: ' ', enter: '\r', interrupt: '\x03' };

function fakeTerminal(keys: string[]): { terminal: Terminal; shown: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  let typing = false;
  output.on('data', (chunk: Buffer) => {
    shown += chunk.toString();
    if (typing || !shown.includes('Which agents do you use in this project?')) return;
    typing = true;
    const type = () => {
      const key = keys.shift();
      if (key === undefined) return;
      input.write(key);
      setTimeout(type, 20);
    };
    setTimeout(type, 20);
  });
  return { terminal: { input, output }, shown: () => stripVTControlCharacters(shown) };
}

test('in a terminal, init offers every agent with the ones it found checked; Enter takes them, arrows and space change them', async () => {
  const p = project({ 'package.json': PACKAGE, 'GEMINI.md': '# app\n' });
  try {
    const accept = fakeTerminal([KEY.enter]);
    const accepted = await init(p, [], { terminal: accept.terminal });
    assert.equal(accepted.code, 0, accepted.stderr);
    const menu = accept.shown();
    for (const name of ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Gemini CLI (GEMINI.md)', 'Antigravity'])
      assert.ok(menu.includes(name), `${name} in ${menu}`);
    assert.match(menu, /Wrote the files for Gemini CLI/);
    assert.match(menu, /Added agentlane@[^ ]+ to package\.json with npm/);
    assert.match(menu, /Then ask your agent: "Set this project up with agentlane\."/);
    assert.equal(accepted.stdout, '');

    const keys = [KEY.down, KEY.space, KEY.down, KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter];
    const change = fakeTerminal(keys);
    const changed = await init(p, [], { terminal: change.terminal });
    assert.equal(changed.code, 0, changed.stderr);
    assert.match(change.shown(), /the files for Codex, Cursor/);
    assert.ok(fs.existsSync(path.join(p.dir, '.codex')));
    assert.ok(fs.existsSync(path.join(p.dir, '.cursor')));
  } finally {
    p.cleanup();
  }
});

test('in a terminal with nothing found, Enter alone asks for an agent, and Ctrl-C wires nothing', async () => {
  const p = project({ 'package.json': PACKAGE });
  try {
    const none = fakeTerminal([KEY.enter, KEY.space, KEY.enter]);
    const run = await init(p, [], { terminal: none.terminal });
    assert.equal(run.code, 0, run.stderr);
    assert.match(none.shown(), /Please select at least one option/);
    assert.match(none.shown(), /the files for Claude Code/);

    const q = project({ 'package.json': PACKAGE });
    try {
      const stopped = fakeTerminal([KEY.interrupt]);
      const closed = await init(q, [], { terminal: stopped.terminal });
      assert.equal(closed.code, 2);
      assert.match(stopped.shown(), /No agents chosen, so init wrote nothing\./);
      assert.deepEqual(fs.readdirSync(q.dir).sort(), ['.git', 'package.json']);
    } finally {
      q.cleanup();
    }
  } finally {
    p.cleanup();
  }
});
test('each package manager gets its own add command, from the packageManager field, a lockfile, or what ran init', () => {
  const cases: { files: Record<string, string>; env?: NodeJS.ProcessEnv; expected: string }[] = [
    { files: { 'pnpm-lock.yaml': '' }, expected: 'pnpm add --save-dev agentlane@1.2.3' },
    { files: { 'yarn.lock': '__metadata:\n' }, expected: 'yarn add --dev agentlane@1.2.3' },
    { files: { 'bun.lock': '{}' }, expected: 'bun add --dev agentlane@1.2.3' },
    { files: { 'bun.lockb': '' }, expected: 'bun add --dev agentlane@1.2.3' },
    { files: { 'package-lock.json': '{}' }, expected: 'npm install --save-dev agentlane@1.2.3' },
    { files: {}, expected: 'npm install --save-dev agentlane@1.2.3' },
    { files: {}, env: { npm_config_user_agent: 'pnpm/10.0.0 npm/? node/v24' }, expected: 'pnpm add --save-dev agentlane@1.2.3' },
    {
      files: { 'package.json': '{"packageManager": "pnpm@12.11.2"}', 'package-lock.json': '{}' },
      expected: 'pnpm add --save-dev agentlane@1.2.3',
    },
    {
      files: { 'package.json': '{"private": true}', 'pnpm-workspace.yaml': 'packages: []\n', 'pnpm-lock.yaml': '' },
      expected: 'pnpm add --save-dev --workspace-root agentlane@1.2.3',
    },
    {
      files: { 'package.json': '{"workspaces": ["apps/*"]}', 'yarn.lock': '# yarn lockfile v1\n' },
      expected: 'yarn add --dev --ignore-workspace-root-check agentlane@1.2.3',
    },
    {
      files: { 'package.json': '{"workspaces": ["apps/*"], "packageManager": "yarn@4.5.0"}', 'yarn.lock': '' },
      expected: 'yarn add --dev agentlane@1.2.3',
    },
  ];
  for (const { files, env, expected } of cases) {
    const p = project(files);
    try {
      const choice = packageManagerOf(p.dir, p.dir, env ?? {});
      assert.equal(shellLine(addCommand(choice, p.dir, 'agentlane@1.2.3')), expected, JSON.stringify(files));
    } finally {
      p.cleanup();
    }
  }
  const nested = project({ 'pnpm-lock.yaml': '', 'apps/web/package.json': '{}' });
  try {
    const choice = packageManagerOf(path.join(nested.dir, 'apps/web'), nested.dir, {});
    assert.equal(choice.manager, 'pnpm', 'the workspace root’s lockfile counts for a package below it');
  } finally {
    nested.cleanup();
  }
});

test('when the package manager fails, init still writes its files, exits 1 and prints the command to run', async () => {
  const p = project({ 'package.json': PACKAGE, 'pnpm-lock.yaml': '', '.codex/config.toml': '' });
  try {
    const run = await init(p, [], { installer: recordingInstaller('exit 1') });
    assert.equal(run.code, 1);
    assert.ok(p.has('.codex/hooks.json'), 'the files are written');
    assert.match(run.stdout, /created +\.codex\/hooks\.json/);
    assert.equal(
      run.stderr,
      `agentlane init: wrote the files above, but pnpm add --save-dev agentlane@${VERSION} failed (exit 1), so node_modules/.bin/agentlane is missing and the hooks and the MCP server can't start\nto fix: run pnpm add --save-dev agentlane@${VERSION} in ${p.dir}\n`,
    );
  } finally {
    p.cleanup();
  }
});

test('a project with no package.json gets a private one holding the toolkit, and is told when node_modules is not ignored', async () => {
  const p = project({ '.cursor/rules/a.mdc': 'x\n' });
  const installer = recordingInstaller();
  try {
    const run = await init(p, [], { installer });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(manifest(p), { private: true, devDependencies: { agentlane: `^${VERSION}` } });
    assert.match(run.stdout, /Created package\.json, private, to hold agentlane as a dev dependency\./);
    assert.match(run.stdout, /node_modules\/ is not in \.gitignore: add it before you commit\./);
    assert.equal(installer.calls.length, 1);

    const q = project({ '.cursor/rules/a.mdc': 'x\n', '.gitignore': 'node_modules\n' });
    try {
      const ignored = await init(q, []);
      assert.equal(ignored.code, 0, ignored.stderr);
      assert.doesNotMatch(ignored.stdout, /gitignore/);
    } finally {
      q.cleanup();
    }
  } finally {
    p.cleanup();
  }
});

test('a toolkit the project already lists is left alone, with a note when another version is installed', async () => {
  const p = project({
    'package.json': '{"devDependencies": {"agentlane": "^0.2.1"}}\n',
    'node_modules/agentlane/package.json': '{"name": "agentlane", "version": "0.2.1"}\n',
    'pnpm-lock.yaml': '',
    'CLAUDE.md': '',
  });
  const installer = recordingInstaller();
  try {
    const run = await init(p, [], { installer });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(installer.calls.length, 0);
    assert.match(
      run.stdout,
      new RegExp(
        `lists agentlane \\^0\\.2\\.1, with 0\\.2\\.1 installed; init left it as it is\\. This init is ${VERSION.replaceAll('.', '\\.')}: pnpm add --save-dev agentlane@${VERSION.replaceAll('.', '\\.')} moves the project to it\\.`,
      ),
    );
    assert.deepEqual(manifest(p), { devDependencies: { agentlane: '^0.2.1' } });

    p.write('node_modules/agentlane/package.json', `{"version": "${VERSION}"}`);
    const same = await init(p, [], { installer });
    assert.doesNotMatch(same.stdout, /lists agentlane/);
  } finally {
    p.cleanup();
  }
});

test('init --check installs nothing and creates no package.json', async () => {
  const p = project({ 'CLAUDE.md': '' });
  const installer = recordingInstaller();
  try {
    const run = await init(p, ['--check'], { installer });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /would create/);
    assert.equal(installer.calls.length, 0);
    assert.equal(p.has('package.json'), false);
  } finally {
    p.cleanup();
  }
});

test('--agents and --all wire what they name, whatever the project’s files say', async () => {
  const p = project({ 'package.json': PACKAGE, 'CLAUDE.md': '' });
  try {
    const run = await init(p, ['--agents', 'codex']);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /found these agents/);
    assert.match(run.stdout, /agentlane init in .+ for codex:/);
    assert.equal(p.has('.mcp.json'), false);
    const all = await init(p, ['--all']);
    assert.match(all.stdout, /for claude, codex, cursor, copilot, gemini, antigravity:/);
  } finally {
    p.cleanup();
  }
});

test('0.2.x’s Copilot hook file is listed only when init changes or removes it', async () => {
  const p = project({ 'package.json': PACKAGE });
  try {
    const fresh = await init(p, ['--all']);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stdout, /agent-env\.json/);

    p.write('.github/hooks/agent-env.json', '{"version": 1, "hooks": {"preToolUse": [{"bash": "echo theirs"}]}}\n');
    const theirs = await init(p, ['--agents', 'copilot']);
    assert.doesNotMatch(theirs.stdout, /agent-env\.json/, 'a file with none of 0.2.x’s hooks is not init’s');

    p.write(
      '.github/hooks/agent-env.json',
      '{"version": 1, "hooks": {"preToolUse": [{"bash": "d=x; exec \\"$d/node_modules/.bin/agent-env\\" hook pre-tool-use"}]}}\n',
    );
    const former = await init(p, ['--agents', 'copilot']);
    assert.match(former.stdout, /removed +\.github\/hooks\/agent-env\.json/);
    assert.equal(p.has('.github/hooks/agent-env.json'), false);
  } finally {
    p.cleanup();
  }
});
