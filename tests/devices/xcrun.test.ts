import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  createXcrunTools,
  DeviceCommandError,
  execCommand,
  LOCATION_LOG_PREDICATE,
  parseDevices,
  parseLocationLog,
  parseLogTimestamp,
  parsePlistBoolean,
  parseStatusBar,
  statusBarPinned,
  type Exec,
  type ExecResult,
} from '../../src/devices/index.ts';
import { UDID } from './fake.ts';

const STATUS_BAR_PINNED = `Current Status Bar Overrides:
=============================
Time: 09:41
DataNetworkType: 11
WiFi Mode: 3, WiFi Bars: 3
Cell Mode: 3, Cell Bars: 4
Operator Name: Carrier
Battery State: 2, Battery Level: 100, Not Charging: 0
`;

const STATUS_BAR_EMPTY = `Current Status Bar Overrides:
=============================
`;

function locationEvent(timestamp: string, latitude: string, longitude: string): string {
  return JSON.stringify({
    messageType: 'Fault',
    subsystem: 'com.apple.locationd.Position',
    timestamp,
    eventMessage: `LocationProvider,Provider controller is notifying clients (notification type=10) of a <0,0> raw coordinate, at location (<${latitude},${longitude}>) of type 1`,
    processID: 13499,
  });
}

interface Call {
  command: string;
  args: readonly string[];
  input: string | undefined;
}

function scripted(responses: ((call: Call) => Partial<ExecResult> | undefined)[]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    const call = { command, args, input: options?.input };
    calls.push(call);
    for (const respond of responses) {
      const result = respond(call);
      if (result) return Promise.resolve({ code: 0, stdout: '', stderr: '', ...result });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { exec, calls };
}

const argv = (call: Call) => [call.command, ...call.args].join(' ');

test('execCommand returns the exit code of a command that exits without reading its input', async () => {
  const result = await execCommand(process.execPath, ['-e', 'process.exit(3)'], { input: 'x'.repeat(8 * 1024 * 1024) });
  assert.equal(result.code, 3);
});

test('parseStatusBar reads the fields simctl status_bar list prints', () => {
  const fields = parseStatusBar(STATUS_BAR_PINNED);
  assert.deepEqual(fields, {
    Time: '09:41',
    DataNetworkType: '11',
    'WiFi Mode': '3',
    'WiFi Bars': '3',
    'Cell Mode': '3',
    'Cell Bars': '4',
    'Operator Name': 'Carrier',
    'Battery State': '2',
    'Battery Level': '100',
    'Not Charging': '0',
  });
  assert.equal(statusBarPinned(fields), true);
  assert.deepEqual(parseStatusBar(STATUS_BAR_EMPTY), {});
  assert.equal(statusBarPinned(parseStatusBar(STATUS_BAR_EMPTY)), false);
  assert.equal(statusBarPinned({ ...fields, Time: '10:12' }), false);
});

test('the pinned time counts with or without its leading zero, as different Macs read it back', () => {
  const fields = parseStatusBar(STATUS_BAR_PINNED.replace('Time: 09:41', 'Time: 9:41'));
  assert.equal(fields.Time, '9:41');
  assert.equal(statusBarPinned(fields), true);
  assert.equal(statusBarPinned({ ...fields, Time: '19:41' }), false);
  assert.equal(statusBarPinned({ ...fields, Time: '9:42' }), false);
});

test('parseLogTimestamp reads log show timestamps with microseconds and an offset', () => {
  assert.equal(parseLogTimestamp('2026-10-11 21:37:48.741979-0400')?.toISOString(), '2026-10-12T01:37:48.741Z');
  assert.equal(parseLogTimestamp('2026-10-11 21:37:48+0000')?.toISOString(), '2026-10-11T21:37:48.000Z');
  assert.equal(parseLogTimestamp('yesterday'), undefined);
});

test('parseLocationLog returns the newest fix since the given time', () => {
  const ndjson = [
    locationEvent('2026-10-11 21:37:47.700000-0400', '+32.07120000', '+34.78120000'),
    locationEvent('2026-10-11 21:37:49.700000-0400', '+32.07140000', '-34.78140000'),
    locationEvent('2026-10-11 21:37:48.700000-0400', '+1.00000000', '+1.00000000'),
    'not json',
    JSON.stringify({ timestamp: '2026-10-11 21:37:50.000000-0400', eventMessage: 'unrelated' }),
    JSON.stringify({ count: 3, finished: 1 }),
  ].join('\n');

  assert.deepEqual(parseLocationLog(ndjson, new Date('2026-10-12T01:37:48.000Z')), { latitude: 32.0714, longitude: -34.7814 });
  assert.equal(parseLocationLog(ndjson, new Date('2026-10-12T01:37:50.000Z')), undefined);
  assert.equal(parseLocationLog('', new Date(0)), undefined);
});

test('parseDevices flattens simctl list devices --json', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: UDID, name: 'agentlane-dev', state: 'Booted', dataPath: '/d/data', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [],
    },
  });
  assert.deepEqual(parseDevices(json), [{ udid: UDID, name: 'agentlane-dev', state: 'Booted', dataPath: '/d/data' }]);
});

