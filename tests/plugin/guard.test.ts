import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Platform } from '../../src/devices/backend.ts';
import type { GuardContext } from '../../src/plugin/guard.ts';
import { guard } from '../../src/plugin/guard.ts';
import type { OwnerState } from '../../src/registry/owner.ts';
import type { LaneStatus, DeviceState } from '../../src/registry/types.ts';
import { tempDir } from '../support/fakes.ts';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const OTHER_UDID = 'A1B2C3D4-0000-4000-8000-00000000000A';
const MINE_UDID = 'B1B2C3D4-0000-4000-8000-00000000000B';
const SIBLING_UDID = 'C1B2C3D4-0000-4000-8000-00000000000C';
const DEAD_UDID = 'D1B2C3D4-0000-4000-8000-00000000000D';
const FREE_UDID = 'E1B2C3D4-0000-4000-8000-00000000000E';
const SELF = 'claude:100:Sun Oct 11 10:00:00 2026';
const OTHER = 'claude:200:Sun Oct 11 09:00:00 2026';

function lane(
  id: string,
  ownerKey: string,
  worktree: string,
  device: { platform: Platform; id: string; name: string; serial?: string },
  extra: { ownerState?: OwnerState; deviceState?: DeviceState } = {},
): LaneStatus {
  const [kind = 'claude', pid = '0', ...start] = ownerKey.split(':');
  return {
    id,
    owner: {
      kind: kind as 'claude',
      process: { pid: Number(pid), start: start.join(':') },
      sessionId: `${id}-session-0000`,
      threadId: null,
    },
    ownerKey,
    projectRoot: worktree,
    worktree,
    createdAt: NOW - 3_600_000,
    lastUsedAt: NOW - 120_000,
    lastAction: 'up',
    device: { serial: null, ...device, deviceType: 't', deviceTypeName: 'iPhone 17', runtime: 'r', runtimeName: 'iOS 26.5' },
    ports: [],
    processes: [],
    resources: [],
    browser: null,
    ownerState: extra.ownerState ?? 'alive',
    idleMs: 120_000,
    deviceState: extra.deviceState ?? 'booted',
    park: null,
    hold: null,
    ownerGone: null,
  };
}

const otherIos = lane('aaaa1111', OTHER, '/w/other', { platform: 'ios', id: OTHER_UDID, name: 'agentlane-pool-aaaaaa' });
const mineIos = lane('bbbb2222', SELF, '/w/mine', { platform: 'ios', id: MINE_UDID, name: 'agentlane-pool-bbbbbb' });
const siblingIos = lane('cccc3333', SELF, '/w/sibling', { platform: 'ios', id: SIBLING_UDID, name: 'agentlane-pool-cccccc' });
const deadIos = lane(
  'dddd4444',
  'claude:300:x',
  '/w/gone',
  { platform: 'ios', id: DEAD_UDID, name: 'agentlane-pool-dddddd' },
  { ownerState: 'dead' },
);
const otherAndroid = lane('eeee5555', OTHER, '/w/other', {
  platform: 'android',
  id: 'agentlane-emu-111111',
  name: 'agentlane-emu-111111',
  serial: 'emulator-5554',
});
const mineAndroid = lane('ffff6666', SELF, '/w/mine', {
  platform: 'android',
  id: 'agentlane-emu-222222',
  name: 'agentlane-emu-222222',
  serial: 'emulator-5560',
});

const ALL = [otherIos, mineIos, siblingIos, deadIos, otherAndroid, mineAndroid];

function context(lanes: readonly LaneStatus[] = ALL, cwd = '/w/mine'): GuardContext {
  return {
    self: SELF,
    cwd,
    lanes,
    now: NOW,
    worktreeOf: dir => ['/w/mine', '/w/sibling', '/w/other'].find(w => dir === w || dir.startsWith(`${w}/`)) ?? null,
    sessionName: c => (c.id === otherIos.id ? 'fixing the map' : null),
  };
}

type Expect = 'allow' | LaneStatus | LaneStatus[];

