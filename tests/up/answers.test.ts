import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { systemClock } from '../../src/clock.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import type { Toolchain } from '../../src/up/preflight.ts';
import { rememberAnswers } from '../../src/up/answers.ts';
import { FakeSim, OTHER_UDID, UDID } from '../devices/fake.ts';
import { FakeDevices, tempDir } from '../support/fakes.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function deps(): { deps: EnvDeps; sim: FakeSim; devices: FakeDevices; asked: string[] } {
  const asked: string[] = [];
  const sim = new FakeSim();
  sim.addDevice(UDID, 'Shutdown');
  sim.addDevice(OTHER_UDID, 'Booted');
  const root = tempDir('answers');
  roots.push(root);
  const devices = new FakeDevices(path.join(root, 'devices'));
  const resolveSpec = devices.resolveSpec.bind(devices);
  devices.resolveSpec = request => {
    asked.push('runtimes');
    return resolveSpec(request);
  };
  const tools: Toolchain = {
    xcodeVersion: () => Promise.resolve('Xcode 26.6 Build version 17F42'),
    androidToolchain: () => Promise.resolve('android'),
    localeCharmap: () => Promise.resolve('UTF-8'),
    findJava17: () => Promise.resolve({ home: '/jdk17', version: '17.0.20' }),
  };
  return {
    sim,
    devices,
    asked,
    deps: {
      env: { JAVA_HOME: '/jdk17' },
      cwd: '/',
      log: () => undefined,
      processes: { info: () => undefined, startTimes: () => new Map(), children: () => [] } as unknown as EnvDeps['processes'],
      ports: {} as EnvDeps['ports'],
      devices: { ios: devices },
      sim,
      system: {} as EnvDeps['system'],
      toolchain: {
        ...tools,
        xcodeVersion: () => {
          asked.push('xcodebuild -version');
          return tools.xcodeVersion();
        },
        findJava17: env => {
          asked.push(`java search ${env.JAVA_HOME ?? ''}`);
          return tools.findJava17(env);
        },
      },
      startDriver: () => Promise.resolve(),
      clock: systemClock,
    },
  };
}

const states = (sim: FakeSim) => sim.calls.filter(c => c.startsWith('device '));

test('a simulator booted through the remembered tools reads back Booted, and its state is asked again only then', async () => {
  const { deps: given, sim } = deps();
  const remembered = rememberAnswers(given).deps;
  const tools = remembered.sim;
  assert.ok(tools);
  assert.equal((await tools.device(UDID))?.state, 'Shutdown');
  assert.equal((await tools.device(UDID))?.state, 'Shutdown');
  assert.equal(states(sim).length, 1);
  await tools.boot(UDID);
  assert.equal((await tools.device(UDID))?.state, 'Booted');
  assert.equal((await tools.device(UDID))?.state, 'Booted');
  assert.equal(states(sim).length, 2);
  await tools.shutdown(OTHER_UDID);
  assert.equal((await tools.device(OTHER_UDID))?.state, 'Shutdown');
  assert.equal((await tools.device(UDID))?.state, 'Booted');
  assert.equal(states(sim).length, 4);
});

const CREATED = '7B0E1F22-3C4D-4E5F-8A9B-0C1D2E3F4A5B';

test('a device the remembered backend creates is there for the next step that reads it', async () => {
  const { deps: given, sim, devices } = deps();
  const create = devices.create.bind(devices);
  devices.create = (name, spec) => {
    create(name, spec);
    sim.addDevice(CREATED, 'Shutdown', name);
    return CREATED;
  };
  const remembered = rememberAnswers(given).deps;
  const tools = remembered.sim;
  const backend = remembered.devices.ios;
  assert.ok(tools && backend);
  assert.equal(await tools.device(CREATED), undefined);
  assert.equal(backend.create('pool-1', backend.resolveSpec({})), CREATED);
  assert.equal((await tools.device(CREATED))?.state, 'Shutdown');
});

