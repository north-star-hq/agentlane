import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { maestroEnv, RUNNER_STARTUP_MS } from '../../src/driver/maestro-child.ts';
import { RUNNER_EXECUTABLE } from '../../src/driver/runner.ts';
import { SessionFailure, Supervisor, type SupervisorOptions } from '../../src/driver/supervisor.ts';
import { tempDir } from '../support/fakes.ts';
import { writeFakeToolchain, type FakeEvent } from '../support/driver-world.ts';

interface Fixture {
  supervisor: Supervisor;
  spawns: () => FakeEvent[];
}

async function withSupervisor(
  env: Record<string, string>,
  options: Partial<SupervisorOptions>,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = fs.realpathSync(tempDir('supervisor'));
  const log = path.join(root, 'maestro-events.jsonl');
  const toolchain = writeFakeToolchain(root);
  const supervisor = new Supervisor({
    platform: 'ios',
    deviceId: 'SIM-1',
    maestro: toolchain.maestro,
    javaHome: toolchain.javaHome,
    token: 'token',
    workDir: path.join(root, 'work'),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_LOG: log, ...env },
    logFd: 'ignore',
    log: () => undefined,
    rows: () => Promise.resolve([]),
    ...options,
  });
  const spawns = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as FakeEvent)
          .filter(event => event.event === 'spawn')
      : [];
  try {
    await body({ supervisor, spawns });
  } finally {
    await supervisor.stop({ clean: false });
  }
}

const READ = { retry: true };

async function failure(call: Promise<unknown>): Promise<SessionFailure> {
  try {
    await call;
  } catch (error) {
    if (error instanceof SessionFailure) return error;
    throw error;
  }
  assert.fail('the call succeeded');
}

test("Maestro is told the same runner startup time the driver's first call allows for", () => {
  const env = maestroEnv({ javaHome: '/jdk', env: { MAESTRO_DRIVER_STARTUP_TIMEOUT: '5' }, token: 't' }, '/stub', '/tmp');
  assert.equal(env.MAESTRO_DRIVER_STARTUP_TIMEOUT, String(RUNNER_STARTUP_MS));
});

test("an emulator's Maestro keeps its own driver startup time, so the driver doesn't set it", () => {
  const android = { javaHome: '/jdk', token: 't', androidSdk: '/sdk' };
  assert.equal(maestroEnv({ ...android, env: {} }, '/stub', '/tmp').MAESTRO_DRIVER_STARTUP_TIMEOUT, undefined);
  const own = maestroEnv({ ...android, env: { MAESTRO_DRIVER_STARTUP_TIMEOUT: '30000' } }, '/stub', '/tmp');
  assert.equal(own.MAESTRO_DRIVER_STARTUP_TIMEOUT, '30000');
});

test("an emulator's first call gets only its tool's limit, and a timeout on it isn't sent again", () =>
  withSupervisor(
    { FAKE_DELAYS: '[1500]' },
    { platform: 'android', deviceId: 'emulator-5554', timeouts: { inspect_screen: 400 }, runnerStartupMs: 1500 },
    async ({ supervisor, spawns }) => {
      const began = Date.now();
      const error = await failure(supervisor.call('inspect_screen', {}, READ));
      assert.ok(Date.now() - began < 1500, `the first call waited ${String(Date.now() - began)} ms`);
      assert.equal(error.kind, 'timeout');
      assert.equal(error.attempts.length, 1);
      assert.equal(spawns().length, 1);
    },
  ));

test("a first call that gets an error back still leaves the next call the runner's startup time", () =>
  withSupervisor(
    { FAKE_ERROR_ON: '1', FAKE_DELAYS: '[0, 900]' },
    { timeouts: { inspect_screen: 400 }, runnerStartupMs: 1500 },
    async ({ supervisor, spawns }) => {
      const first = await supervisor.call('inspect_screen', {}, READ);
      assert.equal(first.result.isError, true);
      const second = await supervisor.call('inspect_screen', {}, READ);
      assert.equal(second.result.isError, false);
      assert.equal(second.respawned, false);
      assert.equal(spawns().length, 1);
    },
  ));

test('once the XCTest runner has answered, an error result leaves the next call only its tool limit', () =>
  withSupervisor(
    { FAKE_ERROR_ON: '2', FAKE_DELAYS: '[0, 0, 900]' },
    { timeouts: { inspect_screen: 400 }, runnerStartupMs: 1500 },
    async ({ supervisor }) => {
      assert.equal((await supervisor.call('inspect_screen', {}, READ)).result.isError, false);
      assert.equal((await supervisor.call('inspect_screen', {}, READ)).result.isError, true);
      const third = await failure(supervisor.call('inspect_screen', {}, READ));
      assert.equal(third.kind, 'timeout');
      assert.equal(third.attempts.length, 1);
    },
  ));