interface Row {
  name: string;
  command: string;
  expect: Expect;
  env?: NodeJS.ProcessEnv;
  lanes?: readonly LaneStatus[];
  cwd?: string;
}

const otherIosShutdown = { ...otherIos, deviceState: 'shutdown' as const };

const ROWS: Row[] = [
  { name: 'simctl list is read-only', command: 'xcrun simctl list devices booted', expect: 'allow' },
  { name: 'simctl help', command: 'xcrun simctl help install', expect: 'allow' },
  {
    name: 'install on another session’s simulator',
    command: `xcrun simctl install ${OTHER_UDID} build/App.app`,
    expect: otherIos,
  },
  { name: 'install on my own simulator', command: `xcrun simctl install ${MINE_UDID} build/App.app`, expect: 'allow' },
  { name: 'a UDID in lower case', command: `xcrun simctl boot ${OTHER_UDID.toLowerCase()}`, expect: otherIos },
  { name: 'a simulator no session holds', command: `xcrun simctl install ${FREE_UDID} build/App.app`, expect: 'allow' },
  { name: 'aimed by device name', command: 'xcrun simctl boot agentlane-pool-aaaaaa', expect: otherIos },
  {
    name: 'booted while other lanes’ simulators are booted',
    command: 'xcrun simctl launch booted com.example.app',
    expect: [otherIos, siblingIos],
  },
  {
    name: 'booted while no other session’s simulator is booted',
    command: 'xcrun simctl launch booted com.example.app',
    expect: 'allow',
    lanes: [otherIosShutdown, mineIos],
  },
  { name: 'shutdown all', command: 'xcrun simctl shutdown all', expect: [otherIos, siblingIos] },
  { name: 'erase all', command: 'xcrun simctl erase all', expect: [otherIos, siblingIos] },
  { name: 'delete unavailable', command: 'xcrun simctl delete unavailable', expect: [otherIos, siblingIos] },
  {
    name: 'shutdown all with no other holder',
    command: 'xcrun simctl shutdown all',
    expect: 'allow',
    lanes: [mineIos, deadIos],
  },
  {
    name: 'double quotes inside an && chain',
    command: `cd /tmp && xcrun simctl install "${OTHER_UDID}" "build/My App.app"`,
    expect: otherIos,
  },
  {
    name: 'after an echo, through a pipe',
    command: `echo go | xcrun simctl io ${OTHER_UDID} screenshot - > shot.png`,
    expect: otherIos,
  },
  {
    name: 'full path to xcrun with --sdk and single quotes',
    command: `/usr/bin/xcrun --sdk iphonesimulator simctl uninstall '${OTHER_UDID}' com.example.app`,
    expect: otherIos,
  },
  {
    name: 'simctl by full path',
    command: `/Applications/Xcode.app/Contents/Developer/usr/bin/simctl erase ${OTHER_UDID}`,
    expect: otherIos,
  },
  {
    name: 'this session’s lane for another folder',
    command: `xcrun simctl install ${SIBLING_UDID} App.app`,
    expect: siblingIos,
  },
  {
    name: 'cd into that folder first',
    command: `cd /w/sibling && xcrun simctl install ${SIBLING_UDID} App.app`,
    expect: 'allow',
  },
  {
    name: 'from a subfolder of my worktree',
    command: `xcrun simctl install ${MINE_UDID} App.app`,
    expect: 'allow',
    cwd: '/w/mine/apps/mobile',
  },
  { name: 'a lane whose owner is dead', command: `xcrun simctl install ${DEAD_UDID} App.app`, expect: 'allow' },
  { name: 'inside bash -c', command: `bash -lc 'xcrun simctl erase ${OTHER_UDID}'`, expect: otherIos },
  {
    name: 'inside a command substitution',
    command: `echo "$(xcrun simctl spawn ${OTHER_UDID} launchctl list)"`,
    expect: otherIos,
  },
  { name: 'inside backticks', command: `x=\`xcrun simctl get_app_container ${OTHER_UDID} com.example.app\``, expect: otherIos },
  { name: 'an unresolved variable passes', command: 'xcrun simctl install "$AGENTLANE_DEVICE" App.app', expect: 'allow' },
  {
    name: 'a variable the environment resolves',
    command: 'xcrun simctl install "$TARGET" App.app',
    expect: otherIos,
    env: { TARGET: OTHER_UDID },
  },
  { name: 'xcrun --find simctl runs nothing', command: 'xcrun --find simctl', expect: 'allow' },
  { name: 'pbsync from mine to theirs', command: `xcrun simctl pbsync ${MINE_UDID} ${OTHER_UDID}`, expect: otherIos },
  { name: 'create makes a new simulator', command: 'xcrun simctl create probe "iPhone 17" iOS26.5', expect: 'allow' },
  { name: 'sudo wrapper', command: `sudo -u me xcrun simctl erase ${OTHER_UDID}`, expect: otherIos },
  { name: 'nohup in the background', command: `nohup xcrun simctl boot ${OTHER_UDID} &`, expect: otherIos },
  { name: 'through agentlane exec', command: `agentlane exec -- xcrun simctl install ${OTHER_UDID} App.app`, expect: otherIos },
  { name: 'a heredoc body is data', command: `cat <<EOF > notes.txt\nxcrun simctl erase ${OTHER_UDID}\nEOF`, expect: 'allow' },
  { name: 'words that only mention the tools', command: 'grep -rn "simctl erase" docs/ && ls adb-notes/', expect: 'allow' },
  { name: 'a comment', command: `ls # xcrun simctl erase ${OTHER_UDID}`, expect: 'allow' },
  { name: 'adb devices is read-only', command: 'adb devices -l', expect: 'allow' },
  { name: 'adb -s on another session’s emulator', command: 'adb -s emulator-5554 install app.apk', expect: otherAndroid },
  { name: 'adb -s attached', command: 'adb -semulator-5554 shell pm list packages', expect: otherAndroid },
  { name: 'adb -s on my emulator', command: 'adb -s emulator-5560 install app.apk', expect: 'allow' },
  { name: 'adb -s on an emulator no one holds', command: 'adb -s emulator-5556 install app.apk', expect: 'allow' },
  {
    name: 'env VAR=... adb',
    command: 'env ANDROID_SERIAL=emulator-5554 adb install app.apk',
    expect: otherAndroid,
  },
  { name: 'ANDROID_SERIAL as a prefix assignment', command: 'ANDROID_SERIAL=emulator-5554 adb shell ls', expect: otherAndroid },
  { name: 'ANDROID_SERIAL exported earlier', command: 'export ANDROID_SERIAL=emulator-5554; adb shell ls', expect: otherAndroid },
  { name: 'ANDROID_SERIAL of my own', command: 'ANDROID_SERIAL=emulator-5560 adb shell ls', expect: 'allow' },
  {
    name: 'ANDROID_SERIAL from the session environment',
    command: 'adb shell ls',
    expect: otherAndroid,
    env: { ANDROID_SERIAL: 'emulator-5554' },
  },
  { name: 'env -u drops it', command: 'env -u ANDROID_SERIAL adb -s emulator-5560 shell ls', expect: 'allow' },
  {
    name: 'full path to adb',
    command: '/Users/me/Library/Android/sdk/platform-tools/adb -s emulator-5554 emu kill',
    expect: otherAndroid,
  },
  { name: 'adb with no selector', command: 'adb install app.apk', expect: otherAndroid },
  { name: 'adb -e', command: 'adb -e install app.apk', expect: otherAndroid },
  { name: 'adb -t transport id', command: 'adb -t 3 shell getprop', expect: otherAndroid },
  { name: 'adb -d is a USB device', command: 'adb -d install app.apk', expect: 'allow' },
  {
    name: 'server routing flags are skipped',
    command: 'adb -H 127.0.0.1 -P 5038 -s emulator-5554 shell ls',
    expect: otherAndroid,
  },
  { name: 'server routing on a read-only command', command: 'adb -L tcp:localhost:5038 devices', expect: 'allow' },
  { name: 'adb kill-server', command: 'adb kill-server', expect: otherAndroid },
  { name: 'adb kill-server with no other holder', command: 'adb kill-server', expect: 'allow', lanes: [mineAndroid, otherIos] },
  { name: 'adb disconnect with no target', command: 'adb disconnect', expect: otherAndroid },
  { name: 'adb disconnect of another target', command: 'adb disconnect 10.0.0.9:5555', expect: 'allow' },
  { name: 'adb forward --remove-all', command: 'adb forward --remove-all', expect: otherAndroid },
  { name: 'adb -s mine forward --remove-all', command: 'adb -s emulator-5560 forward --remove-all', expect: 'allow' },
  { name: 'adb forward --list', command: 'adb forward --list', expect: 'allow' },
  { name: 'adb reverse --list', command: 'adb reverse --list', expect: 'allow' },
  {
    name: 'adb -s reverse on another session’s emulator',
    command: 'adb -s emulator-5554 reverse tcp:8081 tcp:41118',
    expect: otherAndroid,
  },
  { name: 'adb -s mine reverse --remove', command: 'adb -s emulator-5560 reverse --remove tcp:41118', expect: 'allow' },
  { name: 'adb reverse --remove-all with no selector', command: 'adb reverse --remove-all', expect: otherAndroid },
  {
    name: 'adb -s emu geo fix on another session’s emulator',
    command: 'adb -s emulator-5554 emu geo fix 34.78 32.07',
    expect: otherAndroid,
  },
  { name: 'adb reconnect offline', command: 'adb reconnect offline', expect: otherAndroid },
  { name: 'adb connect', command: 'adb connect 10.0.0.9:5555', expect: otherAndroid },
  { name: 'timeout wrapper', command: 'timeout 10 adb -s emulator-5554 wait-for-device', expect: otherAndroid },
  { name: 'emulator -avd', command: 'emulator -avd agentlane-emu-111111 -no-window', expect: otherAndroid },
  { name: 'emulator @name', command: 'emulator @agentlane-emu-111111 -no-audio', expect: otherAndroid },
  { name: 'emulator -list-avds', command: 'emulator -list-avds', expect: 'allow' },
  { name: 'avdmanager delete', command: 'avdmanager delete avd -n agentlane-emu-111111', expect: otherAndroid },
  { name: 'avdmanager list', command: 'avdmanager list avd', expect: 'allow' },
  { name: 'adb spelled with locale quoting', command: 'a$"db" -s emulator-5554 shell ls', expect: otherAndroid },
  { name: 'locale quoting inside bash -c', command: `bash -c 'a$"db" -s emulator-5554 shell ls'`, expect: otherAndroid },
  { name: 'simctl spelled with locale quoting', command: `xcrun sim$"ctl" boot ${OTHER_UDID}`, expect: otherIos },
  { name: 'locale quoting inside double quotes is a dollar sign', command: 'echo "a$"db', expect: 'allow' },
  { name: 'adb spelled by a one-letter brace sequence', command: 'a{d..d}b -s emulator-5554 shell ls', expect: otherAndroid },
  { name: 'a serial made by brace expansion', command: 'adb -s emulator-55{54,60} shell ls', expect: otherAndroid },
  {
    name: 'emulator reached through env by brace expansion',
    command: 'e{nv,mulator} -avd agentlane-emu-111111',
    expect: otherAndroid,
  },
  { name: 'a quoted brace is not expanded', command: "adb -s 'emulator-55{54,60}' shell ls", expect: 'allow' },
  { name: 'a brace expansion that runs ab, not adb', command: 'a{,d}b -s emulator-5554 shell ls', expect: 'allow' },
  { name: 'an assignment before a command is not brace expanded', command: 'X=a{d,}b env', expect: 'allow' },
  {
    name: 'a brace expansion of more than a thousand words is left as written',
    command: 'adb -s emulator-5554 shell echo {1..100000}',
    expect: otherAndroid,
  },
];

