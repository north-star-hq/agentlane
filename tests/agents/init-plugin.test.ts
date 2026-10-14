import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { listSkills } from '../../src/agents/skills.ts';
import { agentWiringChecks } from '../../src/agents/wiring-check.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { diagnose, renderDoctor } from '../../src/up/doctor.ts';
import { tempDir } from '../support/fakes.ts';
import { recordingInstaller } from '../support/installer.ts';

const PLUGIN = path.resolve(import.meta.dirname, '..', '..', 'plugin');
const TOOLKIT = listSkills().map(skill => skill.name);
const SESSION = { CLAUDECODE: '1', PATH: ['/usr/bin', path.join(PLUGIN, 'bin'), '/bin'].join(path.delimiter) };

interface Project {
  root: string;
  dir: string;
  env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  cleanup: () => void;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function json(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function project(): Project {
  const root = fs.realpathSync(tempDir('init-plugin'));
  const dir = path.join(root, 'app');
  fs.mkdirSync(dir);
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  write(path.join(dir, '.agents/skills/run/SKILL.md'), '---\nname: run\ndescription: Run the app.\n---\n\nRun it.\n');
  const base = { AGENTLANE_STATE_DIR: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') };
  return {
    root,
    dir,
    env: (extra = {}) => ({ ...base, ...extra }),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function init(
  p: Project,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runAgentCommand('init', args, {
    env,
    cwd: p.dir,
    install: recordingInstaller().install,
    stdout: text => (stdout += text),
    stderr: text => (stderr += text),
    now: () => Date.UTC(2026, 9, 13, 9, 0, 0),
  });
  return { code, stdout, stderr };
}

function wiredThroughThePluginOnly(p: Project, otherAgents: boolean): void {
  assert.equal(fs.existsSync(path.join(p.dir, '.mcp.json')), false, 'no second MCP server');
  const settings = json(path.join(p.dir, '.claude/settings.json'));
  assert.equal(settings.hooks, undefined, 'no second set of hooks');
  assert.deepEqual(settings.disabledMcpjsonServers, ['agentlane']);
  assert.deepEqual(fs.readdirSync(path.join(p.dir, '.claude/skills')), ['run'], "only the project's own skill");
  assert.equal(fs.readlinkSync(path.join(p.dir, '.claude/skills/run')), '../../.agents/skills/run');
  for (const name of TOOLKIT)
    assert.equal(
      fs.existsSync(path.join(p.dir, '.agents/skills', name, 'SKILL.md')),
      otherAgents,
      `${name}: the stubs are for the other agents`,
    );
}

const SOURCES: { label: string; arrange: (p: Project) => NodeJS.ProcessEnv; says: RegExp }[] = [
  {
    label: 'the session loads it with --plugin-dir',
    arrange: p => p.env(SESSION),
    says: /this Claude Code session loads the agentlane plugin from .*\/plugin, which brings the skills, the MCP server and the hooks, so init wrote none of them for Claude Code.*run node_modules\/\.bin\/agentlane init again outside a session that loads the plugin/,
  },
  {
    label: "the user's settings enable it",
    arrange: p => {
      write(
        path.join(p.root, 'claude-config/settings.json'),
        JSON.stringify({ enabledPlugins: { 'agentlane@north-star': true } }),
      );
      return p.env();
    },
    says: /your user settings \(.*claude-config\/settings\.json\) enable the agentlane plugin in every project, which brings .*enable the plugin in the project's \.claude\/settings\.json\./,
  },
  {
    label: 'the local project settings enable it',
    arrange: p => {
      write(path.join(p.dir, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'agentlane@agentlane': true } }));
      return p.env();
    },
    says: /your local settings for this project \(\.claude\/settings\.local\.json\) enable the agentlane plugin/,
  },
];

for (const source of SOURCES) {
  test(`init --agents claude writes no second copy of the plugin's parts when ${source.label}, and says where it found it`, async () => {
    const p = project();
    try {
      const env = source.arrange(p);
      const run = await init(p, env, '--agents', 'claude,codex');
      assert.equal(run.code, 0, run.stderr);
      wiredThroughThePluginOnly(p, true);
      assert.match(run.stdout, source.says);
      assert.ok(fs.existsSync(path.join(p.dir, '.codex/config.toml')), 'the other agents are wired as before');
      assert.equal((await init(p, env, '--agents', 'claude,codex', '--check')).code, 0);
    } finally {
      p.cleanup();
    }
  });
}

test('doctor warns when the plugin and an earlier init both wire Claude Code, and init with the plugin removes the project’s copies', async () => {
  const p = project();
  try {
    assert.equal((await init(p, p.env(), '--agents', 'claude,copilot')).code, 0);
    const file = path.join(p.dir, '.claude/settings.json');
    const own = { type: 'command', command: 'scripts/lint-staged.sh' };
    const settings = json(file);
    const hooks = settings.hooks as Record<string, unknown[]>;
    hooks.PreToolUse?.push({ matcher: 'Edit', hooks: [own] });
    write(file, JSON.stringify({ ...settings, permissions: { allow: ['Bash(pnpm test)'] } }, null, 2));

    const wired = agentWiringChecks(p.dir, p.env(SESSION)).find(c => c.name === 'wiring claude');
    assert.equal(wired?.warning, true);
    assert.match(
      wired.detail,
      /^this Claude Code session loads the agentlane plugin from .*\/plugin, and the project's own MCP server in \.mcp\.json, hooks in \.claude\/settings\.json and 6 toolkit skills in \.claude\/skills wire Claude Code a second time, so a session gets each of them twice$/,
    );
    assert.equal(wired.fix, 'node_modules/.bin/agentlane init --agents claude');
    const report = await diagnose({ env: p.env(SESSION) } as EnvDeps, {
      config: null,
      configProblem: 'no config',
      lane: null,
      ownerState: null,
      folder: p.dir,
    });
    const rendered = renderDoctor({ ok: true, lane: null, checks: report.checks.filter(c => c.name.startsWith('wiring')) });
    assert.match(
      rendered,
      /^warn {2}wiring claude: this Claude Code session .* twice\n {8}fix: node_modules\/\.bin\/agentlane init --agents claude$/m,
    );
    assert.equal(
      agentWiringChecks(p.dir, p.env()).find(c => c.name === 'wiring claude')?.warning,
      false,
      'outside a session with the plugin, the same files are one copy',
    );

    const fixed = await init(p, p.env(SESSION), '--agents', 'claude');
    assert.equal(fixed.code, 0, fixed.stderr);
    for (const name of TOOLKIT) assert.match(fixed.stdout, new RegExp(`removed {6}\\.claude/skills/${name} `));
    assert.match(fixed.stdout, /updated {6}\.claude\/settings\.json/);
    const backups = /Backed up the files it changed in (\S+)\./.exec(fixed.stdout)?.[1];
    assert.ok(backups, fixed.stdout);
    assert.equal(fs.readlinkSync(path.join(backups, '.claude/skills/setup')), '../../.agents/skills/setup');
    assert.match(fs.readFileSync(path.join(backups, '.claude/settings.json'), 'utf8'), /hook pre-tool-use --agent claude/);

    const after = json(file);
    assert.deepEqual(after.hooks, { PreToolUse: [{ matcher: 'Edit', hooks: [own] }] }, 'the project’s own hook stays');
    assert.deepEqual(after.permissions, { allow: ['Bash(pnpm test)'] });
    assert.deepEqual(after.disabledMcpjsonServers, ['agentlane']);
    assert.deepEqual(fs.readdirSync(path.join(p.dir, '.claude/skills')), ['run']);
    assert.ok(fs.existsSync(path.join(p.dir, '.agents/skills/setup/SKILL.md')), 'the other agents keep their stubs');
    assert.ok('agentlane' in (json(path.join(p.dir, '.mcp.json')).mcpServers as object), 'Copilot keeps its server');

    const now = agentWiringChecks(p.dir, p.env(SESSION)).find(c => c.name === 'wiring claude');
    assert.equal(now?.warning, false);
    assert.match(now.detail, /^through the plugin: this Claude Code session loads the agentlane plugin from /);
    assert.equal((await init(p, p.env(SESSION), '--agents', 'claude', '--check')).code, 0);
  } finally {
    p.cleanup();
  }
});

test('a project left to a plugin that is not loaded says so, and init without the plugin wires Claude Code itself again', async () => {
  const p = project();
  try {
    assert.equal((await init(p, p.env(SESSION), '--agents', 'claude')).code, 0);
    wiredThroughThePluginOnly(p, false);

    const alone = agentWiringChecks(p.dir, p.env()).find(c => c.name === 'wiring claude');
    assert.equal(alone?.warning, true);
    assert.match(
      alone.detail,
      /^the project leaves Claude Code to the agentlane plugin, and here no settings file enables it and no session loads it: missing \.mcp\.json/,
    );
    assert.equal(
      alone.fix,
      'load the plugin, or run node_modules/.bin/agentlane init --agents claude to wire Claude Code without it',
    );

    const rewired = await init(p, p.env(), '--agents', 'claude');
    assert.equal(rewired.code, 0, rewired.stderr);
    const settings = json(path.join(p.dir, '.claude/settings.json'));
    assert.equal(settings.disabledMcpjsonServers, undefined, 'Claude Code loads the .mcp.json server again');
    assert.match(JSON.stringify(settings.hooks), /hook pre-tool-use --agent claude/);
    assert.ok('agentlane' in (json(path.join(p.dir, '.mcp.json')).mcpServers as object));
    assert.deepEqual(fs.readdirSync(path.join(p.dir, '.claude/skills')).sort(), [...TOOLKIT, 'run'].sort());
    assert.equal(agentWiringChecks(p.dir, p.env()).find(c => c.name === 'wiring claude')?.warning, false);
  } finally {
    p.cleanup();
  }
});

test('a project that enables the plugin from a GitHub marketplace, with no init files, has no wiring warnings and nothing for init to write', async () => {
  const p = project();
  try {
    fs.rmSync(path.join(p.dir, '.agents'), { recursive: true });
    write(path.join(p.dir, '.claude/skills/run/SKILL.md'), '---\nname: run\ndescription: Run the app.\n---\n\nRun it.\n');
    const settings = {
      permissions: { allow: ['Bash(pnpm test)'] },
      hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'pnpm exec prettier --write' }] }] },
      enabledPlugins: { 'typescript-lsp@claude-plugins-official': true, 'agentlane@agentlane': true },
      extraKnownMarketplaces: {
        agentlane: { source: { source: 'github', repo: 'north-star-hq/agent-env' }, autoUpdate: true },
      },
    };
    write(path.join(p.dir, '.claude/settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    write(path.join(p.dir, '.mcp.json'), JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['context7'] } } }));
    write(path.join(p.dir, 'agentlane.json'), JSON.stringify({ web: { path: '/' }, services: {} }));

    for (const env of [p.env(), p.env(SESSION)]) {
      const report = await diagnose({ env } as EnvDeps, {
        config: null,
        configProblem: 'no config',
        lane: null,
        ownerState: null,
        folder: p.dir,
      });
      const wiring = report.checks.filter(c => c.name.startsWith('wiring'));
      assert.deepEqual(
        wiring.map(c => [c.name, c.warning, c.detail]),
        [['wiring claude', false, 'through the plugin: the project enables the agentlane plugin in .claude/settings.json']],
      );
    }
    const check = await init(p, p.env(), '--agents', 'claude', '--check');
    assert.equal(check.code, 0, check.stdout + check.stderr);
    assert.doesNotMatch(check.stdout, /would (create|update|remove)/);
    assert.equal(fs.existsSync(path.join(p.dir, '.agents')), false);
  } finally {
    p.cleanup();
  }
});
