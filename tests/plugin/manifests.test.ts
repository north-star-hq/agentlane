import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mcpLaunch } from '../../src/agents/launcher.ts';
import { listSkills } from '../../src/agents/skills.ts';

const PLUGIN = path.resolve(import.meta.dirname, '..', '..', 'plugin');
const PACKAGE_VERSION = (JSON.parse(fs.readFileSync(path.join(PLUGIN, '..', 'package.json'), 'utf8')) as { version: string })
  .version;

function read(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN, file), 'utf8')) as Record<string, unknown>;
}

function inside(relative: string): string {
  assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'), relative);
  const resolved = path.join(PLUGIN, relative);
  assert.ok(fs.existsSync(resolved), `${relative} exists`);
  return resolved;
}

test('Claude Code’s hooks live outside hooks/hooks.json, so Codex, Cursor and Gemini, which read that path, load none of them', () => {
  assert.equal(fs.existsSync(path.join(PLUGIN, 'hooks', 'hooks.json')), false);
  const claude = read('.claude-plugin/plugin.json');
  const hooks = JSON.parse(fs.readFileSync(inside(String(claude.hooks)), 'utf8')) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PreToolUse', 'SessionEnd']);
  assert.deepEqual(claude.mcpServers, { device: { command: '${CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh' } });
  assert.deepEqual(read('.codex-plugin/plugin.json').hooks, {}, 'Codex gets an explicit empty hooks');
  assert.equal(read('.cursor-plugin/plugin.json').hooks, undefined);
});

test('the Codex, Cursor and Gemini manifests serve the same skills and the same MCP server as init writes', () => {
  const launcher = mcpLaunch();
  assert.deepEqual(read('.mcp.json'), { mcpServers: { device: launcher } });
  for (const manifest of ['.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    const fields = read(manifest);
    assert.equal(fields.name, 'agentlane', manifest);
    assert.equal(path.resolve(inside(String(fields.skills))), path.join(PLUGIN, 'skills'), manifest);
    assert.equal(inside(String(fields.mcpServers)), path.join(PLUGIN, '.mcp.json'), manifest);
  }
  const gemini = read('gemini-extension.json');
  assert.equal(gemini.name, 'agentlane');
  assert.equal(gemini.version, PACKAGE_VERSION);
  assert.deepEqual(gemini.mcpServers, { device: { ...launcher, cwd: '${workspacePath}' } });
  assert.deepEqual(
    fs.readdirSync(path.join(PLUGIN, 'skills')).sort(),
    listSkills().map(s => s.name),
  );
});
