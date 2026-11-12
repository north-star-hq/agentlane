import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runDriverCommand, type DriverCliDeps } from '../src/driver-cli.ts';
import { callEngine } from '../src/driver/client.ts';
import { createToolHandler, type ToolResult } from '../src/mcp/tools.ts';
import { identityOf, systemProcesses, type ProcessIdentity } from '../src/processes.ts';
import { configPath, databasePath } from '../src/registry/paths.ts';
import { LaneToucher, laneLastCall, recordCall, TOUCH_WAIT_MS } from '../src/registry/touch.ts';
import type { Lane, LaneRef } from '../src/registry/types.ts';
import { runRegistryCommand } from '../src/registry-cli.ts';
import { realServiceSystem } from '../src/services/system.ts';
import type { EnvDeps } from '../src/up/deps.ts';
import { up } from '../src/up/up.ts';
import { runUpCommand } from '../src/up-cli.ts';
import { FakeAdb } from './devices/fake-adb.ts';
import { FakeClock, FakeProbe, tempDir } from './support/fakes.ts';
import { driverWorld, sleeper, until, type DriverWorld } from './support/driver-world.ts';
import { CONFIG, failures, OPTIONS, toolchain, world, type World } from './support/up-world.ts';
import { openRegistryReadOnly } from './support/registry-read.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'signin-site');
const AGED = 1_000_000;

function homeless(root: string): Record<string, string> {
  const at = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    HOME: at('home'),
    XDG_STATE_HOME: at('xdg-state'),
    XDG_DATA_HOME: at('xdg-data'),
    XDG_CONFIG_HOME: at('xdg-config'),
    CLAUDE_CONFIG_DIR: at('claude-config'),
    CODEX_HOME: at('codex'),
  };
}

function webEnv(w: World): NodeJS.ProcessEnv {
  const env = w.deps().env;
  return { ...env, ...homeless(w.root), AGENTLANE_STATE_DIR: w.state };
}

interface LastUse {
  at: number;
  action: string;
}

function lastUse(state: string, id: string): LastUse {
  const db = openRegistryReadOnly(state);
  try {
    const row = db.prepare('SELECT last_used_at AS at, last_action AS action FROM claims WHERE id = ?').get(id);
    assert.ok(row, `lane ${id} has no row`);
    return { at: Number(row.at), action: String(row.action) };
  } finally {
    db.close();
  }
}

function age(state: string, id: string): void {
  const db = new DatabaseSync(databasePath(state), { timeout: 5000 });
  try {
    db.prepare("UPDATE claims SET last_used_at = ?, last_action = 'aged' WHERE id = ?").run(AGED, id);
  } finally {
    db.close();
  }
}

/** Takes the registry's write lock, as a claim creating a device does, until the returned function is called. */
function holdRegistry(state: string): () => void {
  const db = new DatabaseSync(databasePath(state), { timeout: 5000 });
  db.exec('BEGIN IMMEDIATE');
  return () => {
    db.exec('COMMIT');
    db.close();
  };
}

/** Makes the registry's config.json invalid, so opening the registry fails, until the returned function is called. */
function breakConfig(state: string): () => void {
  const file = configPath(state);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  fs.writeFileSync(file, '{');
  return () => {
    if (before === undefined) fs.rmSync(file);
    else fs.writeFileSync(file, before);
  };
}

async function counts(state: string, lane: LaneRef, action: string, call: () => Promise<unknown>): Promise<void> {
  age(state, lane.id);
  const before = Date.now();
  await call();
  await until(
    () => {
      const now = lastUse(state, lane.id);
      return now.at >= before && now.action === action;
    },
    5000,
    `'${action}' to move lane ${lane.id}'s last use (it is ${JSON.stringify(lastUse(state, lane.id))})`,
  );
  await touchesLanded(state, lane);
}

/** Waits until the registry holds a touch at least as late as the last call the lane's folder records. */
async function touchesLanded(state: string, lane: LaneRef): Promise<void> {
  const called = laneLastCall(state, { ...lane, lastUsedAt: 0 });
  await until(
    () => lastUse(state, lane.id).at >= called,
    5000,
    `a touch of the call at ${String(called)} (the registry has ${JSON.stringify(lastUse(state, lane.id))})`,
  );
}

