import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAdbTools,
  deviceCommand,
  parseNightMode,
  parsePackagePaths,
  parseResolvedActivity,
  parseReverseList,
} from '../../src/devices/adb.ts';
import {
  applyAndroidHygiene,
  checkAndroidHygiene,
  ensureReverse,
  intentExtras,
  launchAndroidApp,
  launchAndroidDevClient,
} from '../../src/devices/android.ts';
import { HygieneError } from '../../src/devices/hygiene.ts';
import type { Exec } from '../../src/devices/xcrun.ts';
import { FakeAdb } from './fake-adb.ts';

test('adb output parsers read what an API 36 emulator prints', () => {
  assert.deepEqual(
    [...parseReverseList('host-16 tcp:41118 tcp:41118\nhost-16 tcp:8081 tcp:41119\n\n')],
    [
      [41118, 41118],
      [8081, 41119],
    ],
  );
  assert.equal(parseReverseList('').size, 0);
  assert.equal(parseNightMode('Night mode: no\n'), 'light');
  assert.equal(parseNightMode('Night mode: yes'), 'dark');
  assert.equal(parseNightMode('No shell command implementation.'), undefined);
  assert.deepEqual(parsePackagePaths('package:/data/app/~~x/com.example-1/base.apk\npackage:/data/app/~~x/split_a.apk\n'), [
    '/data/app/~~x/com.example-1/base.apk',
    '/data/app/~~x/split_a.apk',
  ]);
  assert.equal(
    parseResolvedActivity(
      'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.settings/.Settings\n',
    ),
    'com.android.settings/.Settings',
  );
  assert.equal(parseResolvedActivity('No activity found'), undefined);
});

test("every adb command names the claimed serial, and adb shell gets one quoted command line for the device's shell", async () => {
  const runs: string[][] = [];
  const exec: Exec = (command, args) => {
    runs.push([command, ...args]);
    const line = args.join(' ');
    if (line.includes('reverse --list')) return Promise.resolve({ code: 0, stdout: 'host-16 tcp:41118 tcp:41118\n', stderr: '' });
    if (line.includes('uimode')) return Promise.resolve({ code: 0, stdout: 'Night mode: yes\n', stderr: '' });
    return Promise.resolve({ code: 0, stdout: 'Success\n', stderr: '' });
  };
  const adb = createAdbTools('emulator-5584', { adb: '/sdk/platform-tools/adb', exec });
  await adb.start([
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'expoexample://expo-development-client/?url=http%3A%2F%2Flocalhost%3A41118',
    '--es',
    'apiBaseUrl',
    'http://localhost:41218',
    'com.example.expoapp',
  ]);
  await adb.reverse(41118, 41118);
  assert.deepEqual([...(await adb.reverses())], [[41118, 41118]]);
  assert.equal(await adb.nightMode(), 'dark');
  await adb.setLocation({ latitude: 37.3349, longitude: -122.009 });
  await adb.install('/tmp/app.apk');
  for (const run of runs) {
    assert.equal(run[0], '/sdk/platform-tools/adb');
    assert.deepEqual(run.slice(1, 3), ['-s', 'emulator-5584'], run.join(' '));
  }
  const start = runs[0] ?? [];
  assert.deepEqual(start.slice(3, 4), ['shell']);
  assert.equal(start.length, 5);
  assert.equal(
    start[4],
    "am start -W -a android.intent.action.VIEW -d 'expoexample://expo-development-client/?url=http%3A%2F%2Flocalhost%3A41118' --es apiBaseUrl http://localhost:41218 com.example.expoapp",
  );
  assert.deepEqual(runs.find(r => r.includes('geo'))?.slice(3), ['emu', 'geo', 'fix', '-122.009', '37.3349']);
  assert.equal(deviceCommand(['echo', "it's & more"]), "echo 'it'\\''s & more'");
});

test('a failed am start is an error even when adb exits 0', async () => {
  const exec: Exec = () =>
    Promise.resolve({
      code: 0,
      stdout: 'Starting: Intent { act=android.intent.action.VIEW }\nError: Activity not started, unable to resolve Intent\n',
      stderr: '',
    });
  const adb = createAdbTools('emulator-5584', { adb: 'adb', exec });
  await assert.rejects(adb.start(['-a', 'android.intent.action.VIEW', '-d', 'nope://x']), /unable to resolve Intent/);
});