for (const row of ROWS) {
  test(`guard: ${row.name}`, () => {
    const verdict = guard(row.command, row.env ?? {}, context(row.lanes ?? ALL, row.cwd ?? '/w/mine'));
    if (row.expect === 'allow') {
      assert.equal(verdict.allow, true, verdict.allow ? '' : verdict.reason);
      return;
    }
    assert.equal(verdict.allow, false, `expected a block for: ${row.command}`);
    const holders = Array.isArray(row.expect) ? row.expect : [row.expect];
    assert.match(verdict.reason, /^agentlane: blocked: /);
    for (const holder of holders) {
      assert.ok(verdict.reason.includes(`lane ${holder.id}`), `names lane ${holder.id}:\n${verdict.reason}`);
      assert.ok(verdict.reason.includes(`in ${holder.worktree}, since `), `names the folder:\n${verdict.reason}`);
      const recover =
        holder.ownerKey === SELF ? `cd ${holder.worktree}` : `node_modules/.bin/agentlane release --lane ${holder.id} --force`;
      assert.ok(verdict.reason.includes(recover), `recovers with ${recover}:\n${verdict.reason}`);
    }
    assert.match(verdict.reason, /\nto recover:\n/);
    for (const other of ALL.filter(c => !holders.includes(c))) assert.ok(!verdict.reason.includes(`lane ${other.id}`));
  });
}