test('a device create that finishes later still makes the state read during it be asked again', async () => {
  const { deps: given, sim, devices } = deps();
  const { promise: created, resolve: finish } = Promise.withResolvers<undefined>();
  devices.create = ((name: string) =>
    created.then(() => {
      sim.addDevice(CREATED, 'Shutdown', name);
      return CREATED;
    })) as unknown as typeof devices.create;
  const remembered = rememberAnswers(given).deps;
  const tools = remembered.sim;
  const backend = remembered.devices.ios;
  assert.ok(tools && backend);
  const creating = backend.create('pool-1', backend.resolveSpec({})) as unknown as Promise<string>;
  assert.equal(await tools.device(CREATED), undefined);
  finish(undefined);
  assert.equal(await creating, CREATED);
  assert.equal((await tools.device(CREATED))?.state, 'Shutdown');
});

test('a backend member the remembered backend does not know passes through to the backend', () => {
  const { deps: given, devices } = deps();
  const extra = Object.assign(devices, { disk: (id: string) => `disk of ${id}` });
  const backend = rememberAnswers({ ...given, devices: { ios: extra } }).deps.devices.ios as typeof extra | undefined;
  assert.equal(backend?.disk(UDID), `disk of ${UDID}`);
  assert.equal(backend.platform, 'ios');
});

test("forgetting the devices' states makes the next read ask again, so it sees a simulator that stopped since", async () => {
  const { deps: given, sim } = deps();
  const { deps: remembered, forgetDeviceStates } = rememberAnswers(given);
  const tools = remembered.sim;
  assert.ok(tools);
  assert.equal((await tools.device(OTHER_UDID))?.state, 'Booted');
  const info = sim.devices.get(OTHER_UDID)?.info;
  assert.ok(info);
  info.state = 'Shutdown';
  assert.equal((await tools.device(OTHER_UDID))?.state, 'Booted');
  forgetDeviceStates();
  assert.equal((await tools.device(OTHER_UDID))?.state, 'Shutdown');
  assert.equal(states(sim).length, 2);
});

test('a remembered answer is a copy, so a caller changing it does not change what the next caller reads', async () => {
  const { deps: given } = deps();
  const tools = rememberAnswers(given).deps.sim;
  assert.ok(tools);
  const first = await tools.device(UDID);
  assert.ok(first);
  first.state = 'Booted';
  assert.equal((await tools.device(UDID))?.state, 'Shutdown');
});

test('device specs, the Xcode version and the Java search are asked once per up, and again by the next up', async () => {
  const { deps: given, asked, devices } = deps();
  for (let run = 0; run < 2; run++) {
    const remembered = rememberAnswers(given).deps;
    const backend = remembered.devices.ios;
    assert.ok(backend);
    assert.deepEqual(backend.resolveSpec({}), devices.resolveSpec({}));
    backend.resolveSpec({});
    await remembered.toolchain.xcodeVersion();
    await remembered.toolchain.xcodeVersion();
    await remembered.toolchain.findJava17(given.env);
    await remembered.toolchain.findJava17({ ...given.env });
    await remembered.toolchain.findJava17({ JAVA_HOME: '/other' });
  }
  const once = ['runtimes', 'runtimes', 'xcodebuild -version', 'java search /jdk17', 'java search /other'];
  assert.deepEqual(asked, [...once, ...once]);
});

test('a question that failed is asked again rather than remembered', async () => {
  const { deps: given } = deps();
  let calls = 0;
  const remembered = rememberAnswers({
    ...given,
    toolchain: {
      ...given.toolchain,
      xcodeVersion: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error('xcodebuild -version failed')) : Promise.resolve('Xcode 26.6');
      },
    },
  }).deps;
  await assert.rejects(remembered.toolchain.xcodeVersion(), /failed/);
  assert.equal(await remembered.toolchain.xcodeVersion(), 'Xcode 26.6');
  assert.equal(calls, 2);
});