test('hygiene on an emulator sets the location, the appearance and animations off, and reads back what it can', async () => {
  const adb = new FakeAdb('emulator-5584');
  const report = await applyAndroidHygiene(adb, { location: { latitude: 32.07, longitude: 34.78 }, appearance: 'dark' });
  assert.deepEqual(
    report.steps.map(s => [s.step, s.ok, s.changed]),
    [
      ['location', true, true],
      ['appearance', true, true],
      ['animations', true, true],
    ],
  );
  assert.deepEqual(adb.location, { latitude: 32.07, longitude: 34.78 });
  assert.equal(adb.night, 'dark');
  for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    assert.equal(adb.globals.get(key), '0');
  }
  assert.match(report.steps[0]?.after ?? '', /can't read its GPS fix back/);

  const again = await applyAndroidHygiene(adb, { appearance: 'dark' });
  assert.deepEqual(
    again.steps.filter(s => s.step !== 'location').map(s => s.changed),
    [false, false],
  );
  const check = await checkAndroidHygiene(adb, { appearance: 'dark' });
  assert.equal(check.ok, true);
  assert.equal((await checkAndroidHygiene(adb, { appearance: 'light' })).ok, false);
});

test('hygiene fails, naming the step, when the appearance does not read back', async () => {
  const adb = new FakeAdb('emulator-5584');
  adb.stickyNight = true;
  await assert.rejects(applyAndroidHygiene(adb, { appearance: 'dark' }), (error: unknown) => {
    assert.ok(error instanceof HygieneError);
    assert.match(error.message, /appearance reads back light, not dark/);
    return true;
  });
});

test('the dev client opens in one VIEW intent carrying the link and the launch arguments as string extras', async () => {
  const adb = new FakeAdb('emulator-5584');
  adb.installed.set('com.example.expoapp', ['/data/app/base.apk']);
  adb.running.add('com.example.expoapp');
  const report = await launchAndroidDevClient(adb, {
    pkg: 'com.example.expoapp',
    scheme: 'expoexample',
    port: 41118,
    launchArgs: ['-apiBaseUrl', 'http://localhost:41218'],
  });
  assert.deepEqual(report.intent, [
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'expoexample://expo-development-client/?url=http%3A%2F%2Flocalhost%3A41118',
    '--es',
    'apiBaseUrl',
    'http://localhost:41218',
    'com.example.expoapp',
  ]);
  assert.deepEqual(adb.calls.slice(0, 2), ['force-stop com.example.expoapp', `am start ${report.intent.join(' ')}`]);
  assert.equal(adb.running.has('com.example.expoapp'), true);
  assert.deepEqual(intentExtras(['--a', '1', '-b']), ['--es', 'a', '1']);
});

test('a launch refuses an app that is not installed, before touching the emulator', async () => {
  const adb = new FakeAdb('emulator-5584');
  await assert.rejects(
    launchAndroidDevClient(adb, { pkg: 'com.example.expoapp', scheme: 'expoexample', port: 41118 }),
    /com\.example\.expoapp is not installed on emulator-5584/,
  );
  assert.deepEqual(adb.calls, []);
  adb.installed.set('com.example.expoapp', ['/data/app/base.apk']);
  const report = await launchAndroidApp(adb, { pkg: 'com.example.expoapp', launchArgs: ['-apiBaseUrl', 'x'] });
  assert.deepEqual(report.intent, ['-n', 'com.example.expoapp/.MainActivity', '--es', 'apiBaseUrl', 'x']);
});

test('ensureReverse adds only the missing rules and reads every wanted rule back', async () => {
  const adb = new FakeAdb('emulator-5584');
  adb.reverseRules.set(41118, 41118);
  const report = await ensureReverse(
    adb,
    new Map([
      [41118, 41118],
      [41218, 41218],
    ]),
  );
  assert.deepEqual(report.added, [41218]);
  assert.deepEqual(adb.calls, ['reverse tcp:41218 tcp:41218']);
  const broken = new FakeAdb('emulator-5582');
  broken.reverse = () => Promise.resolve();
  await assert.rejects(ensureReverse(broken, new Map([[41118, 41118]])), /reads back without tcp:41118 -> tcp:41118/);
});
