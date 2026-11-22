import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { CALL_LIMIT_SEC, coversCalls, HOST_TIMEOUTS, timeoutValue } from '../../src/agents/host-timeouts.ts';
import { mcpLaunch } from '../../src/agents/launcher.ts';
import { agentWiringChecks } from '../../src/agents/wiring-check.ts';
import type { Platform } from '../../src/devices/backend.ts';
import { LONGEST_CALL_MS, responseTimeoutMs } from '../../src/driver/client.ts';
import type { EngineRequest } from '../../src/driver/engine.ts';
import { tempDir } from '../support/fakes.ts';
import { recordingInstaller } from '../support/installer.ts';

const OPS: EngineRequest['op'][] = ['ping', 'status', 'stop', 'record', 'look', 'screenshot', 'run'];
const PLATFORMS: Platform[] = ['ios', 'android'];

function project(): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = fs.realpathSync(tempDir('host-timeouts'));
  const dir = path.join(root, 'app');
  fs.mkdirSync(dir);
  spawnSync('git', ['init', '-q', dir]);
  const state = path.join(root, 'state');
  return {
    dir,
    env: { AGENTLANE_STATE_DIR: state, CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function init(dir: string, env: NodeJS.ProcessEnv, agents: string): Promise<void> {
  const out: string[] = [];
  const code = await runAgentCommand('init', ['--agents', agents], {
    env,
    cwd: dir,
    install: recordingInstaller().install,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
  });
  assert.equal(code, 0, out.join(''));
}

function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function server(dir: string, file: string): Record<string, unknown> {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { mcpServers: Record<string, unknown> };
  return doc.mcpServers.agentlane as Record<string, unknown>;
}

function codexTable(dir: string): string {
  const text = fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8');
  const start = text.indexOf('[mcp_servers.agentlane]');
  assert.notEqual(start, -1, text);
  const next = text.indexOf('\n[', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

test('the timeout written for each host outlasts every call agentlane’s client waits on, and each host’s connect default', () => {
  for (const platform of PLATFORMS)
    for (const op of OPS) assert.ok(LONGEST_CALL_MS >= responseTimeoutMs(op, platform), `${op} on ${platform}`);
  assert.ok(CALL_LIMIT_SEC * 1000 > LONGEST_CALL_MS);
  for (const [agent, host] of Object.entries(HOST_TIMEOUTS)) {
    const sec = host.unit === 'ms' ? timeoutValue(host) / 1000 : timeoutValue(host);
    assert.ok(sec * 1000 > LONGEST_CALL_MS, agent);
    assert.ok(sec >= (host.connectSec ?? 0), `${agent} keeps its connect default`);
    assert.ok(coversCalls(host, timeoutValue(host)), agent);
    assert.ok(!coversCalls(host, timeoutValue(host) - 1), agent);
  }
  assert.equal(coversCalls(HOST_TIMEOUTS.claude, undefined), true, 'Claude Code’s own limit is long enough');
  for (const agent of ['codex', 'copilot', 'gemini', 'antigravity'] as const)
    assert.equal(coversCalls(HOST_TIMEOUTS[agent], undefined), false, `${agent}’s own limit is too short`);
  assert.equal(coversCalls(HOST_TIMEOUTS.antigravity, -1), true, 'a negative timeoutSeconds turns Antigravity’s limits off');
  assert.equal(coversCalls(HOST_TIMEOUTS.antigravity, 0), false, 'zero keeps Antigravity’s 180 s');
  assert.equal(coversCalls(HOST_TIMEOUTS.gemini, -1), false);
});

test('a fresh init writes each host’s timeout under its own key and unit, and none for Cursor or Claude Code alone', async () => {
  const { dir, env, cleanup } = project();
  try {
    await init(dir, env, 'codex,cursor,copilot,gemini,antigravity');
    assert.equal(server(dir, '.mcp.json').timeout, CALL_LIMIT_SEC * 1000);
    assert.equal(server(dir, '.gemini/settings.json').timeout, CALL_LIMIT_SEC * 1000);
    assert.equal(server(dir, '.agents/mcp_config.json').timeoutSeconds, CALL_LIMIT_SEC);
    assert.deepEqual(server(dir, '.cursor/mcp.json'), mcpLaunch());
    assert.match(codexTable(dir), new RegExp(`\\ntool_timeout_sec = ${String(CALL_LIMIT_SEC)}\\n`));
  } finally {
    cleanup();
  }
  const alone = project();
  try {
    await init(alone.dir, alone.env, 'claude');
    assert.deepEqual(server(alone.dir, '.mcp.json'), mcpLaunch(), 'Claude Code’s own limit already outlasts every call');
    write(alone.dir, '.mcp.json', JSON.stringify({ mcpServers: { agentlane: { ...mcpLaunch(), timeout: 60_000 } } }));
    assert.match(
      agentWiringChecks(alone.dir, alone.env).find(c => c.name === 'wiring claude')?.detail ?? '',
      /its timeout is 60000;/,
    );
    await init(alone.dir, alone.env, 'claude');
    assert.equal(server(alone.dir, '.mcp.json').timeout, CALL_LIMIT_SEC * 1000, 'a shorter one the user set is raised');
  } finally {
    alone.cleanup();
  }
});

test('init on existing entries keeps the user’s fields and a longer timeout, adds a missing one and raises a short one', async () => {
  const { dir, env, cleanup } = project();
  const ms = CALL_LIMIT_SEC * 1000;
  try {
    write(dir, '.mcp.json', JSON.stringify({ mcpServers: { agentlane: { command: 'npx', env: { LOG: '1' } } } }));
    write(dir, '.gemini/settings.json', JSON.stringify({ mcpServers: { agentlane: { trust: true, timeout: 60_000 } } }));
    write(dir, '.agents/mcp_config.json', JSON.stringify({ mcpServers: { agentlane: { timeoutSeconds: -1, disabled: false } } }));
    write(
      dir,
      '.codex/config.toml',
      '[mcp_servers.agentlane]\ncommand = "npx"\nenabled = true\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n\n[mcp_servers.agentlane.env]\nLOG = "1"\n',
    );
    await init(dir, env, 'codex,copilot,gemini,antigravity');
    const launcher = mcpLaunch();
    assert.deepEqual(server(dir, '.mcp.json'), { ...launcher, env: { LOG: '1' }, timeout: ms });
    assert.deepEqual(server(dir, '.gemini/settings.json'), { trust: true, timeout: ms, ...launcher });
    assert.deepEqual(server(dir, '.agents/mcp_config.json'), { timeoutSeconds: -1, disabled: false, ...launcher });
    assert.match(
      codexTable(dir),
      new RegExp(
        `^\\[mcp_servers\\.agentlane\\]\\ncommand = "sh"\\nenabled = true\\nstartup_timeout_sec = 30\\ntool_timeout_sec = ${String(CALL_LIMIT_SEC)}\\nargs = \\["-c", .*\\]\\n$`,
      ),
    );
    assert.match(fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8'), /\[mcp_servers\.agentlane\.env\]\nLOG = "1"\n$/);

    const longer = { ...server(dir, '.mcp.json'), timeout: ms * 2 };
    write(dir, '.mcp.json', JSON.stringify({ mcpServers: { agentlane: longer } }));
    write(dir, '.agents/mcp_config.json', JSON.stringify({ mcpServers: { agentlane: { ...launcher, timeoutSeconds: 3600 } } }));
    const toml = path.join(dir, '.codex/config.toml');
    fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace(/tool_timeout_sec = \d+/, 'tool_timeout_sec = 7_200.5'));
    await init(dir, env, 'codex,copilot,antigravity');
    assert.deepEqual(server(dir, '.mcp.json'), longer);
    assert.equal(server(dir, '.agents/mcp_config.json').timeoutSeconds, 3600);
    assert.match(codexTable(dir), /\ntool_timeout_sec = 7_200\.5\n/);
  } finally {
    cleanup();
  }
});

test('doctor warns about a missing or short timeout, naming the file, the key and the value, until init sets it', async () => {
  const { dir, env, cleanup } = project();
  const ms = CALL_LIMIT_SEC * 1000;
  try {
    await init(dir, env, 'codex,copilot,gemini,antigravity');
    const fine = agentWiringChecks(dir, env).filter(c => c.name !== 'wiring skills');
    assert.deepEqual(
      fine.map(c => [c.name, c.warning]),
      ['codex', 'copilot', 'gemini', 'antigravity'].map(agent => [`wiring ${agent}`, false]),
    );

    const drop = (file: string, key: string, value?: number) => {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      const entry = doc.mcpServers.agentlane ?? {};
      if (value === undefined) Reflect.deleteProperty(entry, key);
      else entry[key] = value;
      fs.writeFileSync(path.join(dir, file), JSON.stringify(doc));
    };
    drop('.mcp.json', 'timeout');
    drop('.gemini/settings.json', 'timeout', 600_000);
    drop('.agents/mcp_config.json', 'timeoutSeconds', 0);
    const toml = path.join(dir, '.codex/config.toml');
    fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace(/tool_timeout_sec = \d+/, 'tool_timeout_sec = 120'));

    const byName = new Map(agentWiringChecks(dir, env).map(c => [c.name, c]));
    const needs = (key: string, value: number, unit: string) =>
      `agentlane needs ${key} ${String(value)} (${unit}, ${String(CALL_LIMIT_SEC / 60)} min)`;
    const expected: [string, string, string][] = [
      [
        'codex',
        `stale .codex/config.toml (MCP server): its tool_timeout_sec is 120; ${needs('tool_timeout_sec', CALL_LIMIT_SEC, 'seconds')}`,
        'codex',
      ],
      [
        'copilot',
        `stale .mcp.json (MCP server): it has no timeout, so GitHub Copilot stops a call after 30 s; ${needs('timeout', ms, 'milliseconds')}`,
        'copilot',
      ],
      [
        'gemini',
        `stale .gemini/settings.json (MCP server, guard hook, release hook): its timeout is 600000; ${needs('timeout', ms, 'milliseconds')}`,
        'gemini',
      ],
      [
        'antigravity',
        `stale .agents/mcp_config.json (MCP server): it has no timeoutSeconds, so Antigravity stops a call after 3 min; ${needs('timeoutSeconds', CALL_LIMIT_SEC, 'seconds')}`,
        'antigravity',
      ],
    ];
    for (const [agent, detail, fix] of expected) {
      const check = byName.get(`wiring ${agent}`);
      assert.equal(check?.warning, true, agent);
      assert.equal(check.detail, detail);
      assert.equal(check.fix, `node_modules/.bin/agentlane init --agents ${fix}`);
    }

    await init(dir, env, 'codex,copilot,gemini,antigravity');
    assert.ok(agentWiringChecks(dir, env).every(c => !c.warning));
  } finally {
    cleanup();
  }
});