test('guard: the block names the holder’s session name and offers my own device', () => {
  const verdict = guard(`xcrun simctl install ${OTHER_UDID} App.app`, {}, context());
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /held by claude session aaaa1111 \(pid 200\) "fixing the map" in \/w\/other/);
  assert.ok(verdict.reason.includes(`aim at your own simulator: ${MINE_UDID}`), verdict.reason);
});

test('guard: a session with no simulator of its own is told to claim one', () => {
  const verdict = guard(`xcrun simctl install ${OTHER_UDID} App.app`, {}, context([otherIos]));
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /agentlane up {3}\(or agentlane claim: get a simulator of your own/);
});

test('guard: the table covers at least 30 command forms', () => {
  assert.ok(ROWS.length >= 30, String(ROWS.length));
});

function web(
  id: string,
  ownerKey: string,
  worktree: string,
  driver: 'playwright' | 'agent-browser',
  debugPort: number,
): LaneStatus {
  const base = lane(id, ownerKey, worktree, { platform: 'ios', id: `${id}-udid`, name: `${id}-sim` });
  return {
    ...base,
    device: null,
    browser: {
      driver,
      session: `agentlane-${id}`,
      debugPort,
      streamPort: driver === 'agent-browser' ? debugPort + 1 : null,
      createdAt: NOW,
    },
  };
}

