import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { toolVersion } from '../../src/agents/package.ts';
import { tempDir } from '../support/fakes.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugin');
const CLI = path.join(ROOT, 'src', 'cli.ts');

function project(withToolkit: string | null): string {
  const dir = fs.realpathSync(tempDir('plugin-project'));
  if (withToolkit !== null) {
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    const shim = path.join(dir, 'node_modules', '.bin', 'agentlane');
    fs.writeFileSync(shim, `#!/bin/sh\n${withToolkit}\n`);
    fs.chmodSync(shim, 0o755);
  }
  return dir;
}

const realToolkit = `exec "${process.execPath}" "${CLI}" "$@"`;

function env(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_PROJECT_DIR: dir,
    AGENTLANE_STATE_DIR: path.join(dir, '.state'),
    ...extra,
  };
}

async function mcpSession(
  dir: string,
): Promise<{ init: Record<string, unknown>; tools: string[]; call: Record<string, unknown> }> {
  const child = spawn(path.join(PLUGIN, 'scripts', 'mcp.sh'), [], { cwd: dir, env: env(dir), stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map<number, Record<string, unknown>>();
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
    if (typeof message.id !== 'number') return;
    const result = message.result ?? {};
    replies.set(message.id, result);
    waiting.get(message.id)?.(result);
  });
  const ask = (id: number, method: string, params: object): Promise<Record<string, unknown>> => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise(resolve => {
      const known = replies.get(id);
      if (known) resolve(known);
      else waiting.set(id, resolve);
    });
  };
  try {
    const init = await ask(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = (await ask(2, 'tools/list', {})) as { tools: { name: string }[] };
    const call = await ask(3, 'tools/call', { name: 'look', arguments: {} });
    return { init, tools: list.tools.map(t => t.name).sort(), call };
  } finally {
    child.kill('SIGTERM');
  }
}

test('the MCP launcher starts the project’s own toolkit server', async () => {
  const dir = project(realToolkit);
  try {
    const session = await mcpSession(dir);
    assert.deepEqual(session.tools, ['look', 'run', 'screenshot']);
    assert.deepEqual((session.init.serverInfo as { name: string }).name, 'agentlane');
    assert.equal(session.call.isError, true);
    assert.match(JSON.stringify(session.call), /agentlane claim --boot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the toolkit installed the MCP server still starts, and every tool names the fix', async () => {
  const dir = project(null);
  try {
    const session = await mcpSession(dir);
    assert.deepEqual(session.tools, ['look', 'run', 'screenshot']);
    assert.match(String(session.init.instructions), /doesn't have the toolkit installed/);
    assert.equal(session.call.isError, true);
    const text = JSON.stringify(session.call);
    assert.ok(text.includes(`no node_modules/.bin/agentlane in ${dir}`), text);
    assert.match(text, /pnpm add -D agentlane/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function hook(dir: string, event: string, input: object, extra: NodeJS.ProcessEnv = {}) {
  const started = Date.now();
  const result = spawnSync(path.join(PLUGIN, 'scripts', 'hook.sh'), [event], {
    cwd: dir,
    env: env(dir, extra),
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return { ...result, ms: Date.now() - started };
}

test('the hook script skips commands that name no device or browser driver without starting the toolkit', () => {
  const marker = project(null);
  const dir = project(`touch "${marker}/ran"; exit 0`);
  const ran = path.join(marker, 'ran');
  try {
    const result = hook(dir, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git status && pnpm test' } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(ran), false);
    for (const command of [
      'xcrun simctl list',
      'playwright-cli -s=agentlane-1a2b3c4d snapshot',
      'npx @playwright/cli@latest kill-all',
      'agent-browser --session agentlane-1a2b3c4d open http://127.0.0.1:41300/',
    ]) {
      fs.rmSync(ran, { force: true });
      const driver = hook(dir, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command } });
      assert.equal(driver.status, 0);
      assert.equal(fs.existsSync(ran), true, `${command} never reached the toolkit's guard`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(marker, { recursive: true, force: true });
  }
});

test('the hook script never blocks by accident: no toolkit passes, and a toolkit failure is a non-blocking error', () => {
  const none = project(null);
  const broken = project("echo \"agentlane: 'hook' isn't built yet.\" >&2; exit 2");
  try {
    const input = { tool_name: 'Bash', tool_input: { command: 'adb install app.apk' } };
    const passed = hook(none, 'pre-tool-use', input);
    assert.equal(passed.status, 0);
    assert.equal(passed.stdout, '');
    const failed = hook(broken, 'pre-tool-use', input);
    assert.equal(failed.status, 1, 'exit 2 would block the tool call');
    assert.match(failed.stderr, /isn't built yet/);
  } finally {
    fs.rmSync(none, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test('the hook script passes the hook input to the toolkit and its decision back', () => {
  const dir = project(realToolkit);
  try {
    const result = hook(
      dir,
      'pre-tool-use',
      { tool_name: 'Bash', tool_input: { command: 'adb kill-server' }, cwd: dir },
      { AGENTLANE_OWNER_PID: String(process.pid) },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'no lanes: nothing to deny');
    const end = hook(
      dir,
      'session-end',
      { hook_event_name: 'SessionEnd', reason: 'other' },
      { AGENTLANE_OWNER_PID: String(process.pid) },
    );
    assert.equal(end.status, 0, end.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agentlane on the Bash PATH runs the project’s toolkit from any subfolder, and names the fix without one', () => {
  const dir = project(realToolkit);
  const none = project(null);
  try {
    const sub = path.join(dir, 'apps', 'mobile');
    fs.mkdirSync(sub, { recursive: true });
    const bin = path.join(PLUGIN, 'bin', 'agentlane');
    const ok = spawnSync(bin, ['--version'], { cwd: sub, env: env(dir), encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, `${toolVersion()}\n`);
    const missing = spawnSync(bin, ['status'], { cwd: none, env: env(none), encoding: 'utf8' });
    assert.equal(missing.status, 127);
    assert.match(missing.stderr, /doesn't have the toolkit installed/);
    assert.match(missing.stderr, /to fix: add it as a dev dependency/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(none, { recursive: true, force: true });
  }
});
