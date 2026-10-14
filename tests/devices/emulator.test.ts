import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DeviceBackendError } from '../../src/devices/backend.ts';
import {
  createEmulatorBackend,
  deviceProfileName,
  findAndroidSdk,
  parseAdbDevices,
  parseRunningEmulators,
  readAvds,
  readSystemImages,
  resolveAndroidSpec,
  sysdirToImage,
} from '../../src/devices/emulator.ts';
import { UsageError } from '../../src/registry/refusal.ts';
import { tempDir } from '../support/fakes.ts';

const LIVE = process.env.AGENTLANE_LIVE_EMULATOR === '1';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fakeSdk(): string {
  const root = tempDir('sdk');
  const image = (api: string, tag: string, abi: string) => {
    write(
      path.join(root, 'system-images', `android-${api}`, tag, abi, 'source.properties'),
      `AndroidVersion.ApiLevel=${api}\nSystemImage.Abi=${abi}\nSystemImage.TagId=${tag}\nSystemImage.TagDisplay=${tag === 'google_apis' ? 'Google APIs' : 'Google Play'}\n`,
    );
  };
  image('34', 'google_apis', 'arm64-v8a');
  image('36', 'google_apis', 'arm64-v8a');
  image('36', 'google_apis_playstore', 'arm64-v8a');
  image('37', 'google_apis', 'x86_64');
  write(path.join(root, 'platform-tools', 'adb'), '');
  write(path.join(root, 'emulator', 'emulator'), '');
  write(path.join(root, 'cmdline-tools', 'latest', 'bin', 'avdmanager'), '');
  return root;
}

test('the default Android spec is pixel_8 on the newest Google APIs image for the CPU, and a wrong runtime lists the choices', () => {
  const images = readSystemImages(fakeSdk());
  assert.equal(images.length, 4);
  const spec = resolveAndroidSpec(images, {}, 'arm64-v8a');
  assert.deepEqual(spec, {
    deviceType: 'pixel_8',
    deviceTypeName: 'Pixel 8',
    runtime: 'system-images;android-36;google_apis;arm64-v8a',
    runtimeName: 'Android API 36 (Google APIs, arm64-v8a)',
  });
  assert.equal(
    resolveAndroidSpec(images, { runtime: '34' }, 'arm64-v8a').runtime,
    'system-images;android-34;google_apis;arm64-v8a',
  );
  assert.equal(
    resolveAndroidSpec(images, { runtime: 'system-images;android-36;google_apis_playstore;arm64-v8a' }, 'arm64-v8a').runtimeName,
    'Android API 36 (Google Play, arm64-v8a)',
  );
  assert.equal(resolveAndroidSpec(images, { deviceType: 'pixel_9_pro' }, 'arm64-v8a').deviceTypeName, 'Pixel 9 Pro');
  assert.throws(
    () => resolveAndroidSpec(images, { runtime: 'android-99' }, 'arm64-v8a'),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /system-images;android-36;google_apis;arm64-v8a/);
      return true;
    },
  );
  assert.throws(() => resolveAndroidSpec([], {}, 'arm64-v8a'), /sdkmanager/);
  assert.throws(() => resolveAndroidSpec(images, { deviceType: 'pixel 8; rm' }, 'arm64-v8a'), UsageError);
  assert.equal(deviceProfileName('medium_phone'), 'Medium Phone');
});

test("the AVD list reads each AVD's device profile and system image from its files", () => {
  const home = tempDir('avd');
  write(path.join(home, 'agentlane-emu-0a1b2c.ini'), `avd.ini.encoding=UTF-8\npath=${home}/agentlane-emu-0a1b2c.avd\n`);
  write(
    path.join(home, 'agentlane-emu-0a1b2c.avd', 'config.ini'),
    'hw.device.name=pixel_8\nimage.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n',
  );
  write(path.join(home, 'my-pixel-api36.ini'), 'path.rel=avd/my-pixel-api36.avd\n');
  write(path.join(home, 'my-pixel-api36.avd', 'config.ini'), 'hw.device.name=pixel_7\n');
  assert.deepEqual(
    readAvds(home).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'agentlane-emu-0a1b2c', deviceType: 'pixel_8', runtime: 'system-images;android-36;google_apis;arm64-v8a' },
      { name: 'my-pixel-api36', deviceType: 'pixel_7', runtime: '' },
    ],
  );
  assert.equal(
    sysdirToImage('system-images/android-35/google_apis/arm64-v8a/'),
    'system-images;android-35;google_apis;arm64-v8a',
  );
  assert.deepEqual(readAvds(path.join(home, 'missing')), []);
});

test('running emulators are read from the process list, with their console port when it was given', () => {
  const running = parseRunningEmulators([
    '/Users/x/Library/Android/sdk/emulator/emulator -avd agentlane-emu-0a1b2c -port 5584 -no-window -no-audio -no-boot-anim',
    '/Users/x/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -netdelay none -avd agentlane-emu-0a1b2c -port 5584',
    '/Users/x/Library/Android/sdk/emulator/emulator @my-pixel-api36',
    '/usr/bin/vim notes-about -avd x',
    'grep -avd',
  ]);
  assert.deepEqual(
    [...running],
    [
      ['agentlane-emu-0a1b2c', 5584],
      ['my-pixel-api36', null],
    ],
  );
  assert.deepEqual(
    parseAdbDevices('List of devices attached\nemulator-5584\tdevice\nemulator-5556\toffline\nR58M123\tdevice\n\n'),
    ['emulator-5584', 'emulator-5556'],
  );
});

test('the emulator backend refuses to boot, stop or delete an AVD it did not create, before running anything', async () => {
  const root = fakeSdk();
  const sdk = findAndroidSdk({ ANDROID_HOME: root, HOME: tempDir('home') });
  assert.ok(sdk);
  assert.equal(sdk.avdmanager, path.join(root, 'cmdline-tools', 'latest', 'bin', 'avdmanager'));
  const backend = createEmulatorBackend({ env: {}, logDir: tempDir('emulator-logs'), sdk });
  for (const name of ['my-pixel-api36', 'agentlane-emu-a', 'agentlane-emu-b', 'agentlane-pool-0a1b2c']) {
    await assert.rejects(backend.boot(name, 5584), DeviceBackendError);
    assert.throws(() => {
      backend.shutdown(name);
    }, DeviceBackendError);
    assert.throws(() => {
      backend.delete(name);
    }, DeviceBackendError);
    assert.throws(() => backend.create(name, backend.resolveSpec({})), DeviceBackendError);
  }
  const missing = createEmulatorBackend({ env: { HOME: tempDir('nosdk') }, logDir: tempDir('emulator-logs'), sdk: null });
  assert.throws(() => missing.resolveSpec({}), UsageError);
});

test(
  'live emulator: the defaults resolve on this Mac and the list sees every AVD',
  { skip: !LIVE && 'set AGENTLANE_LIVE_EMULATOR=1 to run against the Android SDK' },
  () => {
    const backend = createEmulatorBackend({ env: process.env, logDir: tempDir('emulator-logs') });
    const spec = backend.resolveSpec({});
    assert.equal(spec.deviceType, 'pixel_8');
    assert.match(spec.runtime, /^system-images;android-\d+(\.\d+)?;google_apis;(arm64-v8a|x86_64)$/);
    const names = backend.list().map(d => d.name);
    assert.ok(names.length > 0, 'at least one AVD on this Mac');
  },
);