const otherPw = web('1111aaaa', OTHER, '/w/other', 'playwright', 41_400);
const otherAb = web('2222bbbb', OTHER, '/w/other2', 'agent-browser', 41_402);
const minePw = web('3333cccc', SELF, '/w/mine', 'playwright', 41_404);
const WEB_LANES = [otherPw, otherAb, minePw];

const BROWSER_ROWS: Row[] = [
  {
    name: 'playwright-cli -s= on another lane’s session',
    command: 'playwright-cli -s=agentlane-1111aaaa snapshot',
    expect: otherPw,
  },
  { name: 'playwright-cli -s <name>', command: 'playwright-cli -s agentlane-1111aaaa click e3', expect: otherPw },
  { name: 'playwright-cli --session=', command: 'playwright-cli --session=agentlane-1111aaaa goto http://x/', expect: otherPw },
  { name: 'playwright-cli on my own session', command: 'playwright-cli -s=agentlane-3333cccc snapshot', expect: 'allow' },
  { name: 'playwright-cli with no session under exec', command: 'agentlane exec -- playwright-cli snapshot', expect: 'allow' },
  {
    name: 'PLAYWRIGHT_CLI_SESSION as a prefix',
    command: 'PLAYWRIGHT_CLI_SESSION=agentlane-1111aaaa playwright-cli snapshot',
    expect: otherPw,
  },
  { name: 'npx @playwright/cli', command: 'npx @playwright/cli@latest -s=agentlane-1111aaaa open', expect: otherPw },
  { name: 'playwright-cli kill-all', command: 'playwright-cli kill-all', expect: otherPw },
  { name: 'playwright-cli close-all stays in its own folder', command: 'playwright-cli close-all', expect: 'allow' },
  {
    name: 'playwright-cli attach to another lane’s port',
    command: 'playwright-cli attach --cdp=http://127.0.0.1:41400',
    expect: otherPw,
  },
  {
    name: 'agent-browser --session on another lane’s',
    command: 'agent-browser --session agentlane-2222bbbb snapshot',
    expect: otherAb,
  },
  { name: 'agent-browser --session=', command: 'agent-browser --session=agentlane-2222bbbb open http://x/', expect: otherAb },
  {
    name: 'AGENT_BROWSER_SESSION exported',
    command: 'export AGENT_BROWSER_SESSION=agentlane-2222bbbb; agent-browser click @e1',
    expect: otherAb,
  },
  { name: 'agent-browser --cdp on another lane’s port', command: 'agent-browser --cdp 41402 snapshot', expect: otherAb },
  { name: 'agent-browser connect to its stream port', command: 'agent-browser connect 41403', expect: otherAb },
  { name: 'agent-browser close --all', command: 'agent-browser close --all', expect: 'allow' },
  { name: 'agent-browser -s is not a session flag', command: 'agent-browser -s agentlane-2222bbbb', expect: 'allow' },
  { name: 'a port no lane holds', command: 'agent-browser --cdp 9222 snapshot', expect: 'allow' },
];