test('parsePlistBoolean accepts the boolean and the string forms the pref is found in', () => {
  assert.equal(parsePlistBoolean('false\n'), false);
  assert.equal(parsePlistBoolean('0'), false);
  assert.equal(parsePlistBoolean('true'), true);
  assert.equal(parsePlistBoolean('1'), true);
  assert.equal(parsePlistBoolean('maybe'), undefined);
});

test('readLocation asks locationd through the simulator log', async () => {
  const { exec, calls } = scripted([
    () => ({ stdout: locationEvent('2026-10-12 01:37:49.000000+0000', '+32.07000000', '+34.78000000') }),
  ]);
  const tools = createXcrunTools({ exec });

  assert.deepEqual(await tools.readLocation(UDID, new Date('2026-10-12T01:37:48.000Z')), { latitude: 32.07, longitude: 34.78 });
  assert.equal(await tools.readLocation(UDID, new Date('2026-10-12T01:37:50.000Z')), undefined);
  const args = calls[0]?.args ?? [];
  assert.deepEqual(args.slice(0, 5), ['simctl', 'spawn', UDID, 'log', 'show']);
  assert.deepEqual(args.slice(-4), ['--style', 'ndjson', '--predicate', LOCATION_LOG_PREDICATE]);
});

test('the keyboard pref is written per UDID under DevicePreferences, keeping the other per-device keys', async () => {
  const existing = '<plist><dict><key>SimulatorWindowOrientation</key><string>Portrait</string></dict></plist>';
  const { exec, calls } = scripted([
    call => (argv(call) === 'defaults export com.apple.iphonesimulator -' ? { stdout: '<exported/>' } : undefined),
    call => (call.args[1] === `DevicePreferences.${UDID}` ? { stdout: existing } : undefined),
    call => (call.args[0] === '-replace' ? { stdout: '<updated/>' } : undefined),
  ]);

  await createXcrunTools({ exec }).writeHardwareKeyboard(UDID, false);

  assert.deepEqual(
    calls.map(call => [argv(call), call.input]),
    [
      ['defaults export com.apple.iphonesimulator -', undefined],
      [`plutil -extract DevicePreferences.${UDID} xml1 -o - -`, '<exported/>'],
      ['plutil -replace ConnectHardwareKeyboard -bool NO -o - -', existing],
      [`defaults write com.apple.iphonesimulator DevicePreferences -dict-add ${UDID} <updated/>`, undefined],
    ],
  );
});

test('a UDID with no per-device prefs yet starts from an empty dictionary', async () => {
  const { exec, calls } = scripted([
    call => (call.args[1] === `DevicePreferences.${UDID}` ? { code: 1, stderr: 'No value at that key path' } : undefined),
    call => (call.args[0] === '-replace' ? { stdout: '<updated/>' } : undefined),
  ]);

  await createXcrunTools({ exec }).writeHardwareKeyboard(UDID, false);

  assert.match(calls[2]?.input ?? '', /<dict\/>/);
});

test('readHardwareKeyboard reads the per-UDID value and reports a missing one as unset', async () => {
  const set = scripted([call => (call.args[0] === '-extract' ? { stdout: 'false\n' } : undefined)]);
  assert.equal(await createXcrunTools({ exec: set.exec }).readHardwareKeyboard(UDID), false);
  assert.equal(set.calls[1]?.args[1], `DevicePreferences.${UDID}.ConnectHardwareKeyboard`);

  const unset = scripted([call => (call.args[0] === '-extract' ? { code: 1 } : undefined)]);
  assert.equal(await createXcrunTools({ exec: unset.exec }).readHardwareKeyboard(UDID), undefined);
});

