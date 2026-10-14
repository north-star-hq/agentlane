import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { listSkills, stubOf } from '../../src/agents/skills.ts';
import { outlineToml } from '../../src/agents/toml.ts';
import { agentWiringChecks } from '../../src/agents/wiring-check.ts';
import { findProjectConfig, loadProjectConfig } from '../../src/project/config.ts';
import { UsageError } from '../../src/registry/refusal.ts';
import { tempDir } from '../support/fakes.ts';
import { recordingInstaller } from '../support/installer.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'init-0.2.1');
const SKILLS = listSkills();

interface Project {
  dir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** A copy of a project as 0.2.1's `init --all` left it, in a git worktree of its own. */
function wiredBy021(fixture: 'plain' | 'plugin'): Project {
  const root = fs.realpathSync(tempDir('upgrade'));
  const dir = path.join(root, 'app');
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true, verbatimSymlinks: true });
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  return {
    dir,
    env: { AGENTLANE_STATE_DIR: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function init(p: Project, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runAgentCommand('init', args, {
    env: p.env,
    cwd: p.dir,
    install: recordingInstaller().install,
    stdout: text => (stdout += text),
    stderr: text => (stderr += text),
    now: () => Date.UTC(2026, 9, 13, 9, 0, 0),
  });
  return { code, stdout, stderr };
}

function json(p: Project, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(p.dir, file), 'utf8')) as Record<string, unknown>;
}

function keys(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value) : [];
}

function entries(doc: Record<string, unknown>, event: string): unknown[] {
  const hooks = doc.hooks as Record<string, unknown> | undefined;
  const list = hooks?.[event];
  return Array.isArray(list) ? list : [];
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => {
    if (file === '.git' || file.startsWith(`.git${path.sep}`)) return false;
    const stat = fs.lstatSync(path.join(dir, file));
    return stat.isFile();
  });
}

function formerNamesIn(p: Project, allowed: readonly string[] = []): string[] {
  return files(p.dir).flatMap(file => {
    const text = fs.readFileSync(path.join(p.dir, file), 'utf8');
    const left = allowed.reduce((t, a) => t.replaceAll(a, ''), text);
    return left.includes('agent-env') ? [file] : [];
  });
}

test("one init over a project 0.2.x's init wired for every agent leaves one copy of each piece of wiring, under the new names", async () => {
  const p = wiredBy021('plain');
  try {
    const stale = agentWiringChecks(p.dir, p.env).filter(c => c.warning);
    assert.ok(stale.length > 0, "doctor doesn't notice 0.2.x's wiring");
    assert.ok(stale.every(c => c.fix.startsWith('node_modules/.bin/agentlane init --agents')));

    const run = await init(p, '--all');
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /removed +\.github\/hooks\/agent-env\.json/);
    assert.deepEqual(formerNamesIn(p), [], "0.2.x's names are left in the project's wiring");

    for (const file of ['.mcp.json', '.cursor/mcp.json', '.gemini/settings.json', '.agents/mcp_config.json'])
      assert.deepEqual(keys(json(p, file).mcpServers), ['agentlane'], file);
    assert.deepEqual(
      outlineToml(fs.readFileSync(path.join(p.dir, '.codex/config.toml'), 'utf8')).headers.map(h => h.path.join('.')),
      ['mcp_servers.agentlane'],
    );
    const hooks: [string, string[]][] = [
      ['.claude/settings.json', ['PreToolUse', 'SessionEnd']],
      ['.codex/hooks.json', ['PreToolUse', 'SessionEnd']],
      ['.cursor/hooks.json', ['beforeShellExecution', 'sessionEnd']],
      ['.github/hooks/agentlane.json', ['preToolUse', 'sessionEnd']],
      ['.gemini/settings.json', ['BeforeTool', 'SessionEnd']],
    ];
    for (const [file, events] of hooks) {
      for (const event of events) assert.equal(entries(json(p, file), event).length, 1, `${file} ${event}`);
    }
    assert.equal(fs.existsSync(path.join(p.dir, '.github/hooks/agent-env.json')), false);
    assert.deepEqual(keys(json(p, '.agents/hooks.json')), ['agentlane']);
    for (const skill of SKILLS) {
      assert.equal(fs.readFileSync(path.join(p.dir, '.agents/skills', skill.name, 'SKILL.md'), 'utf8'), stubOf(skill));
      assert.equal(fs.readlinkSync(path.join(p.dir, '.claude/skills', skill.name)), `../../.agents/skills/${skill.name}`);
    }
    assert.equal(fs.readlinkSync(path.join(p.dir, '.claude/skills/run')), '../../.agents/skills/run');

    const again = await init(p, '--all', '--check');
    assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
    assert.deepEqual(
      agentWiringChecks(p.dir, p.env).filter(c => c.warning),
      [],
    );
  } finally {
    p.cleanup();
  }
});

test("where the project enables 0.2.x's plugin, init enables it under the new name and leaves Claude Code to it", async () => {
  const p = wiredBy021('plugin');
  try {
    const run = await init(p, '--all');
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /the project enables the agentlane plugin in \.claude\/settings\.json/);
    const settings = json(p, '.claude/settings.json');
    assert.deepEqual(settings.enabledPlugins, { 'agentlane@agentlane': true });
    assert.deepEqual(settings.extraKnownMarketplaces, {
      agentlane: { source: { source: 'github', repo: 'north-star-hq/agent-env' } },
    });
    assert.deepEqual(settings.disabledMcpjsonServers, ['agentlane']);
    assert.equal(settings.hooks, undefined);
    assert.deepEqual(keys(json(p, '.mcp.json').mcpServers), ['agentlane']);
    assert.deepEqual(formerNamesIn(p, ['north-star-hq/agent-env']), []);
    assert.equal(fs.existsSync(path.join(p.dir, '.github/hooks/agent-env.json')), false);
    assert.equal(fs.readlinkSync(path.join(p.dir, '.claude/skills/run')), '../../.agents/skills/run');
    for (const skill of SKILLS) assert.equal(fs.existsSync(path.join(p.dir, '.claude/skills', skill.name)), false);

    const again = await init(p, '--all', '--check');
    assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
  } finally {
    p.cleanup();
  }
});

test("a project with 0.2.x's agent-env.json is refused with the renames it needs, and init still finds its folder", async () => {
  const p = wiredBy021('plain');
  try {
    const sub = path.join(p.dir, 'src');
    fs.mkdirSync(sub);
    const former = path.join(p.dir, 'agent-env.json');
    fs.writeFileSync(former, '{"services": {}}\n');
    for (const attempt of [() => findProjectConfig(sub), () => loadProjectConfig(former)]) {
      assert.throws(attempt, (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /agent-env\.json is a 0\.2\.x config; agentlane reads agentlane\.json/);
        assert.match(error.fix, /rename it to agentlane\.json, point its "\$schema" at agentlane\.schema\.json/);
        assert.match(error.fix, /AGENT_ENV_ variables .* to AGENTLANE_ \(AGENT_ENV_CLAIM is AGENTLANE_LANE now\)/);
        return true;
      });
    }
    let stdout = '';
    const code = await runAgentCommand('init', ['--agents', 'codex', '--check'], {
      env: p.env,
      cwd: sub,
      install: recordingInstaller().install,
      stdout: text => (stdout += text),
      stderr: () => undefined,
    });
    assert.equal(code, 1);
    assert.match(stdout, new RegExp(`agentlane init in ${p.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} for codex`));
  } finally {
    p.cleanup();
  }
});