for (const row of BROWSER_ROWS) {
  test(`guard: ${row.name}`, () => {
    const verdict = guard(row.command, row.env ?? {}, context(row.lanes ?? WEB_LANES, row.cwd ?? '/w/mine'));
    if (row.expect === 'allow') {
      assert.equal(verdict.allow, true, verdict.allow ? '' : verdict.reason);
      return;
    }
    assert.equal(verdict.allow, false, `expected a block for: ${row.command}`);
    const [holder] = Array.isArray(row.expect) ? row.expect : [row.expect];
    assert.ok(holder);
    assert.match(verdict.reason, /^agentlane: blocked: /);
    assert.ok(verdict.reason.includes(`lane ${holder.id}`), verdict.reason);
    assert.ok(
      verdict.reason.includes(
        `its browser, ${holder.browser?.driver === 'playwright' ? 'playwright-cli' : 'agent-browser'} session ${holder.browser?.session ?? ''}`,
      ),
      verdict.reason,
    );
    assert.ok(verdict.reason.includes(`node_modules/.bin/agentlane release --lane ${holder.id} --force`), verdict.reason);
    assert.ok(
      verdict.reason.includes(
        'run it under node_modules/.bin/agentlane exec, which binds the driver to your own browser (agentlane-3333cccc',
      ),
      verdict.reason,
    );
    for (const other of WEB_LANES.filter(c => c !== holder))
      assert.ok(!verdict.reason.includes(`lane ${other.id}`), verdict.reason);
  });
}

test('guard: a session with no browser of its own is told to claim one', () => {
  const verdict = guard('agent-browser --session agentlane-2222bbbb snapshot', {}, context([otherAb]));
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /agentlane up --platform web {3}\(claims a browser of your own/);
});

