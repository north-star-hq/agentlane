import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { agentsSetUp, agentWiringChecks } from '../../src/agents/wiring-check.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { diagnose, renderDoctor } from '../../src/up/doctor.ts';
import { tempDir } from '../support/fakes.ts';
import { recordingInstaller } from '../support/installer.ts';

function project(): { dir: string; state: string; cleanup: () => void } {
  const root = fs.realpathSync(tempDir('wiring'));
  const dir = path.join(root, 'app');
  fs.mkdirSync(dir);
  spawnSync('git', ['init', '-q', dir]);
  return {
    dir,
    state: path.join(root, 'state'),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function hermetic(state: string): NodeJS.ProcessEnv {
  return { AGENTLANE_STATE_DIR: state, CLAUDE_CONFIG_DIR: path.join(state, '..', 'claude-config') };
}

async function init(dir: string, state: string, agents: string, env: NodeJS.ProcessEnv = hermetic(state)): Promise<string> {
  const out: string[] = [];
  const code = await runAgentCommand('init', ['--agents', agents], {
    env,
    cwd: dir,
    install: recordingInstaller().install,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
  });
  assert.equal(code, 0, out.join(''));
  return out.join('');
}

test('a project that never ran init gets no wiring lines, and one that did gets a line per agent it set up', async () => {
  const { dir, state, cleanup } = project();
  try {
    assert.deepEqual(agentWiringChecks(dir, hermetic(state)), []);
    await init(dir, state, 'codex,gemini');
    assert.deepEqual(agentsSetUp(dir), ['codex', 'gemini']);
    assert.deepEqual(
      agentWiringChecks(dir, hermetic(state)).map(c => [c.name, c.warning, c.detail]),
      [
        ['wiring skills', false, '6 skill stubs in .agents/skills'],
        ['wiring codex', false, 'MCP server and hooks in place'],
        ['wiring gemini', false, 'MCP server and hooks in place'],
      ],
    );
    await init(dir, state, 'copilot');
    assert.deepEqual(
      agentsSetUp(dir),
      ['codex', 'copilot', 'gemini'],
      'the shared .mcp.json does not count Claude Code as set up',
    );
  } finally {
    cleanup();
  }
});

test('missing, stale and unreadable wiring is a warning naming the file and the fix, and doctor stays ready', async () => {
  const { dir, state, cleanup } = project();
  try {
    await init(dir, state, 'codex,gemini,claude');
    fs.rmSync(path.join(dir, '.codex/hooks.json'));
    fs.rmSync(path.join(dir, '.agents/skills/device'), { recursive: true });
    const settings = path.join(dir, '.gemini/settings.json');
    fs.writeFileSync(settings, fs.readFileSync(settings, 'utf8').replace('--agent gemini', '--agent claude'));
    fs.rmSync(path.join(dir, '.claude/skills/dev-loop'));

    const checks = agentWiringChecks(dir, hermetic(state));
    const byName = new Map(checks.map(c => [c.name, c]));
    assert.equal(byName.get('wiring skills')?.detail, 'missing .agents/skills/device/SKILL.md (skills)');
    assert.equal(byName.get('wiring codex')?.detail, 'missing .codex/hooks.json (guard hook, release hook)');
    assert.equal(byName.get('wiring codex')?.fix, 'node_modules/.bin/agentlane init --agents codex');
    assert.equal(byName.get('wiring gemini')?.detail, 'stale .gemini/settings.json (MCP server, guard hook, release hook)');
    assert.equal(byName.get('wiring claude')?.detail, 'missing .claude/skills/dev-loop (skills)');
    assert.equal(byName.get('wiring skills')?.fix, 'node_modules/.bin/agentlane init --agents claude,codex,gemini');

    fs.writeFileSync(settings, '{ broken');
    assert.match(
      agentWiringChecks(dir, hermetic(state)).find(c => c.name === 'wiring gemini')?.detail ?? '',
      /\.gemini\/settings\.json: it isn't valid JSON/,
    );

    const report = await diagnose({ env: hermetic(state) } as EnvDeps, {
      config: null,
      configProblem: 'no config',
      lane: null,
      ownerState: null,
      folder: dir,
    });
    const wiring = report.checks.filter(c => c.name.startsWith('wiring'));
    assert.equal(wiring.length, 4);
    assert.ok(wiring.every(c => c.ok));
    const rendered = renderDoctor({ ok: true, lane: null, checks: wiring });
    assert.match(
      rendered,
      /^warn {2}wiring skills: missing \.agents\/skills\/device\/SKILL\.md \(skills\)\n {8}fix: node_modules\/\.bin\/agentlane init --agents/m,
    );
    assert.match(rendered, /\nready\n$/);
  } finally {
    cleanup();
  }
});