test('a first call that gets an error back once its XCTest runner is known leaves the next call only its tool limit', async () => {
  const runner = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const pid = runner.pid ?? assert.fail('sleep did not start');
  const row = {
    pid,
    ppid: 1,
    pgid: pid,
    rssKb: 1,
    command: `/fake/Library/Developer/CoreSimulator/Devices/SIM-1/data/Containers/Bundle/Application/F/${RUNNER_EXECUTABLE}.app/${RUNNER_EXECUTABLE}`,
  };
  try {
    await withSupervisor(
      { FAKE_ERROR_ON: '1', FAKE_DELAYS: '[0, 900]' },
      { timeouts: { inspect_screen: 400 }, runnerStartupMs: 1500, rows: () => Promise.resolve([row]) },
      async ({ supervisor }) => {
        assert.equal((await supervisor.call('inspect_screen', {}, READ)).result.isError, true);
        const second = await failure(supervisor.call('inspect_screen', {}, READ));
        assert.equal(second.kind, 'timeout');
        assert.equal(second.attempts.length, 1);
      },
    );
  } finally {
    runner.kill('SIGKILL');
  }
});

test("the first call on a fresh Maestro gets the runner's startup time, and the next call only its tool's limit", () =>
  withSupervisor(
    { FAKE_DELAYS: '[900, 900]' },
    { timeouts: { inspect_screen: 400 }, runnerStartupMs: 1500 },
    async ({ supervisor, spawns }) => {
      const first = await supervisor.call('inspect_screen', {}, READ);
      assert.equal(first.result.isError, false);
      assert.equal(first.respawned, false);
      const began = Date.now();
      const second = await failure(supervisor.call('inspect_screen', {}, READ));
      assert.ok(Date.now() - began < 1200, `the second call waited ${String(Date.now() - began)} ms`);
      assert.equal(second.kind, 'timeout');
      assert.equal(second.attempts.length, 1);
      assert.equal(spawns().length, 1);
    },
  ));

test('a first call that times out restarts Maestro and is answered by the fresh one', () =>
  withSupervisor(
    { FAKE_HANG_TOOL: 'take_screenshot' },
    { timeouts: { take_screenshot: 300 }, runnerStartupMs: 300 },
    async ({ supervisor, spawns }) => {
      const { result, respawned } = await supervisor.call('take_screenshot', {}, READ);
      assert.equal(result.isError, false);
      assert.equal(result.content[0]?.type, 'image');
      assert.equal(respawned, true);
      assert.equal(spawns().length, 2);
    },
  ));

test('a first call that times out on two fresh Maestros fails as a timeout with both attempts', () =>
  withSupervisor(
    { FAKE_DELAYS: '[5000]' },
    { timeouts: { inspect_screen: 200 }, runnerStartupMs: 200 },
    async ({ supervisor, spawns }) => {
      const error = await failure(supervisor.call('inspect_screen', {}, READ));
      assert.equal(error.kind, 'timeout');
      assert.equal(error.attempts.length, 2);
      for (const attempt of error.attempts) assert.match(attempt, /^Maestro didn't answer tools\/call within/);
      assert.equal(spawns().length, 2);
    },
  ));

test('a flow whose first call times out is not sent again', () =>
  withSupervisor({ FAKE_DELAYS: '[5000]' }, { timeouts: { run: 200 }, runnerStartupMs: 200 }, async ({ supervisor, spawns }) => {
    const error = await failure(supervisor.call('run', { yaml: '- back\n' }, { retry: false }));
    assert.equal(error.kind, 'timeout');
    assert.equal(error.attempts.length, 1);
    assert.equal(spawns().length, 1);
  }));

test("Maestro's own runner startup timeout on a first call is retried once on a fresh Maestro", async () => {
  await withSupervisor({ FAKE_NOT_READY_TIMES: '1' }, {}, async ({ supervisor, spawns }) => {
    const { result, respawned } = await supervisor.call('inspect_screen', {}, READ);
    assert.equal(result.isError, false);
    assert.equal(respawned, true);
    assert.equal(spawns().length, 2);
  });
  await withSupervisor({ FAKE_NOT_READY_TIMES: '2' }, {}, async ({ supervisor, spawns }) => {
    const error = await failure(supervisor.call('inspect_screen', {}, READ));
    assert.equal(error.kind, 'timeout');
    assert.equal(error.attempts.length, 2);
    for (const attempt of error.attempts) assert.match(attempt, /iOS driver not ready in time/);
    assert.equal(spawns().length, 2);
  });
});

test("Maestro's advice to raise its startup timeout, which the driver sets itself, is replaced by advice that works", () =>
  withSupervisor({ FAKE_NOT_READY_TIMES: '2' }, {}, async ({ supervisor }) => {
    const error = await failure(supervisor.call('inspect_screen', {}, READ));
    assert.doesNotMatch(error.detail, /MAESTRO_DRIVER_STARTUP_TIMEOUT|consider increasing/);
    for (const attempt of error.attempts)
      assert.equal(
        attempt,
        `Failed to inspect screen: iOS driver not ready in time (the XCTest runner didn't answer within ${String(RUNNER_STARTUP_MS / 1000)} s)`,
      );
    assert.match(error.detail, /\. The next call starts a fresh Maestro and XCTest runner$/);
  }));