const STARTS_A_CONTAINER = [
  'docker run -d postgres:16',
  'docker run --detach postgres:16',
  'docker run --detach=true postgres:16',
  'docker run -dit --name db postgres:16',
  'docker run -itd postgres:16',
  'docker run --rm -e POSTGRES_PASSWORD=x -p 5432:5432 -d postgres:16',
  'docker run -p5432:5432 -d postgres:16',
  'podman run -d postgres:16',
  'docker --context colima run -d postgres:16',
  'docker -H unix:///var/run/docker.sock --log-level warn run -d postgres:16',
  'docker --some-new-flag value run -d postgres:16',
  'docker container run -d postgres:16',
  'docker start db',
  'docker restart db',
  'docker container start db',
  'docker container restart db',
  'podman start db',
  'podman pod start pod1',
  'podman kube play pod.yaml',
  'docker compose up -d',
  'docker compose up --detach db',
  'docker compose up --wait',
  'docker compose -f a.yml -p proj up -d',
  'docker compose up db -d',
  'docker compose up -Vd',
  'docker compose start',
  'docker compose run -d db',
  'docker --context x compose --file a.yml up -d',
  'podman compose up -d',
  'docker-compose up -d',
  'podman-compose up -d',
  "sh -c 'docker run -d postgres:16'",
  'bash -lc "docker compose up -d"',
  'do""cker run -d postgres:16',
  "'docker' run -d postgres:16",
  'd{o,}cker run -d postgres:16',
  'npx docker-compose up -d',
  'pnpm exec docker compose up -d',
  'env DOCKER_HOST=unix:///x docker run -d postgres:16',
  'sudo docker run -d postgres:16',
  '/usr/local/bin/docker run -d postgres:16',
  'nohup docker run -d postgres:16 &',
  'setsid docker run -d postgres:16',
  'cd /tmp && docker run -d postgres:16 && echo started',
  'echo "$(docker run -d postgres:16)"',
  'AGENTLANE_ALLOW_CONTAINER=1 true; docker run -d x',
  'AGENTLANE_ALLOW_CONTAINER=0 docker run -d x',
];

const STARTS_NO_CONTAINER = [
  'docker run --rm alpine echo hi',
  'docker run --rm -it alpine sh',
  'docker run --rm alpine ls -d /',
  'docker run --rm --name probe -e X=-d alpine true',
  'docker run --detach=false alpine true',
  'docker run --rm -- alpine -d',
  'docker create --name db postgres:16',
  'docker ps -a',
  'docker logs -f db',
  'docker exec -it db psql',
  'docker exec -d db touch /tmp/x',
  'docker inspect db',
  'docker stop db',
  'docker rm -f db',
  'docker build -t app .',
  'docker pull postgres:16',
  'docker images',
  'docker start --help',
  'docker compose down',
  'docker compose ps',
  'docker compose logs -f',
  'docker compose up',
  'docker compose up --build db',
  'docker compose run --rm db psql',
  'docker compose -f docker-compose.yml config',
  'docker-compose down -v',
  'podman ps',
  'podman kube play --down pod.yaml',
  'nohup some-server &',
  'nohup pnpm dev > dev.log 2>&1 &',
  'setsid node server.js &',
  'node server.js & disown',
  'cat docker-compose.yml',
  'grep -rn "docker run -d" docs/',
  'echo docker run -d postgres',
  'AGENTLANE_ALLOW_CONTAINER=1 docker run -d postgres:16',
  'AGENTLANE_ALLOW_CONTAINER=1 docker compose up -d',
  "AGENTLANE_ALLOW_CONTAINER=1 sh -c 'docker run -d postgres:16'",
  'export AGENTLANE_ALLOW_CONTAINER=1; docker run -d postgres:16',
  'env AGENTLANE_ALLOW_CONTAINER=1 docker run -d postgres:16',
];

for (const command of STARTS_A_CONTAINER) {
  test(`guard: a container that outlives the command is blocked: ${command}`, () => {
    const verdict = guard(command, {}, context());
    assert.equal(verdict.allow, false, `expected a block for: ${command}`);
    assert.match(verdict.reason, /^agentlane: blocked: `.*` starts a container that keeps running after the command ends/);
  });
}

for (const command of STARTS_NO_CONTAINER) {
  test(`guard: a command that starts no lasting container is allowed: ${command}`, () => {
    const verdict = guard(command, {}, context([]));
    assert.equal(verdict.allow, true, verdict.allow ? '' : verdict.reason);
  });
}

