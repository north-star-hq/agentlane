import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { hookCommand, mcpLaunch } from '../../src/agents/launcher.ts';
import { listSkills, stubOf } from '../../src/agents/skills.ts';
import { tempDir } from '../support/fakes.ts';
import { recordingInstaller } from '../support/installer.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXAMPLE = 'examples/expo-app';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function init(dir: string, state: string, ...args: string[]): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runAgentCommand('init', args, {
    env: { AGENTLANE_STATE_DIR: state, CLAUDE_CONFIG_DIR: path.join(state, '..', 'claude-config') },
    cwd: dir,
    install: recordingInstaller().install,
    stdout: text => (stdout += text),
    stderr: text => (stderr += text),
    now: () => Date.UTC(2026, 9, 12, 9, 0, 0),
  });
  return { code, stdout, stderr };
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function exampleCopy(): { dir: string; state: string; cleanup: () => void } {
  const root = fs.realpathSync(tempDir('init-example'));
  const dir = path.join(root, 'expo-app');
  for (const file of git(ROOT, 'ls-files', EXAMPLE).trim().split('\n')) {
    const to = path.join(dir, path.relative(EXAMPLE, file));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const from = path.join(ROOT, file);
    if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'the example');
  return {
    dir,
    state: path.join(root, 'state'),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function json(dir: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
}

function project(): { dir: string; state: string; cleanup: () => void } {
  const root = fs.realpathSync(tempDir('init-project'));
  const dir = path.join(root, 'app');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  return {
    dir,
    state: path.join(root, 'state'),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

test('init --all on a copy of the example app writes every agent’s files, and a second run changes nothing', async () => {
  const { dir, state, cleanup } = exampleCopy();
  try {
    const first = await init(dir, state, '--all');
    assert.equal(first.code, 0, first.stderr);
    const toolkitSkills = new Set(listSkills().map(skill => skill.name));
    for (const skill of listSkills())
      assert.equal(fs.readFileSync(path.join(dir, '.agents/skills', skill.name, 'SKILL.md'), 'utf8'), stubOf(skill));
    const launcher = mcpLaunch();
    for (const file of ['.mcp.json', '.cursor/mcp.json', '.gemini/settings.json', '.agents/mcp_config.json'])
      assert.deepEqual((json(dir, file).mcpServers as Record<string, unknown>).agentlane, launcher, file);
    assert.match(
      fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8'),
      /^\[mcp_servers\.agentlane\]\ncommand = "sh"\nargs = \["-c", /,
    );
    assert.match(
      JSON.stringify(json(dir, '.codex/hooks.json')),
      /hook pre-tool-use --agent codex.*hook session-end --agent codex/,
    );
    assert.match(JSON.stringify(json(dir, '.cursor/hooks.json')), /"beforeShellExecution".*--agent cursor.*"sessionEnd"/);
    assert.match(JSON.stringify(json(dir, '.github/hooks/agentlane.json')), /"preToolUse".*--agent copilot.*"sessionEnd"/);
    assert.match(
      JSON.stringify(json(dir, '.gemini/settings.json')),
      /"BeforeTool".*"run_shell_command".*--agent gemini.*"SessionEnd"/,
    );
    assert.match(JSON.stringify(json(dir, '.agents/hooks.json')), /"agentlane":\{"PreToolUse":\[\{"matcher":"run_command"/);

    const settings = json(dir, '.claude/settings.json');
    assert.deepEqual(settings.enabledPlugins, { 'agentlane@agentlane': true }, 'the example’s own settings survive');
    assert.deepEqual(settings.disabledMcpjsonServers, ['agentlane']);
    assert.equal(settings.hooks, undefined, 'the plugin already brings the Claude Code hooks');
    const ownSkills = fs.readdirSync(path.join(dir, '.agents/skills')).filter(name => !toolkitSkills.has(name));
    assert.ok(ownSkills.length > 0, 'the example has skills of its own');
    assert.deepEqual(
      fs.readdirSync(path.join(dir, '.claude/skills')).sort(),
      ownSkills.sort(),
      'the plugin already brings the toolkit’s skills',
    );
    for (const name of ownSkills)
      assert.equal(fs.readlinkSync(path.join(dir, '.claude/skills', name)), `../../.agents/skills/${name}`);
    assert.match(first.stdout, /the project enables the agentlane plugin/);
    assert.match(first.stdout, /Commit the files above/);

    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const second = await init(dir, state, '--all');
    assert.equal(second.code, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /created|updated/);
    assert.match(second.stdout, /Nothing to change/);
    assert.equal(git(dir, 'status', '--porcelain'), '', 'a second run leaves the tree as it was');
    assert.equal(git(dir, 'diff', 'HEAD'), '');
    assert.equal((await init(dir, state, '--all', '--check')).code, 0);
  } finally {
    cleanup();
  }
});

test('a file init can’t parse is refused with its reason, and nothing at all is written', async () => {
  const { dir, state, cleanup } = project();
  try {
    write(dir, '.cursor/mcp.json', '{ "mcpServers": ');
    write(dir, '.codex/config.toml', 'model = "o3\n');
    const run = await init(dir, state, '--agents', 'cursor,codex,gemini');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /\.cursor\/mcp\.json: it isn't valid JSON \(.+\); init leaves a file it can't merge into untouched/);
    assert.match(run.stderr, /\.codex\/config\.toml: it isn't valid TOML \(line 1: a string is not closed\)/);
    assert.match(run.stderr, /wrote nothing; fix those files and run node_modules\/\.bin\/agentlane init again/);
    assert.match(run.stdout, /REFUSED +\.cursor\/mcp\.json/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.codex', '.cursor', '.git']);
    assert.equal(fs.readFileSync(path.join(dir, '.cursor/mcp.json'), 'utf8'), '{ "mcpServers": ');
    assert.equal(fs.existsSync(path.join(dir, '.codex/hooks.json')), false);
    assert.equal(fs.existsSync(state), false, 'no backup either');

    write(dir, '.cursor/mcp.json', '[1, 2]');
    write(dir, '.codex/config.toml', 'mcp_servers = { agentlane = { command = "npx" } }\n');
    const shapes = await init(dir, state, '--agents', 'cursor,codex');
    assert.equal(shapes.code, 1);
    assert.match(shapes.stderr, /\.cursor\/mcp\.json: it holds JSON that is not an object/);
    assert.match(shapes.stderr, /\.codex\/config\.toml: line 1 sets mcp_servers outside \[mcp_servers\.agentlane\]/);
  } finally {
    cleanup();
  }
});

test('what the files already hold survives: other settings, servers, hooks, tables and comments stay, and the originals are backed up', async () => {
  const { dir, state, cleanup } = project();
  try {
    const claudeSettings = {
      permissions: { allow: ['Bash(pnpm test)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }],
        SessionEnd: [
          {
            matcher: 'prompt_input_exit|logout|other',
            hooks: [
              { type: 'command', command: '"$(git rev-parse --show-toplevel)/node_modules/.bin/agentlane" hook session-end' },
            ],
          },
        ],
      },
    };
    write(dir, '.claude/settings.json', `${JSON.stringify(claudeSettings, null, 4)}\n`);
    write(dir, '.mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }));
    const toml = `# the team's Codex settings
model = "o3"

[mcp_servers.docs]
command = "docs-mcp"

[mcp_servers.agentlane]
command = "npx"
args = ["agentlane", "mcp"]
# the next table
[mcp_servers.agentlane.env]
LOG = "1"

[profiles.fast]
model = "o4-mini"
`;
    write(dir, '.codex/config.toml', toml);
    const legacy = {
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: 'command',
                command: '"$(git rev-parse --show-toplevel)/node_modules/.bin/agentlane" hook session-end --codex',
                timeout: 3,
              },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      },
    };
    write(dir, '.codex/hooks.json', JSON.stringify(legacy));
    write(dir, '.gemini/settings.json', JSON.stringify({ context: { fileName: ['AGENTS.md'] } }));
    write(dir, '.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './fmt.sh' }] } }));
    write(dir, '.agents/hooks.json', JSON.stringify({ linter: { PostToolUse: [{ matcher: 'run_command', hooks: [] }] } }));
    write(dir, '.agents/skills/run/SKILL.md', '---\nname: run\ndescription: Run this app.\n---\n\nRun it.\n');

    const run = await init(dir, state, '--all');
    assert.equal(run.code, 0, run.stderr);
    const settings = json(dir, '.claude/settings.json');
    assert.deepEqual(settings.permissions, claudeSettings.permissions);
    const hooks = settings.hooks as Record<string, unknown[]>;
    assert.deepEqual(hooks.PostToolUse, claudeSettings.hooks.PostToolUse);
    assert.equal(hooks.PreToolUse?.length, 1);
    assert.equal(hooks.SessionEnd?.length, 1, 'the old session-end hook is replaced, not doubled');
    assert.match(JSON.stringify(hooks.SessionEnd), /"timeout":10\b/);
    assert.match(
      fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'),
      /^\{\n {4}"permissions"/,
      'its indentation is kept',
    );
    assert.deepEqual(Object.keys(json(dir, '.mcp.json').mcpServers as object), ['docs', 'agentlane']);

    const codex = fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8');
    assert.ok(
      codex.startsWith(
        `# the team's Codex settings\nmodel = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[mcp_servers.agentlane]\ncommand = "sh"\n`,
      ),
      codex,
    );
    assert.ok(
      codex.includes('\n# the next table\n[mcp_servers.agentlane.env]\nLOG = "1"\n\n[profiles.fast]\nmodel = "o4-mini"\n'),
      codex,
    );
    assert.doesNotMatch(codex, /npx/);

    const codexHooks = json(dir, '.codex/hooks.json').hooks as Record<string, unknown[]>;
    assert.deepEqual(codexHooks.Stop, legacy.hooks.Stop);
    assert.equal(codexHooks.SessionEnd?.length, 1, 'the old session-end hook is replaced, not doubled');
    assert.match(JSON.stringify(codexHooks.SessionEnd), /--agent codex/);
    assert.deepEqual(json(dir, '.gemini/settings.json').context, { fileName: ['AGENTS.md'] });
    assert.deepEqual((json(dir, '.cursor/hooks.json').hooks as Record<string, unknown>).afterFileEdit, [{ command: './fmt.sh' }]);
    assert.deepEqual(Object.keys(json(dir, '.agents/hooks.json')), ['linter', 'agentlane']);
    assert.equal(
      fs.readlinkSync(path.join(dir, '.claude/skills/run')),
      '../../.agents/skills/run',
      'the project’s own skill is mirrored',
    );
    assert.equal(fs.readlinkSync(path.join(dir, '.claude/skills/device')), '../../.agents/skills/device');
    assert.match(fs.readFileSync(path.join(dir, '.claude/skills/device/SKILL.md'), 'utf8'), /agentlane skills get device/);

    const backups = path.join(state, 'init-backups', '2026-10-12T09-00-00-000Z-app');
    assert.ok(run.stdout.includes(`Backed up the files it changed in ${backups}.`), run.stdout);
    assert.equal(fs.readFileSync(path.join(backups, '.codex/config.toml'), 'utf8'), toml);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backups, '.codex/hooks.json'), 'utf8')), legacy);
    assert.equal(fs.existsSync(path.join(backups, '.cursor/mcp.json')), false, 'a created file has nothing to back up');

    const again = await init(dir, state, '--all');
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Nothing to change/);
  } finally {
    cleanup();
  }
});

test('init refuses to replace a skill of the project’s own that shares a toolkit skill’s name, and turns an exact copy into a link', async () => {
  const { dir, state, cleanup } = project();
  try {
    write(
      dir,
      '.agents/skills/device/SKILL.md',
      '---\nname: device\ndescription: Our own device notes.\n---\n\nUse the lab phone.\n',
    );
    write(dir, '.claude/skills/dev-loop/SKILL.md', '---\nname: dev-loop\ndescription: Ours.\n---\n\nOur loop.\n');
    const run = await init(dir, state, '--agents', 'claude');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /\.agents\/skills\/device\/SKILL\.md: it holds a different skill named device; rename one of them/);
    assert.match(
      run.stderr,
      /\.claude\/skills\/dev-loop: it holds its own copy of the dev-loop skill; keep one copy, in \.agents\/skills\/dev-loop\//,
    );

    fs.rmSync(path.join(dir, '.agents'), { recursive: true });
    const devLoop = listSkills().find(s => s.name === 'dev-loop');
    assert.ok(devLoop);
    write(dir, '.claude/skills/dev-loop/SKILL.md', stubOf(devLoop));
    const fixed = await init(dir, state, '--agents', 'claude');
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.equal(fs.lstatSync(path.join(dir, '.claude/skills/dev-loop')).isSymbolicLink(), true);
    const backups = path.join(state, 'init-backups', '2026-10-12T09-00-00-000Z-app');
    assert.equal(fs.readFileSync(path.join(backups, '.claude/skills/dev-loop/SKILL.md'), 'utf8'), stubOf(devLoop));
  } finally {
    cleanup();
  }
});

test('init names the agents it needs, and refuses an unknown one', async () => {
  const { dir, state, cleanup } = project();
  try {
    assert.match(
      (await init(dir, state)).stderr,
      /found no agent's files in .+ and no agent's variable in this shell, so init doesn't know which agents to wire\nto fix: pass --agents with the ones you use \(claude,codex,cursor,copilot,gemini,antigravity\), or --all/,
    );
    const unknown = await init(dir, state, '--agents', 'claude,kiro');
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /'kiro' is not an agent/);
    assert.equal((await init(dir, state, '--agents', 'codex', '--all')).code, 2);
    assert.match((await init(dir, state, '--all', '--dir', 'missing')).stderr, /missing is not a folder/);
    assert.equal(fs.readdirSync(dir).join(), '.git');
  } finally {
    cleanup();
  }
});

function shells(): string[] {
  return ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(shell => fs.existsSync(shell));
}

test('the hook launcher runs the project’s toolkit from a subfolder with the hook input, and allows when there is none', () => {
  const { dir, cleanup } = project();
  try {
    const bin = path.join(dir, 'node_modules/.bin/agentlane');
    write(dir, 'node_modules/.bin/agentlane', '#!/bin/sh\nprintf "args:%s\\n" "$*"; cat\n');
    fs.chmodSync(bin, 0o755);
    const sub = path.join(dir, 'apps/mobile');
    fs.mkdirSync(sub, { recursive: true });
    for (const event of ['pre-tool-use', 'session-end'] as const)
      assert.doesNotMatch(hookCommand('gemini', event), /\$GEMINI_PROJECT_DIR|\$CLAUDE_PROJECT_DIR/, 'Gemini rewrites these');
    const empty = fs.realpathSync(tempDir('init-no-toolkit'));
    for (const shell of shells()) {
      const run = (cwd: string, agent: 'codex' | 'cursor' | 'gemini', env: NodeJS.ProcessEnv = {}) =>
        spawnSync(shell, ['-c', hookCommand(agent, 'pre-tool-use')], {
          cwd,
          input: '{"tool_input":{"command":"adb devices"}}',
          encoding: 'utf8',
          env: { PATH: process.env.PATH, ...env },
        });
      const found = run(sub, 'codex');
      assert.equal(found.status, 0, `${shell}: ${found.stderr}`);
      assert.equal(found.stdout, 'args:hook pre-tool-use --agent codex\n{"tool_input":{"command":"adb devices"}}', shell);
      assert.equal(
        run(empty, 'cursor', { CURSOR_PROJECT_DIR: dir }).stdout.split('\n')[0],
        'args:hook pre-tool-use --agent cursor',
      );

      const none = run(empty, 'gemini');
      assert.deepEqual([none.status, none.stdout, none.stderr], [0, '', ''], shell);
      const cursor = run(empty, 'cursor');
      assert.deepEqual([cursor.status, cursor.stdout], [0, '{"permission":"allow"}\n'], shell);

      const { command, args } = mcpLaunch();
      const server = spawnSync(command, args, { cwd: empty, encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(server.status, 1);
      assert.match(server.stderr, /agentlane: no node_modules\/\.bin\/agentlane in .* or the folders above it/);
    }
    fs.rmSync(empty, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

interface Server {
  command: string;
  args: string[];
}

function serverIn(dir: string, file: string): Server {
  if (file.endsWith('.toml')) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const command = /^command = (".*")$/m.exec(text)?.[1] ?? '""';
    const args = /^args = (\[.*\])$/m.exec(text)?.[1] ?? '[]';
    return { command: JSON.parse(command) as string, args: JSON.parse(args) as string[] };
  }
  return (json(dir, file).mcpServers as Record<string, Server>).agentlane ?? { command: '', args: [] };
}

async function mcpAnswers(server: Server, cwd: string, state: string): Promise<{ tools: string[]; look: string }> {
  const child = spawn(server.command, server.args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: state, AGENTLANE_OWNER_PID: String(process.pid) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
    if (typeof message.id === 'number') waiting.get(message.id)?.(message.result ?? {});
  });
  const ask = (id: number, method: string, params: object) =>
    new Promise<Record<string, unknown>>(resolve => {
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = (await ask(2, 'tools/list', {})) as { tools: { name: string }[] };
    const look = await ask(3, 'tools/call', { name: 'look', arguments: {} });
    return { tools: list.tools.map(t => t.name).sort(), look: JSON.stringify(look) };
  } finally {
    child.kill('SIGTERM');
  }
}

test('the MCP server each agent’s config names starts the project’s toolkit from a subfolder and answers', async () => {
  const { dir, state, cleanup } = project();
  try {
    write(
      dir,
      'node_modules/.bin/agentlane',
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'src', 'cli.ts')}" "$@"\n`,
    );
    fs.chmodSync(path.join(dir, 'node_modules/.bin/agentlane'), 0o755);
    assert.equal((await init(dir, state, '--all')).code, 0);
    const sub = path.join(dir, 'apps', 'mobile');
    fs.mkdirSync(sub, { recursive: true });
    const files: [string, string][] = [
      ['claude, copilot', '.mcp.json'],
      ['codex', '.codex/config.toml'],
      ['cursor', '.cursor/mcp.json'],
      ['gemini', '.gemini/settings.json'],
      ['antigravity', '.agents/mcp_config.json'],
    ];
    for (const [agents, file] of files) {
      const answer = await mcpAnswers(serverIn(dir, file), sub, state);
      assert.deepEqual(answer.tools, ['look', 'run', 'screenshot'], `${agents}: ${file}`);
      assert.match(answer.look, /holds no lane .*node_modules\/\.bin\/agentlane claim --boot/, `${agents}: ${file}`);
    }
  } finally {
    cleanup();
  }
});
