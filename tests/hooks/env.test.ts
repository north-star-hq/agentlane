import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HOOK_LOCALE, hookLocale, laneVariables, hookEnvironment } from '../../src/hooks/env.ts';
import { HookFailed, runHook } from '../../src/hooks/run.ts';
import type { Lane } from '../../src/registry/types.ts';
import { tempDir } from '../support/fakes.ts';

const LANE: Lane = {
  id: '1a2b3c4d',
  token: 'secret-token',
  owner: { kind: 'process', process: { pid: 1, start: 'x' }, sessionId: null, threadId: null },
  ownerKey: 'process:1',
  projectRoot: '/repo',
  worktree: '/repo/wt',
  createdAt: 0,
  lastUsedAt: 0,
  lastAction: 'claim',
  device: {
    platform: 'ios',
    id: 'FC2D4835-7AE5-4CEC-B354-DFE87A10A760',
    name: 'agentlane-pool-abcdef',
    deviceType: 't',
    deviceTypeName: 'iPhone 17',
    runtime: 'r',
    runtimeName: 'iOS 26.5',
    serial: null,
  },
  ports: [
    { service: 'metro', type: 'metro', port: 41100 },
    { service: 'backend', type: 'api', port: 41200 },
    { service: 'admin-web', type: 'web', port: 41300 },
  ],
  processes: [],
  resources: [],
  browser: null,
};

test("the lane's variables name the device, every service port, and a type alias when one service has that type", () => {
  assert.deepEqual(laneVariables(LANE, null, '/state/lanes/1a2b3c4d'), {
    AGENTLANE_LANE: '1a2b3c4d',
    AGENTLANE_LANE_TOKEN: 'secret-token',
    AGENTLANE_WORKTREE: '/repo/wt',
    AGENTLANE_PLATFORM: 'ios',
    AGENTLANE_DEVICE: 'FC2D4835-7AE5-4CEC-B354-DFE87A10A760',
    AGENTLANE_METRO_PORT: '41100',
    AGENTLANE_BACKEND_PORT: '41200',
    AGENTLANE_ADMIN_WEB_PORT: '41300',
    AGENTLANE_API_PORT: '41200',
    AGENTLANE_WEB_PORT: '41300',
    AGENTLANE_LOGS: '/state/lanes/1a2b3c4d',
    AGENTLANE_EVIDENCE: '/state/lanes/1a2b3c4d/evidence',
  });
  const twoApis = { ...LANE, ports: [...LANE.ports, { service: 'search', type: 'api', port: 41201 }] };
  assert.equal(
    laneVariables(twoApis, null, null).AGENTLANE_API_PORT,
    undefined,
    'an alias for two api services would be a guess',
  );
});

test("a hook's environment drops another lane's stale variables, keeps the settings and pins a UTF-8 locale", () => {
  const env = hookEnvironment(
    {
      PATH: '/bin',
      LC_ALL: 'en-US-u-ca-gregory',
      AGENTLANE_API_PORT: '41299',
      AGENTLANE_DEVICE: 'OLD',
      AGENTLANE_STATE_DIR: '/state',
      AGENTLANE_OWNER_PID: '42',
      AGENTLANE_JAVA_HOME: '/jdk',
    },
    { AGENTLANE_DEVICE: 'NEW' },
  );
  assert.deepEqual(env, {
    PATH: '/bin',
    LC_ALL: HOOK_LOCALE,
    LANG: HOOK_LOCALE,
    AGENTLANE_STATE_DIR: '/state',
    AGENTLANE_OWNER_PID: '42',
    AGENTLANE_JAVA_HOME: '/jdk',
    AGENTLANE_DEVICE: 'NEW',
  });
});

test('hooks run in C.UTF-8 on Linux, which glibc always has, and in en_US.UTF-8 on macOS, which has no C.UTF-8', () => {
  assert.equal(hookLocale('linux'), 'C.UTF-8');
  assert.equal(hookLocale('darwin'), 'en_US.UTF-8');
});

test('a hook runs in its folder with its environment, logs its output, and a failure carries the log tail', async t => {
  const dir = tempDir('hooks');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const log = path.join(dir, 'logs', 'build.log');
  const env = hookEnvironment({ PATH: process.env.PATH }, { AGENTLANE_DEVICE: 'UDID' });
  const ok = await runHook('build', 'echo "building for $AGENTLANE_DEVICE in $(pwd) with $LC_ALL"', { cwd: dir, env, log });
  assert.equal(ok.code, 0);
  assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`building for UDID in ${fs.realpathSync(dir)} with ${HOOK_LOCALE}`));
  await assert.rejects(
    runHook('build', 'echo "pod install failed"; exit 7', { cwd: dir, env, log }),
    (error: unknown) =>
      error instanceof HookFailed &&
      error.run.code === 7 &&
      error.message.includes('| pod install failed') &&
      error.message.includes(log),
  );
});
