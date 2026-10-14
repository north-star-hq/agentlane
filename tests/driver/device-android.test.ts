import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runDriverCommand, type DriverCliDeps } from '../../src/driver-cli.ts';
import { systemProcesses } from '../../src/processes.ts';
import { FakeAdb } from '../devices/fake-adb.ts';
import { driverWorld, type DriverWorld } from '../support/driver-world.ts';

const PKG = 'com.example.expoapp';
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

interface Cli {
  adb: FakeAdb;
  serials: string[];
  out: string[];
  err: string[];
  device(...args: string[]): Promise<number>;
}

function cli(w: DriverWorld): Cli {
  const serial = w.lane.device?.serial ?? '';
  const adb = new FakeAdb(serial);
  adb.installed.set(PKG, ['/data/app/base.apk']);
  adb.declared.set(
    PKG,
    new Set([
      'android.permission.CAMERA',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
    ]),
  );
  const serials: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: DriverCliDeps = {
    env: { ...w.env, AGENTLANE_STATE_DIR: w.stateDir, AGENTLANE_OWNER_PID: String(w.owner.pid) },
    cwd: w.worktree,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    stdin: new PassThrough(),
    output: new PassThrough(),
    processes: systemProcesses,
    adb: asked => {
      serials.push(asked);
      return adb;
    },
  };
  return { adb, serials, out, err, device: (...args) => runDriverCommand('device', args, deps) };
}

test('device controls on an emulator lane run adb against the claimed serial only, and say what they did', async t => {
  const w = await driverWorld({ platform: 'android' });
  t.after(() => w.close());
  const c = cli(w);
  assert.match(w.lane.device?.serial ?? '', /^emulator-\d+$/);

  assert.equal(await c.device('location', '32.07,34.78'), 0, c.err.join(''));
  assert.deepEqual(c.adb.location, { latitude: 32.07, longitude: 34.78 });
  assert.equal(await c.device('appearance', 'dark'), 0, c.err.join(''));
  assert.equal(c.adb.night, 'dark');
  assert.equal(await c.device('open', 'expoexample://settings'), 0, c.err.join(''));
  assert.deepEqual(c.adb.starts.at(-1), ['-a', 'android.intent.action.VIEW', '-d', 'expoexample://settings']);

  assert.equal(await c.device('permission', 'grant', 'location', PKG), 0, c.err.join(''));
  assert.deepEqual(
    [...(c.adb.granted.get(PKG) ?? [])],
    ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  );
  assert.equal(await c.device('permission', 'reset', 'location', PKG), 0, c.err.join(''));
  assert.equal(c.adb.granted.get(PKG)?.size, 0);
  assert.ok(c.adb.calls.includes(`pm clear-permission-flags ${PKG} android.permission.ACCESS_FINE_LOCATION`));
  assert.equal(await c.device('permission', 'grant', 'all', PKG), 0, c.err.join(''));
  assert.match(c.out.at(-1) ?? '', /doesn't request READ_CALENDAR/);

  assert.deepEqual(new Set(c.serials), new Set([w.lane.device?.serial]));
  assert.deepEqual(c.out.slice(0, 3), [
    'Location set to 32.07,34.78.\n',
    'Appearance is dark.\n',
    'Opened expoexample://settings.\n',
  ]);
});

test('an emulator control that has no adb equivalent refuses, saying why and what to do instead', async t => {
  const w = await driverWorld({ platform: 'android' });
  t.after(() => w.close());
  const c = cli(w);
  const cases: [string[], RegExp][] = [
    [['location', 'clear'], /GPS always has a fix/],
    [['push', PKG, '-'], /no local push/],
    [['clipboard', 'get'], /no shell command for the clipboard/],
    [['permission', 'grant', 'bluetooth', PKG], /services on Android: all, calendar, camera/],
  ];
  for (const [args, message] of cases) {
    c.err.length = 0;
    assert.equal(await c.device(...args), EXIT_USAGE, args.join(' '));
    assert.match(c.err.join(''), message, args.join(' '));
  }
  c.err.length = 0;
  assert.equal(await c.device('permission', 'grant', 'contacts', PKG), EXIT_FAILED);
  assert.match(c.err.join(''), /com\.example\.expoapp requests none of android\.permission\.READ_CONTACTS/);
  assert.deepEqual(
    c.adb.calls.filter(call => !call.startsWith('pm grant')),
    [],
    'a refused control changed the emulator',
  );
});