test("the keyboard intro mark is UIKit's continuous-path default, written as a bool and read back as one", async () => {
  const { exec, calls } = scripted([]);
  await createXcrunTools({ exec }).writeKeyboardIntroShown(UDID, true);
  assert.deepEqual(calls.map(argv), [
    `xcrun simctl spawn ${UDID} defaults write com.apple.keyboard.preferences DidShowContinuousPathIntroduction -bool YES`,
  ]);

  const shown = scripted([() => ({ stdout: '1\n' })]);
  assert.equal(await createXcrunTools({ exec: shown.exec }).readKeyboardIntroShown(UDID), true);
  assert.equal(
    argv(shown.calls[0] ?? { command: '', args: [], input: undefined }),
    `xcrun simctl spawn ${UDID} defaults read com.apple.keyboard.preferences DidShowContinuousPathIntroduction`,
  );

  const fresh = scripted([
    () => ({
      code: 1,
      stderr: 'The domain/default pair of (com.apple.keyboard.preferences, DidShowContinuousPathIntroduction) does not exist',
    }),
  ]);
  assert.equal(await createXcrunTools({ exec: fresh.exec }).readKeyboardIntroShown(UDID), undefined);
});

test('readAppDefault maps a missing default to undefined and any other failure to an error', async () => {
  const missing = scripted([
    () => ({ code: 1, stderr: 'The domain/default pair of (dev.example.app, RCT_jsLocation) does not exist' }),
  ]);
  assert.equal(
    await createXcrunTools({ exec: missing.exec }).readAppDefault(UDID, 'dev.example.app', 'RCT_jsLocation'),
    undefined,
  );
  assert.equal(
    argv(missing.calls[0] ?? { command: '', args: [], input: undefined }),
    `xcrun simctl spawn ${UDID} defaults read dev.example.app RCT_jsLocation`,
  );

  const broken = scripted([() => ({ code: 164, stderr: 'Unable to lookup in current state: Shutdown' })]);
  await assert.rejects(
    createXcrunTools({ exec: broken.exec }).readAppDefault(UDID, 'dev.example.app', 'RCT_jsLocation'),
    (error: unknown) => {
      assert.ok(error instanceof DeviceCommandError);
      assert.match(error.message, /exited 164: Unable to lookup in current state: Shutdown/);
      return true;
    },
  );
});

test('appRunning looks for the UIKit application job in launchctl', async () => {
  const { exec } = scripted([
    () => ({ stdout: '12345\t0\tUIKitApplication:dev.example.app[1a2b][rb-legacy]\n-\t0\tcom.apple.other\n' }),
  ]);
  const tools = createXcrunTools({ exec });
  assert.equal(await tools.appRunning(UDID, 'dev.example.app'), true);
  assert.equal(await tools.appRunning(UDID, 'dev.example'), false);
});

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('writePlistString adds a missing key with PlistBuddy and sets an existing one', async t => {
  const file = path.join(tempDir(t), 'Library', 'Preferences', 'approval.plist');
  const { exec, calls } = scripted([]);
  const tools = createXcrunTools({ exec });

  await tools.writePlistString(file, 'k-->scheme', 'dev.example.app');
  assert.ok(fs.existsSync(path.dirname(file)));
  assert.deepEqual(calls.map(argv), [`/usr/libexec/PlistBuddy -c Add :k-->scheme string dev.example.app ${file}`]);

  fs.writeFileSync(file, '');
  calls.length = 0;
  await tools.writePlistString(file, 'k-->scheme', 'dev.example.app');
  assert.deepEqual(calls.map(argv), [
    `/usr/libexec/PlistBuddy -c Print :k-->scheme ${file}`,
    `/usr/libexec/PlistBuddy -c Set :k-->scheme dev.example.app ${file}`,
  ]);
});

test('readPlistString reports a missing file without running PlistBuddy', async t => {
  const { exec, calls } = scripted([]);
  assert.equal(await createXcrunTools({ exec }).readPlistString(path.join(tempDir(t), 'none.plist'), 'k'), undefined);
  assert.deepEqual(calls, []);
});

test('boot waits for the simulator to finish booting', async () => {
  const { exec, calls } = scripted([]);
  await createXcrunTools({ exec }).boot(UDID);
  assert.deepEqual(calls.map(argv), [`xcrun simctl boot ${UDID}`, `xcrun simctl bootstatus ${UDID} -b`]);
});

test('launch passes the app its arguments after the bundle id', async () => {
  const { exec, calls } = scripted([]);
  await createXcrunTools({ exec }).launch(UDID, 'dev.example.app', ['--initialUrl', 'http://localhost:8090']);
  assert.deepEqual(calls.map(argv), [`xcrun simctl launch ${UDID} dev.example.app --initialUrl http://localhost:8090`]);
});