function leavesAlone(state: string, id: string): void {
  assert.deepEqual(lastUse(state, id), { at: AGED, action: 'aged' });
}

interface Cli {
  deps: DriverCliDeps;
  drive(command: string, ...args: string[]): Promise<{ code: number; out: string; err: string }>;
}

function cli(env: NodeJS.ProcessEnv, cwd: string, over: Partial<DriverCliDeps> = {}): Cli {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DriverCliDeps = {
    env,
    cwd,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    stdin: new PassThrough(),
    output: new PassThrough(),
    processes: systemProcesses,
    ...over,
  };
  return {
    deps,
    async drive(command, ...args) {
      out.length = 0;
      err.length = 0;
      const code = await runDriverCommand(command, args, deps);
      return { code, out: out.join(''), err: err.join('') };
    },
  };
}

function ok(result: ToolResult): ToolResult {
  assert.notEqual(result.isError, true, result.content.map(c => (c.type === 'text' ? c.text : c.type)).join('\n'));
  return result;
}

async function webLane(w: World) {
  for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(FIXTURE, file), path.join(w.project, file));
  w.write({
    web: { service: 'site' },
    services: { site: { type: 'web', start: 'exec node site.ts', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 10 } },
    hooks: { signin: 'node signin.ts' },
  });
  const result = await up(w.deps({ env: webEnv(w) }), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  return result.lane;
}

