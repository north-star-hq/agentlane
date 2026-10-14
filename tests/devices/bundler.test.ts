import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUNDLER_PIN_KEY,
  BundlerPinError,
  bundlerLocation,
  clearBundlerPin,
  DeviceStateError,
  pinBundler,
  readBundlerPin,
} from '../../src/devices/index.ts';
import { FakeSim, UDID } from './fake.ts';

const BUNDLE = 'dev.example.app';

function setup() {
  const sim = new FakeSim();
  sim.addDevice();
  const app = sim.install(BUNDLE);
  return { sim, app };
}

test('pinBundler writes RCT_jsLocation for the claimed port and reads it back', async () => {
  const { sim, app } = setup();

  const report = await pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 });

  assert.deepEqual(report, {
    udid: UDID,
    bundleId: BUNDLE,
    wanted: 'localhost:8090',
    before: undefined,
    readBack: 'localhost:8090',
    changed: true,
  });
  assert.equal(app.defaults.get(BUNDLER_PIN_KEY), 'localhost:8090');
  assert.equal(await readBundlerPin(sim, UDID, BUNDLE), 'localhost:8090');
});

test('a second pinBundler changes nothing', async () => {
  const { sim } = setup();
  await pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 });
  sim.calls.length = 0;

  const report = await pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 });

  assert.equal(report.changed, false);
  assert.deepEqual(sim.mutations(), []);
});

test('a stale pin from another lane is replaced and reported', async () => {
  const { sim, app } = setup();
  app.defaults.set(BUNDLER_PIN_KEY, 'localhost:8083');

  const report = await pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090, host: '127.0.0.1' });

  assert.equal(report.before, 'localhost:8083');
  assert.equal(report.readBack, '127.0.0.1:8090');
  assert.equal(report.changed, true);
});

test('a pin that reads back wrong fails loudly, naming the fallback port', async () => {
  const { sim, app } = setup();
  app.defaults.set(BUNDLER_PIN_KEY, 'localhost:8083');
  sim.faults.add('app-default');

  await assert.rejects(pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 }), (error: unknown) => {
    assert.ok(error instanceof BundlerPinError);
    assert.match(error.message, /reads back 'localhost:8083', not 'localhost:8090'/);
    assert.match(error.message, /dials port 8081/);
    return true;
  });
});

test('a pin that reads back nothing says so', async () => {
  const { sim } = setup();
  sim.faults.add('app-default');

  await assert.rejects(pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 }), /reads back 'nothing'/);
});

test("pinBundler refuses React Native's fallback port and malformed input before touching the simulator", async () => {
  const { sim } = setup();

  await assert.rejects(
    pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8081 }),
    /refusing to pin dev.example.app to port 8081/,
  );
  await assert.rejects(pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 0 }), /0 is not a TCP port/);
  await assert.rejects(pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090, host: 'a b' }), /'a b' is not a host name/);
  await assert.rejects(pinBundler(sim, { udid: UDID, bundleId: 'not a bundle', port: 8090 }), /is not a bundle id/);
  assert.deepEqual(sim.mutations(), []);
});

test('pinBundler refuses an app that is not installed, since its preferences live in its container', async () => {
  const sim = new FakeSim();
  sim.addDevice();

  await assert.rejects(pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 }), (error: unknown) => {
    assert.ok(error instanceof DeviceStateError);
    assert.match(error.message, /dev.example.app is not installed/);
    return true;
  });
  assert.deepEqual(sim.mutations(), []);
});

test('pinBundler refuses a simulator that is not booted', async () => {
  const sim = new FakeSim();
  sim.addDevice(UDID, 'Shutdown');

  await assert.rejects(pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 }), /is Shutdown, not Booted/);
});

test('clearBundlerPin removes the pin once and then changes nothing', async () => {
  const { sim, app } = setup();
  await pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 });

  assert.deepEqual(await clearBundlerPin(sim, UDID, BUNDLE), { changed: true });
  assert.equal(app.defaults.has(BUNDLER_PIN_KEY), false);
  sim.calls.length = 0;
  assert.deepEqual(await clearBundlerPin(sim, UDID, BUNDLE), { changed: false });
  assert.deepEqual(sim.mutations(), []);
});

test('clearBundlerPin fails when the pin survives the delete', async () => {
  const { sim } = setup();
  await pinBundler(sim, { udid: UDID, bundleId: BUNDLE, port: 8090 });
  sim.faults.add('app-default');

  await assert.rejects(clearBundlerPin(sim, UDID, BUNDLE), /still reads 'localhost:8090'/);
});

test('bundlerLocation formats host and port', () => {
  assert.equal(bundlerLocation(8090), 'localhost:8090');
  assert.equal(bundlerLocation(8090, '[::1]'), '[::1]:8090');
});
