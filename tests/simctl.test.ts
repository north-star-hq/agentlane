import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DeviceBackendError, DeviceRunningError } from '../src/devices/backend.ts';
import { newestIphone, parseDeviceList, resolveSimSpec, simctl, simctlBackend, SimctlTimeout } from '../src/devices/simctl.ts';
import { UsageError } from '../src/registry/refusal.ts';
import { fakeXcrun, xcrunsOn } from './support/fake-xcrun.ts';
import { CATALOG, tempDir } from './support/fakes.ts';
import { useOwnerFolders } from './support/isolate.ts';
import { isolatedEnv, withProcessEnv } from './support/isolated-env.ts';

const LIVE = process.env.AGENTLANE_LIVE_SIMCTL === '1';

test('the default spec is the newest installed iOS runtime and the plain model of its newest iPhone', () => {
  const spec = resolveSimSpec(CATALOG, {});
  assert.deepEqual(spec, {
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
    deviceTypeName: 'iPhone 17',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    runtimeName: 'iOS 26.5',
  });
  assert.equal(newestIphone([{ identifier: 'a', name: 'iPhone 16 Pro', productFamily: 'iPhone' }])?.name, 'iPhone 16 Pro');
});

test('flags pick a device type and runtime by name, identifier or version, and a wrong one lists the choices', () => {
  assert.equal(resolveSimSpec(CATALOG, { deviceType: 'iphone 17 pro' }).deviceTypeName, 'iPhone 17 Pro');
  assert.equal(resolveSimSpec(CATALOG, { runtime: '26.1' }).runtimeName, 'iOS 26.1');
  assert.equal(
    resolveSimSpec(CATALOG, { runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-1', deviceType: 'iPhone 16' }).deviceTypeName,
    'iPhone 16',
  );
  assert.throws(
    () => resolveSimSpec(CATALOG, { deviceType: 'iPhone 3G' }),
    (e: unknown) => e instanceof UsageError && e.fix.includes('iPhone 17 Pro'),
  );
  assert.throws(
    () => resolveSimSpec(CATALOG, { runtime: 'iOS 12.0' }),
    (e: unknown) => e instanceof UsageError && e.fix.includes('iOS 26.5'),
  );
  assert.throws(() => resolveSimSpec([], {}), UsageError);
});

test('the device list keeps iOS simulators with their runtime, type and boot state', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        {
          udid: 'U1',
          name: 'agentlane-pool-aaaaaa',
          state: 'Booted',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
          dataPath: '/Users/me/Library/Developer/CoreSimulator/Devices/U1/data',
          dataPathSize: 3810119680,
        },
        {
          udid: 'U2',
          name: 'by hand',
          state: 'Shutdown',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        },
        { udid: 'U3', name: 'agentlane-pool-bbbbbb', state: 'Shutting Down' },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W1', name: 'watch', state: 'Booted' }],
    },
  });
  assert.deepEqual(parseDeviceList(json), [
    {
      id: 'U1',
      name: 'agentlane-pool-aaaaaa',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      booted: true,
      stopped: false,
      disk: { paths: ['/Users/me/Library/Developer/CoreSimulator/Devices/U1'], bytes: 3810119680 },
    },
    {
      id: 'U2',
      name: 'by hand',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      booted: false,
      stopped: true,
    },
    {
      id: 'U3',
      name: 'agentlane-pool-bbbbbb',
      deviceType: '',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      booted: false,
      stopped: false,
    },
  ]);
});

test('a delete that must not stop the simulator deletes it only when simctl lists it as Shutdown', async () => {
  const root = tempDir('simctl-refuse');
  try {
    const xcrun = fakeXcrun(path.join(root, 'xcrun'));
    await withProcessEnv({ ...isolatedEnv(root), PATH: xcrun.searchPath }, () => {
      assert.deepEqual(xcrunsOn(process.env.PATH ?? ''), [path.join(xcrun.bin, 'xcrun')]);
      for (const state of ['Booted', 'Booting', 'Shutting Down', 'Creating', 'A State simctl Adds Later']) {
        const udid = randomUUID().toUpperCase();
        xcrun.set([{ udid, name: 'agentlane-pool-aaaaaa', state }]);
        assert.throws(
          () => {
            simctlBackend.delete(udid, 'refuse');
          },
          DeviceRunningError,
          state,
        );
      }
      assert.deepEqual(xcrun.deleted(), []);
      const udid = randomUUID().toUpperCase();
      xcrun.set([{ udid, name: 'agentlane-pool-aaaaaa', state: 'Shutdown' }]);
      simctlBackend.delete(udid, 'refuse');
      assert.deepEqual(xcrun.deleted(), [udid]);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fake xcrun that can't run fails the call instead of reaching any other xcrun", async () => {
  const root = tempDir('simctl-broken-fake');
  try {
    const xcrun = fakeXcrun(path.join(root, 'xcrun'));
    const fake = path.join(xcrun.bin, 'xcrun');
    fs.chmodSync(fake, 0o644);
    await withProcessEnv({ ...isolatedEnv(root), PATH: xcrun.searchPath }, () => {
      assert.deepEqual(xcrunsOn(process.env.PATH ?? ''), [fake]);
      assert.throws(() => simctlBackend.list(), DeviceBackendError);
      assert.throws(() => {
        simctlBackend.delete(randomUUID().toUpperCase(), 'refuse');
      }, DeviceBackendError);
    });
    assert.deepEqual(xcrun.deleted(), []);
    assert.equal(fs.existsSync(path.join(root, 'xcrun', 'calls')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a simctl call that runs past its time limit names the command and the limit, and a silent failure keeps its reason', async () => {
  const root = tempDir('simctl-slow');
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'xcrun'),
      '#!/bin/sh\nif [ "$2" = slow ]; then exec /bin/sleep 5; fi\nif [ "$2" = killed ]; then kill -TERM $$; fi\nexit 3\n',
      {
        mode: 0o755,
      },
    );
    await withProcessEnv({ ...isolatedEnv(root), PATH: bin }, () => {
      const began = Date.now();
      assert.throws(
        () => simctl(['slow', '-j', 'runtimes'], 1000),
        (e: unknown) => e instanceof SimctlTimeout && e.message === "xcrun simctl slow -j runtimes didn't finish within 1 s",
      );
      assert.ok(Date.now() - began < 4000);
      assert.throws(
        () => simctl(['list', '-j', 'runtimes']),
        (e: unknown) =>
          e instanceof DeviceBackendError &&
          !(e instanceof SimctlTimeout) &&
          e.message === 'xcrun simctl list -j runtimes failed (exit status 3) with nothing on stderr',
      );
      assert.throws(
        () => simctl(['killed']),
        (e: unknown) =>
          e instanceof DeviceBackendError && e.message === 'xcrun simctl killed failed (signal SIGTERM) with nothing on stderr',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'live simctl: the defaults resolve on this Mac and the list sees every simulator',
  { skip: !LIVE && 'set AGENTLANE_LIVE_SIMCTL=1 to run against xcrun simctl' },
  t => {
    useOwnerFolders(t);
    const spec = simctlBackend.resolveSpec({});
    assert.match(spec.deviceTypeName, /^iPhone \d+/);
    assert.match(spec.runtimeName, /^iOS \d+/);
    const listed = simctlBackend.list();
    assert.ok(listed.length > 0);
    for (const d of listed) assert.match(d.id, /^[0-9A-F-]{36}$/);
  },
);