async function withDevice(
  platform: 'ios' | 'android',
  body: (w: DriverWorld, c: Cli) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const home = tempDir('last-used-home');
  const w = await driverWorld({ platform, env: { ...homeless(home), ...env } });
  try {
    assert.equal((await callEngine(w.target(), { op: 'look', args: {} })).ok, true, 'the engine did not start');
    await touchesLanded(w.stateDir, w.lane);
    assert.equal(lastUse(w.stateDir, w.lane.id).action, 'look');
    const env = { ...w.env, AGENTLANE_STATE_DIR: w.stateDir, AGENTLANE_OWNER_PID: String(w.owner.pid) };
    const adb = new FakeAdb(w.lane.device?.serial ?? '');
    await body(w, cli(env, w.worktree, { adb: () => adb }));
  } finally {
    await w.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('every call on a browser lane moves its last use: the CLI, the MCP tools, exec, doctor, touch and up', async t => {
  const w = world(t);
  const lane = await webLane(w);
  const c = cli(webEnv(w), w.project, { browser: w.browser });
  const moves = (action: string, call: () => Promise<unknown>) => counts(w.state, lane, action, call);
  const exits0 = async (run: Promise<{ code: number; err: string }>) => {
    const { code, err } = await run;
    assert.equal(code, 0, err);
  };

  await moves('look: browser', () => exits0(c.drive('look')));
  await moves('screenshot: browser', () => exits0(c.drive('screenshot')));
  await moves('evidence screenshot', () => exits0(c.drive('evidence', 'screenshot')));
  await moves('evidence logs', () => exits0(c.drive('evidence', 'logs')));

  const mcp = createToolHandler({ env: c.deps.env, cwd: w.project, processes: systemProcesses, browser: w.browser });
  await moves('look: browser', async () => ok(await mcp('look', {})));
  await moves('screenshot: browser', async () => ok(await mcp('screenshot', {})));
  await moves('look: browser', async () => ok(await mcp('look', { browser: true })));

  const stdout: string[] = [];
  await moves('exec: true', async () => {
    assert.equal(await runUpCommand('exec', ['--', 'true'], w.deps({ env: webEnv(w) }), text => stdout.push(text)), 0);
  });
  await moves('doctor', async () => {
    assert.equal(await runUpCommand('doctor', [], w.deps({ env: webEnv(w) }), text => stdout.push(text)), 0, stdout.join(''));
  });
  await moves('ran by hand', async () => {
    assert.equal(await runRegistryCommand('touch', ['--action', 'ran by hand'], registryDeps(w)), 0);
  });
  age(w.state, lane.id);
  const again = await up(w.deps({ env: webEnv(w) }), OPTIONS);
  assert.equal(again.lane.id, lane.id);
  const after = lastUse(w.state, lane.id);
  assert.ok(after.at > AGED && after.action.startsWith('up'), JSON.stringify(after));
});

function registryDeps(w: World) {
  const deps = w.deps();
  return {
    env: webEnv(w),
    cwd: deps.cwd,
    stdout: () => undefined,
    stderr: () => undefined,
    processes: deps.processes,
    ports: deps.ports,
    devices: deps.devices,
  };
}

test('status, lanes --json and evidence list leave the last use alone', async t => {
  const w = world(t);
  const lane = await webLane(w);
  const c = cli(webEnv(w), w.project, { browser: w.browser });
  age(w.state, lane.id);
  assert.equal(await runRegistryCommand('status', [], registryDeps(w)), 0);
  assert.equal(await runRegistryCommand('lanes', ['--json'], registryDeps(w)), 0);
  assert.equal(await runRegistryCommand('lanes', [], registryDeps(w)), 2);
  assert.equal((await c.drive('evidence', 'list')).code, 0);
  assert.equal((await c.drive('evidence')).code, 0);
  leavesAlone(w.state, lane.id);
});

test('every call on a simulator lane moves its last use: look, run, screenshot, record, evidence and the driver, from the CLI and MCP', () =>
  withDevice('ios', async (w, c) => {
    const moves = (action: string, call: () => Promise<unknown>) => counts(w.stateDir, w.lane, action, call);
    const exits0 = async (run: Promise<{ code: number; err: string }>) => {
      const { code, err } = await run;
      assert.equal(code, 0, err);
    };

    await moves('look', () => exits0(c.drive('look')));
    await moves('screenshot', () => exits0(c.drive('screenshot', '--out', path.join(w.root, 'shot.jpg'))));
    await moves('run', () => exits0(c.drive('run', '--yaml', '- assertVisible: General\n', '--app-id', 'com.apple.Preferences')));
    await moves('record', () => exits0(c.drive('record', 'show')));
    await moves('look', () => exits0(c.drive('driver', 'start')));

    const mcp = createToolHandler({ env: c.deps.env, cwd: w.worktree, processes: systemProcesses });
    await moves('look', async () => ok(await mcp('look', {})));
    await moves('screenshot', async () => ok(await mcp('screenshot', {})));
    await moves('run', async () => ok(await mcp('run', { yaml: '- assertVisible: General\n', appId: 'com.apple.Preferences' })));

    age(w.stateDir, w.lane.id);
    assert.equal((await c.drive('driver', 'status')).code, 0);
    await new Promise(resolve => setTimeout(resolve, 600));
    leavesAlone(w.stateDir, w.lane.id);

    age(w.stateDir, w.lane.id);
    await exits0(c.drive('evidence', 'screenshot'));
    await until(() => lastUse(w.stateDir, w.lane.id).at > AGED, 5000, 'evidence screenshot to move the last use');

    await moves('driver stop', () => exits0(c.drive('driver', 'stop')));
  }));

test("a device control on an emulator lane moves the lane's last use", () =>
  withDevice('android', async (w, c) => {
    await counts(w.stateDir, w.lane, 'device appearance', async () => {
      const { code, err } = await c.drive('device', 'appearance', 'dark');
      assert.equal(code, 0, err);
    });
  }));

test('a busy registry neither fails nor stalls a browser lane call; MCP lands the touch once the registry frees, the CLI on its next call', async t => {
  const w = world(t);
  const lane = await webLane(w);
  const c = cli(webEnv(w), w.project, { browser: w.browser });
  const mcp = createToolHandler({
    env: c.deps.env,
    cwd: w.project,
    processes: systemProcesses,
    browser: w.browser,
    touchRetryMs: 50,
  });

  age(w.state, lane.id);
  let free = holdRegistry(w.state);
  let started = Date.now();
  const looked = await c.drive('look');
  const tookMs = Date.now() - started;
  assert.equal(looked.code, 0, looked.err);
  assert.match(looked.out, /Signed in as/);
  assert.ok(tookMs < 5000, `the look waited ${String(tookMs)} ms on the registry`);
  free();
  leavesAlone(w.state, lane.id);
  await counts(w.state, lane, 'look: browser', async () => {
    assert.equal((await c.drive('look')).code, 0);
  });

  age(w.state, lane.id);
  free = holdRegistry(w.state);
  started = Date.now();
  ok(await mcp('look', {}));
  assert.ok(Date.now() - started < 5000);
  await new Promise(resolve => setTimeout(resolve, 200));
  leavesAlone(w.state, lane.id);
  free();
  await until(() => lastUse(w.state, lane.id).action === 'look: browser', 5000, 'the retried MCP touch');
});

test('a busy registry neither fails nor stalls a device lane call, and the engine lands the touch once it frees', () =>
  withDevice('ios', async (w, c) => {
    age(w.stateDir, w.lane.id);
    const free = holdRegistry(w.stateDir);
    try {
      const started = Date.now();
      const looked = await c.drive('look');
      assert.equal(looked.code, 0, looked.err);
      assert.ok(Date.now() - started < 5000);
      await new Promise(resolve => setTimeout(resolve, 300));
      leavesAlone(w.stateDir, w.lane.id);
    } finally {
      free();
    }
    await until(() => lastUse(w.stateDir, w.lane.id).action === 'look', 5000, "the engine's retried touch");
  }));

test("a touch that can't open the registry leaves the warm engine running, and lands once the registry opens", () =>
  withDevice('ios', async w => {
    const warm = await callEngine(w.target(), { op: 'look', args: {} });
    assert.equal(warm.ok, true);
    await touchesLanded(w.stateDir, w.lane);
    age(w.stateDir, w.lane.id);
    const fix = breakConfig(w.stateDir);
    try {
      const looked = await callEngine(w.target(), { op: 'look', args: {} });
      assert.equal(looked.ok, true);
      await new Promise(resolve => setTimeout(resolve, 500));
      leavesAlone(w.stateDir, w.lane.id);
    } finally {
      fix();
    }
    await until(() => lastUse(w.stateDir, w.lane.id).action === 'look', 5000, 'the touch tried again once the registry opens');
    const after = await callEngine(w.target(), { op: 'look', args: {} });
    assert.equal(after.pid, warm.pid, 'the engine restarted');
  }));

test('the MCP retry outlasts a registry that cannot be opened and lands once it opens', () =>
  withWorld('ios', async w => {
    const ref = { id: w.lane.id, token: w.lane.token };
    const toucher = new LaneToucher({ dir: w.stateDir, processes: systemProcesses }, 20);
    age(w.stateDir, w.lane.id);
    const free = holdRegistry(w.stateDir);
    toucher.touch(ref, 'look: browser');
    const fix = breakConfig(w.stateDir);
    free();
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      leavesAlone(w.stateDir, w.lane.id);
    } finally {
      fix();
    }
    await until(() => lastUse(w.stateDir, w.lane.id).action === 'look: browser', 3000, 'the MCP retry once the registry opens');
  }));

test('a run still in flight has already moved the last use, so a long run never looks idle', () =>
  withDevice(
    'ios',
    async w => {
      age(w.stateDir, w.lane.id);
      let settled = false;
      const running = callEngine(w.target(), {
        op: 'run',
        args: { yaml: '- assertVisible: General\n', appId: 'com.apple.Preferences' },
      }).finally(() => {
        settled = true;
      });
      await until(() => lastUse(w.stateDir, w.lane.id).at > AGED, 1000, 'the run to count before it ends');
      assert.equal(settled, false, 'the run ended before its touch was seen');
      assert.equal(lastUse(w.stateDir, w.lane.id).action, 'run');
      assert.equal((await running).ok, true);
    },
    { FAKE_DELAY_MS: '1500' },
  ));

const PARK_WINDOW_MS = 30 * 60_000;

interface OtherLane {
  lane: Lane;
  worktree: string;
  env: NodeJS.ProcessEnv;
}

type Another = (name: string) => Promise<OtherLane>;

/** A world with one device lane, and `another` to claim more lanes with no device, each held by its own owner in its own folder. */
async function withWorld(platform: 'ios' | 'android', body: (w: DriverWorld, another: Another) => Promise<void>): Promise<void> {
  const home = tempDir('last-used-home');
  const w = await driverWorld({ platform, env: homeless(home) });
  const owners: ChildProcess[] = [];
  const another: Another = async name => {
    const owner = sleeper();
    owners.push(owner);
    const pid = owner.pid ?? 0;
    let identity: ProcessIdentity | undefined;
    await until(() => (identity = identityOf(systemProcesses, pid)) !== undefined, 5000, 'the other owner');
    assert.ok(identity);
    const worktree = path.join(w.root, name);
    fs.mkdirSync(worktree, { recursive: true });
    const { lane } = await w.registry().claim({
      owner: { kind: 'process', process: identity, sessionId: null, threadId: null },
      worktree,
      projectRoot: worktree,
      services: [],
      device: null,
      waitMs: 0,
    });
    return { lane, worktree, env: { ...w.env, AGENTLANE_STATE_DIR: w.stateDir, AGENTLANE_OWNER_PID: String(pid) } };
  };
  try {
    await body(w, another);
  } finally {
    for (const owner of owners) owner.kill('SIGKILL');
    await w.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function execDeps(lane: OtherLane, over: Partial<EnvDeps> = {}): EnvDeps {
  return {
    env: lane.env,
    cwd: lane.worktree,
    log: () => undefined,
    processes: systemProcesses,
    ports: new FakeProbe(),
    devices: {},
    sim: null,
    system: realServiceSystem,
    toolchain: toolchain(),
    startDriver: () => Promise.resolve(),
    clock: new FakeClock(Date.now()),
    ...over,
  };
}

function onlyLane(state: string): LaneRef | undefined {
  if (!fs.existsSync(databasePath(state))) return undefined;
  const db = openRegistryReadOnly(state);
  try {
    const rows = db.prepare('SELECT id, token FROM claims').all();
    const [row] = rows;
    return rows.length === 1 && row ? { id: String(row.id), token: String(row.token) } : undefined;
  } finally {
    db.close();
  }
}

function lastCallOf(state: string, lane: LaneRef): number {
  return laneLastCall(state, { id: lane.id, token: lane.token, lastUsedAt: lastUse(state, lane.id).at });
}

/** Runs `exec` on a command that runs until `end` is called; `end` waits for exec to return, so the command never outlives the test. */
function execUntilEnded(lane: OtherLane, flag: string, over: Partial<EnvDeps>) {
  let settled = false;
  const running = runUpCommand(
    'exec',
    ['--', 'sh', '-c', 'while [ ! -e "$1" ]; do sleep 0.02; done', 'sh', flag],
    execDeps(lane, over),
    () => undefined,
  ).finally(() => {
    settled = true;
  });
  return {
    running: () => !settled,
    end: (): Promise<number> => {
      fs.writeFileSync(flag, '');
      return running;
    },
  };
}

test('an exec whose command runs past the park window counts as a call within one heartbeat of now while it runs, and stops counting once it exits', () =>
  withWorld('ios', async (w, another) => {
    const b = await another('exec-lane');
    const clock = new FakeClock(Date.now());
    const heartbeatMs = 20;
    const exec = execUntilEnded(b, path.join(w.root, 'exec-may-end'), { clock, heartbeatMs });
    const started = clock.now();
    let code: number;
    try {
      await until(() => lastUse(w.stateDir, b.lane.id).action === 'exec: sh', 5000, "exec's first touch");
      await clock.advance(PARK_WINDOW_MS + 60_000);
      await until(
        () => lastCallOf(w.stateDir, b.lane) >= clock.now() - heartbeatMs,
        5000,
        `a heartbeat while the command runs (last call ${String(clock.now() - lastCallOf(w.stateDir, b.lane))} ms ago)`,
      );
      assert.equal(exec.running(), true, 'the command ended before the heartbeat was seen');
      assert.equal(lastUse(w.stateDir, b.lane.id).at, clock.now(), 'the heartbeat reached the registry too');
      assert.ok(clock.now() - started > PARK_WINDOW_MS);
    } finally {
      code = await exec.end();
    }
    assert.equal(code, 0);
    const ended = lastCallOf(w.stateDir, b.lane);
    await clock.advance(PARK_WINDOW_MS);
    await new Promise(resolve => setTimeout(resolve, heartbeatMs * 10));
    assert.equal(lastCallOf(w.stateDir, b.lane), ended, 'the heartbeat outlived the command');
  }));

test("an exec's heartbeat keeps counting through a beat that can't open the registry", () =>
  withWorld('ios', async (w, another) => {
    const b = await another('exec-lane');
    const clock = new FakeClock(Date.now());
    const exec = execUntilEnded(b, path.join(w.root, 'exec-may-end'), { clock, heartbeatMs: 20 });
    let code: number;
    try {
      await clock.advance(1);
      await until(() => lastUse(w.stateDir, b.lane.id).at === clock.now(), 5000, 'the heartbeat to start');

      const fix = breakConfig(w.stateDir);
      try {
        await clock.advance(60_000);
        await until(
          () => lastCallOf(w.stateDir, b.lane) === clock.now(),
          5000,
          "a beat to record the call in the lane's folder while the registry can't be opened",
        );
        assert.ok(lastUse(w.stateDir, b.lane.id).at < clock.now(), 'the registry opened with an invalid config.json');
      } finally {
        fix();
      }

      await clock.advance(PARK_WINDOW_MS);
      await until(
        () => lastUse(w.stateDir, b.lane.id).at === clock.now(),
        5000,
        `the heartbeat once the registry opens again (last call ${String(clock.now() - lastCallOf(w.stateDir, b.lane))} ms ago)`,
      );
      assert.equal(exec.running(), true, 'the command ended before the heartbeat was seen');
    } finally {
      code = await exec.end();
    }
    assert.equal(code, 0);
  }));

test('an up hook that runs past the park window counts as a call within one heartbeat of now while it runs', async t => {
  const w = world(t);
  const flag = path.join(w.root, 'build-may-end');
  w.write({
    ...CONFIG,
    app: { ...CONFIG.app, launch: 'hook' },
    services: {},
    hooks: {
      ...CONFIG.hooks,
      build: `while [ ! -e '${flag}' ]; do sleep 0.02; done; ${CONFIG.hooks.build}`,
      launch: 'true',
    },
  });
  const clock = new FakeClock(Date.now());
  const heartbeatMs = 20;
  const running = up(w.deps({ env: webEnv(w), clock, heartbeatMs }), OPTIONS);
  let lane: LaneRef | undefined;
  try {
    await until(
      () => (lane = onlyLane(w.state)) !== undefined && lastUse(w.state, lane.id).action === 'up: build',
      10_000,
      "the build hook's first touch",
    );
    assert.ok(lane);
    const building = lane;
    const started = clock.now();
    await clock.advance(PARK_WINDOW_MS + 60_000);
    await until(
      () => lastCallOf(w.state, building) >= clock.now() - heartbeatMs,
      5000,
      `a heartbeat while the build hook runs (last call ${String(clock.now() - lastCallOf(w.state, building))} ms ago)`,
    );
    assert.equal(lastUse(w.state, building.id).at, clock.now(), 'the heartbeat reached the registry too');
    assert.equal(lastUse(w.state, building.id).action, 'up: build');
    assert.ok(clock.now() - started > PARK_WINDOW_MS);
  } finally {
    fs.writeFileSync(flag, '');
    await running.catch(() => undefined);
  }
  assert.equal((await running).lane.id, lane.id);
});

test("a CLI call on a busy registry still counts: its time is in the lane's folder, the last call reads it with nothing replayed, and another lane's call leaves it alone", () =>
  withWorld('android', async (w, another) => {
    const a = w.lane;
    const env = { ...w.env, AGENTLANE_STATE_DIR: w.stateDir, AGENTLANE_OWNER_PID: String(w.owner.pid) };
    const adb = new FakeAdb(a.device?.serial ?? '');
    const c = cli(env, w.worktree, { adb: () => adb });
    const b = await another('other-lane');
    age(w.stateDir, a.id);
    age(w.stateDir, b.lane.id);

    const free = holdRegistry(w.stateDir);
    let called: number;
    let ended: number;
    try {
      called = Date.now();
      const { code, err } = await c.drive('device', 'appearance', 'dark');
      ended = Date.now();
      assert.equal(code, 0, err);
      assert.ok(ended - called < 5000, `the call waited ${String(ended - called)} ms on the registry`);
      leavesAlone(w.stateDir, a.id);
      const last = lastCallOf(w.stateDir, a);
      assert.ok(
        last >= called && last <= ended,
        `the last call is ${String(last)}, not within ${String(called)}..${String(ended)}`,
      );

      const other = Date.now();
      assert.equal(await runUpCommand('exec', ['--', 'true'], execDeps(b, { clock: new FakeClock(other) }), () => undefined), 0);
      assert.equal(lastCallOf(w.stateDir, b.lane), other);
      assert.equal(lastCallOf(w.stateDir, a), last, "the other lane's call moved this lane's last call");
    } finally {
      free();
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    leavesAlone(w.stateDir, a.id);
    const last = lastCallOf(w.stateDir, a);
    assert.ok(last >= called && last <= ended, 'the call was lost once the registry freed');

    recordCall(w.stateDir, { id: a.id, token: 'a later lane given the same id' }, Date.now());
    assert.equal(lastCallOf(w.stateDir, a), AGED, "a record under another lane's token counted");
  }));

test("the MCP server's and the engine's touches on a busy registry don't wait for its lock", async () => {
  await withWorld('ios', async w => {
    const ref = { id: w.lane.id, token: w.lane.token };
    const toucher = new LaneToucher({ dir: w.stateDir, processes: systemProcesses }, 20);
    age(w.stateDir, w.lane.id);
    const free = holdRegistry(w.stateDir);
    let took: number;
    try {
      const started = performance.now();
      toucher.touch(ref, 'look: browser');
      took = performance.now() - started;
      leavesAlone(w.stateDir, w.lane.id);
      assert.ok(lastCallOf(w.stateDir, w.lane) > AGED, 'the call was not recorded');
    } finally {
      free();
    }
    assert.ok(took < TOUCH_WAIT_MS / 2, `the MCP touch held its caller ${took.toFixed(0)} ms on the busy registry`);
    await until(() => lastUse(w.stateDir, w.lane.id).action === 'look: browser', 5000, 'the retried MCP touch');
  });

  await withDevice('ios', async (w, c) => {
    const timeLooks = async (): Promise<number> => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const { code, err } = await c.drive('look');
        times.push(performance.now() - started);
        assert.equal(code, 0, err);
      }
      return times.sort((x, y) => x - y)[2] ?? 0;
    };
    const free = await timeLooks();
    const release = holdRegistry(w.stateDir);
    let busy: number;
    try {
      busy = await timeLooks();
    } finally {
      release();
    }
    assert.ok(
      busy - free < TOUCH_WAIT_MS / 2,
      `a look took ${busy.toFixed(0)} ms on a busy registry and ${free.toFixed(0)} ms on a free one`,
    );
  });
});

test("status, lanes --json and evidence list leave a device lane's last use alone", () =>
  withWorld('ios', async w => {
    const env = { ...w.env, AGENTLANE_STATE_DIR: w.stateDir, AGENTLANE_OWNER_PID: String(w.owner.pid) };
    const deps = {
      env,
      cwd: w.worktree,
      stdout: () => undefined,
      stderr: () => undefined,
      processes: systemProcesses,
      ports: new FakeProbe(),
      devices: { ios: w.devices },
    };
    age(w.stateDir, w.lane.id);
    assert.equal(await runRegistryCommand('status', [], deps), 0);
    assert.equal(await runRegistryCommand('lanes', ['--json'], deps), 0);
    const c = cli(env, w.worktree);
    assert.equal((await c.drive('evidence', 'list')).code, 0);
    leavesAlone(w.stateDir, w.lane.id);
    assert.equal(lastCallOf(w.stateDir, w.lane), AGED);
  }));
