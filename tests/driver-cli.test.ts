import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { TOOLS } from '../src/mcp/tools.ts';
import { driverWorld, type DriverWorld } from './support/driver-world.ts';
import { tempDir } from './support/fakes.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');

interface Reply {
  id: number;
  result?: { content?: { type: string; text?: string; data?: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: unknown;
}

class McpClient {
  private readonly child: ChildProcess;
  private nextId = 0;
  private readonly waiting = new Map<number, (reply: Reply) => void>();

  constructor(env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(process.execPath, [CLI, 'mcp'], { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    if (!this.child.stdout) throw new Error('no stdout');
    createInterface({ input: this.child.stdout }).on('line', line => {
      const reply = JSON.parse(line) as Reply;
      this.waiting.get(reply.id)?.(reply);
      this.waiting.delete(reply.id);
    });
  }

  request(method: string, params: object = {}): Promise<Reply> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no answer to ${method}`));
      }, 30_000);
      this.waiting.set(id, reply => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(name: string, args: object = {}) {
    const reply = await this.request('tools/call', { name, arguments: args });
    const content = reply.result?.content ?? [];
    return {
      isError: reply.result?.isError === true,
      text: content
        .filter(item => item.type === 'text')
        .map(item => item.text ?? '')
        .join('\n'),
      images: content.filter(item => item.type === 'image'),
    };
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      this.child.once('exit', () => {
        resolve();
      });
      this.child.stdin?.end();
    });
  }
}

function cliEnv(world: DriverWorld): NodeJS.ProcessEnv {
  return {
    ...world.env,
    AGENTLANE_STATE_DIR: world.stateDir,
    AGENTLANE_OWNER_PID: String(world.owner.pid),
    AGENTLANE_MAESTRO: world.toolchain.maestro,
    JAVA_HOME: world.toolchain.javaHome,
  };
}

function cli(world: DriverWorld, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: cliEnv(world),
    cwd: world.worktree,
    encoding: 'utf8',
    input,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the MCP server lists exactly look, run and screenshot', async () => {
  const client = new McpClient(
    { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: path.join(tempDir('mcp'), 'state') },
    process.cwd(),
  );
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal((init.result as { protocolVersion?: string } | undefined)?.protocolVersion, '2025-06-18');
    const list = await client.request('tools/list');
    assert.deepEqual(
      list.result?.tools?.map(tool => tool.name),
      ['look', 'run', 'screenshot'],
    );
    assert.deepEqual(
      TOOLS.map(tool => tool.name),
      ['look', 'run', 'screenshot'],
    );
  } finally {
    await client.close();
  }
});

test('a tool call with no lane answers with the claim command', async () => {
  const state = path.join(tempDir('mcp-none'), 'state');
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const client = new McpClient(
    { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: state, AGENTLANE_OWNER_PID: String(owner.pid) },
    tempDir('mcp-folder'),
  );
  try {
    for (const name of ['look', 'run', 'screenshot']) {
      const result = await client.call(name, name === 'run' ? { yaml: '- back' } : {});
      assert.equal(result.isError, true);
      assert.match(result.text, /holds no lane/);
      assert.match(result.text, /agentlane claim --boot/);
    }
    assert.equal(fs.existsSync(state), false, 'a call with no lane creates no registry');
  } finally {
    await client.close();
    owner.kill('SIGKILL');
  }
});

test("the MCP tools drive the caller's claimed simulator: look, run with a diff, and screenshot", async () => {
  const world = await driverWorld({ taps: { 'com.apple.settings.general': 'settings-general' } });
  const client = new McpClient(cliEnv(world), world.worktree);
  try {
    const looked = await client.call('look', { interactiveOnly: true });
    assert.equal(looked.isError, false, looked.text);
    assert.match(looked.text, /id=com\.apple\.settings\.general/);
    const ran = await client.call('run', {
      yaml: '- tapOn:\n    id: com.apple.settings.general\n',
      appId: 'com.apple.Preferences',
    });
    assert.equal(ran.isError, false, ran.text);
    assert.match(ran.text, /^Passed 1 step in [\d.]+ s\.\nScreen changed:/);
    const shot = await client.call('screenshot');
    assert.equal(shot.isError, false, shot.text);
    assert.equal(shot.images.length, 1);
    const bad = await client.call('screenshot', { scale: 2 });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /scale must be above 0 and at most 1/);
    const device = await client.call('look', { device_id: '06F68A96-4A55-41A4-B4F7-651DB85173BB' });
    assert.equal(device.isError, true);
    assert.match(device.text, /look takes interactiveOnly, within, depth, bounds, browser, not device_id/);
    assert.ok(
      world
        .events()
        .filter(e => e.event === 'call')
        .every(e => (e.args as { device_id: string }).device_id === world.lane.device?.id),
    );
  } finally {
    await client.close();
    await world.close();
  }
});

test('the CLI drives the lane too: look, run with --yaml, a failing run, record save, and driver status and stop', async () => {
  const world = await driverWorld({ taps: { 'com.apple.settings.general': 'settings-general' } });
  try {
    const looked = cli(world, ['look', '--interactive']);
    assert.equal(looked.code, 0, looked.stderr);
    assert.match(looked.stdout, /id=com\.apple\.settings\.general "General"/);
    const ran = cli(world, [
      'run',
      '--app-id',
      'com.apple.Preferences',
      '--yaml',
      '- tapOn:\n    id: com.apple.settings.general\n',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /Screen changed/);
    const failed = cli(world, ['run', '-'], '- tapOn:\n    id: missing-thing\n');
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /^Run failed \(selector-miss\) at step 1 of 1/);
    const file = path.join(world.root, 'flows', 'probe.yaml');
    const saved = cli(world, ['record', 'save', file]);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      'appId: com.apple.Preferences\n---\n- tapOn:\n    id: com.apple.settings.general\n',
    );
    const status = cli(world, ['driver', 'status']);
    assert.match(status.stdout, /^Driver for lane \w+ on [\w-]+: engine pid \d+/);
    assert.equal(cli(world, ['driver', 'stop']).code, 0);
    assert.match(cli(world, ['driver', 'status']).stdout, /^No driver runs for lane/);
  } finally {
    await world.close();
  }
});

test('the CLI refuses a caller with no lane with the claim command, and bad usage with exit 2', async () => {
  const world = await driverWorld();
  try {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const result = spawnSync(process.execPath, [CLI, 'look'], {
      env: { ...cliEnv(world), AGENTLANE_OWNER_PID: String(other.pid) },
      cwd: world.worktree,
      encoding: 'utf8',
    });
    other.kill('SIGKILL');
    assert.equal(result.status, 3);
    assert.match(result.stderr, /holds no lane in .*\nto recover: node_modules\/\.bin\/agentlane claim --boot/);
    assert.equal(cli(world, ['run']).code, 2);
    assert.equal(cli(world, ['screenshot', '--scale', '3']).code, 2);
    assert.equal(cli(world, ['record', 'save']).code, 2);
  } finally {
    await world.close();
  }
});