test('guard: the container block names the lane routes and the bypass the user has to ask for', () => {
  const verdict = guard('cd /w/mine && docker run -d -p 5432:5432 postgres:16', {}, context());
  assert.equal(verdict.allow, false);
  assert.equal(
    verdict.reason,
    [
      'agentlane: blocked: `docker run -d -p 5432:5432 postgres:16` starts a container that keeps running after the command ends, and no lane will stop it.',
      'to recover:',
      '  declare the server under "shared" in agentlane.json (or its data as a resource), then node_modules/.bin/agentlane up, or node_modules/.bin/agentlane up --no-app for the data alone',
      "  node_modules/.bin/agentlane exec -- <command>   (runs the work with that lane's servers and data)",
      "  AGENTLANE_ALLOW_CONTAINER=1 docker run -d -p 5432:5432 postgres:16   (only if the user has asked, in this conversation, for a container outside lanes; agentlane won't track or stop it)",
    ].join('\n'),
  );
});

test('guard: the bypass in the environment the hook sees lets a container start through', () => {
  assert.equal(guard('docker run -d postgres:16', { AGENTLANE_ALLOW_CONTAINER: '1' }, context()).allow, true);
  assert.equal(guard('docker compose up -d', { AGENTLANE_ALLOW_CONTAINER: '1' }, context()).allow, true);
  assert.equal(guard('docker run -d postgres:16', { AGENTLANE_ALLOW_CONTAINER: '' }, context()).allow, false);
  assert.equal(
    guard('env -u AGENTLANE_ALLOW_CONTAINER docker run -d x', { AGENTLANE_ALLOW_CONTAINER: '1' }, context()).allow,
    false,
  );
});

test('guard: a device command is judged as before beside a container start the bypass allows', () => {
  const verdict = guard(`AGENTLANE_ALLOW_CONTAINER=1 docker run -d x; xcrun simctl erase ${OTHER_UDID}`, {}, context());
  assert.equal(verdict.allow, false);
  assert.ok(verdict.reason.includes(`lane ${otherIos.id}`), verdict.reason);
});

test('guard: a package script that starts a container is blocked through the package manager that runs it', () => {
  const dir = fs.realpathSync(tempDir('guard-scripts'));
  try {
    const sub = path.join(dir, 'apps', 'api');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: {
          'db:up': 'docker compose up -d',
          'db:down': 'docker compose down',
          dev: 'pnpm run db:up && next dev',
          predb: 'docker start pg',
          db: 'node seed.js',
          start: 'docker run -d app',
          test: 'node --test',
          loop: 'pnpm loop',
          ios: `xcrun simctl erase ${OTHER_UDID}`,
        },
      }),
    );
    const blocked = (command: string, cwd = dir) => !guard(command, {}, context(ALL, cwd)).allow;
    for (const command of [
      'pnpm run db:up',
      'pnpm db:up',
      'npm run db:up',
      'npm run-script db:up',
      'yarn db:up',
      'yarn run db:up',
      'bun run db:up',
      'pnpm run dev',
      'npm run db',
      'npm start',
      'pnpm start',
      `pnpm -C ${dir} run db:up`,
      `pnpm --dir=${dir} db:up`,
      'sh -c "pnpm run db:up"',
    ])
      assert.equal(blocked(command), true, `blocks ${command}`);
    assert.equal(blocked('pnpm run db:up', sub), true, 'from a folder below the package.json');
    for (const command of [
      'pnpm run db:down',
      'pnpm test',
      'npm test',
      'pnpm run db',
      'pnpm loop',
      'pnpm run missing',
      'pnpm install',
      'AGENTLANE_ALLOW_CONTAINER=1 pnpm run db:up',
      'pnpm run ios',
    ])
      assert.equal(blocked(command), false, `allows ${command}`);
    assert.equal(blocked('pnpm run db:up', '/'), false, 'no package.json above the folder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
