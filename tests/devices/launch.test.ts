import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  devClientLink,
  launchApp,
  launchDevClient,
  DevClientError,
  ensureSchemeApproval,
  readSchemeApproval,
  schemeApprovalFile,
} from '../../src/devices/index.ts';
import { FakeSim, UDID } from './fake.ts';

const BUNDLE = 'dev.example.app';
const SCHEME = 'exampleapp';
const KEY = 'com.apple.CoreSimulator.CoreSimulatorBridge-->exampleapp';

function setup() {
  const sim = new FakeSim();
  const device = sim.addDevice();
  const app = sim.install(BUNDLE);
  return { sim, device, app };
}

test('devClientLink builds the Expo dev-client deep link with the Metro URL encoded', () => {
  assert.equal(
    devClientLink({ scheme: SCHEME, port: 8090 }),
    'exampleapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8090',
  );
  assert.equal(
    devClientLink({ scheme: 'com.example.app', port: 19000, host: '127.0.0.1' }),
    'com.example.app://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A19000',
  );
  assert.throws(() => devClientLink({ scheme: '1bad', port: 8090 }), /'1bad' is not a URL scheme/);
  assert.throws(() => devClientLink({ scheme: SCHEME, port: 70000 }), /70000 is not a TCP port/);
});

test("ensureSchemeApproval writes the approval into the simulator's own plist and reads it back", async () => {
  const { sim } = setup();

  const report = await ensureSchemeApproval(sim, { udid: UDID, scheme: SCHEME, bundleId: BUNDLE });

  const file = schemeApprovalFile(`/sim/Devices/${UDID}/data`);
  assert.equal(file, `/sim/Devices/${UDID}/data/Library/Preferences/com.apple.launchservices.schemeapproval.plist`);
  assert.deepEqual(report, { file, key: KEY, before: undefined, readBack: BUNDLE, changed: true, needsReboot: true });
  assert.equal(sim.plists.get(file)?.get(KEY), BUNDLE);
  assert.equal(await readSchemeApproval(sim, UDID, SCHEME), BUNDLE);
});

test('a second ensureSchemeApproval changes nothing', async () => {
  const { sim } = setup();
  await ensureSchemeApproval(sim, { udid: UDID, scheme: SCHEME, bundleId: BUNDLE });
  sim.calls.length = 0;

  const report = await ensureSchemeApproval(sim, { udid: UDID, scheme: SCHEME, bundleId: BUNDLE });

  assert.equal(report.changed, false);
  assert.deepEqual(sim.mutations(), []);
});

test('an approval held by another bundle id is replaced', async () => {
  const { sim } = setup();
  sim.plists.set(sim.approvalFile(), new Map([[KEY, 'dev.other.app']]));

  const report = await ensureSchemeApproval(sim, { udid: UDID, scheme: SCHEME, bundleId: BUNDLE });

  assert.equal(report.before, 'dev.other.app');
  assert.equal(report.readBack, BUNDLE);
});

test('an approval that does not read back fails loudly', async () => {
  const { sim } = setup();
  sim.faults.add('plist');

  await assert.rejects(ensureSchemeApproval(sim, { udid: UDID, scheme: SCHEME, bundleId: BUNDLE }), (error: unknown) => {
    assert.ok(error instanceof DevClientError);
    assert.match(error.message, /scheme approval in .* reads back 'nothing', not dev.example.app/);
    return true;
  });
});

test('an approval written before the first boot needs no reboot', async () => {
  const sim = new FakeSim();
  sim.addDevice(UDID, 'Shutdown');

  const report = await ensureSchemeApproval(sim, { udid: UDID, scheme: SCHEME, bundleId: BUNDLE });

  assert.equal(report.changed, true);
  assert.equal(report.needsReboot, false);
});

test('launchApp relaunches the app with its launch arguments and waits for it to run', async () => {
  const { sim, app } = setup();
  app.running = true;

  const report = await launchApp(sim, { udid: UDID, bundleId: BUNDLE, launchArgs: ['-apiBaseUrl', 'http://localhost:5010'] });

  assert.deepEqual(report, { bundleId: BUNDLE, args: ['-apiBaseUrl', 'http://localhost:5010'], running: true });
  assert.deepEqual(app.launchArgs, ['-apiBaseUrl', 'http://localhost:5010']);
  assert.deepEqual(
    sim.mutations().map(call => call.split(' ')[0]),
    ['terminate', 'launch'],
  );
});

test('launchDevClient passes the Metro URL as --initialUrl ahead of the other launch arguments', async () => {
  const { sim, app } = setup();

  const report = await launchDevClient(sim, {
    udid: UDID,
    bundleId: BUNDLE,
    port: 8090,
    launchArgs: ['-apiBaseUrl', 'http://localhost:5010'],
  });

  assert.equal(report.initialUrl, 'http://localhost:8090');
  assert.deepEqual(app.launchArgs, ['--initialUrl', 'http://localhost:8090', '-apiBaseUrl', 'http://localhost:5010']);
  assert.equal(report.running, true);
  assert.deepEqual(sim.plists.size, 0, 'the launch-argument path needs no scheme approval');
  assert.ok(!sim.calls.some(call => call.startsWith('shutdown') || call.startsWith('openUrl')));
});

test('a launch that never comes up fails loudly with the arguments it used', async () => {
  const { sim } = setup();
  sim.crashesOnLaunch = true;

  await assert.rejects(
    launchDevClient(sim, { udid: UDID, bundleId: BUNDLE, port: 8090, launchAttempts: 3, launchPollMs: 100 }),
    (error: unknown) => {
      assert.ok(error instanceof DevClientError);
      assert.match(
        error.message,
        /dev.example.app is not running on .* after launching it with \[--initialUrl http:\/\/localhost:8090\]/,
      );
      return true;
    },
  );
  assert.equal(sim.calls.filter(call => call === 'sleep 100').length, 3);
});

test('launchApp refuses an app that is not installed or a simulator that is not booted', async () => {
  const sim = new FakeSim();
  sim.addDevice();
  await assert.rejects(launchApp(sim, { udid: UDID, bundleId: BUNDLE }), /is not installed/);
  sim.get(UDID).info.state = 'Shutdown';
  await assert.rejects(launchDevClient(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 }), /is Shutdown, not Booted/);
  assert.deepEqual(sim.mutations(), []);
});
