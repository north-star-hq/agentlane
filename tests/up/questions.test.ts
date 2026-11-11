import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import type { DeviceBackend } from '../../src/devices/backend.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import type { Toolchain } from '../../src/up/preflight.ts';
import { up } from '../../src/up/up.ts';
import { CONFIG, failures, OPTIONS, toolchain, world, type World } from '../support/up-world.ts';

const CHANGES = new Set(['create', 'delete', 'shutdown', 'boot']);
const QUESTIONS = ['runtimes', 'device list', 'simulator state', 'xcodebuild -version', 'java search', 'read app.json'];

function counts(events: readonly string[]): Record<string, number> {
  return Object.fromEntries(QUESTIONS.map(q => [q, events.filter(e => e === q).length]));
}

function counted(backend: DeviceBackend, events: string[]): DeviceBackend {
  return {
    platform: backend.platform,
    resolveSpec: request => {
      events.push('runtimes');
      return backend.resolveSpec(request);
    },
    list: () => {
      events.push('device list');
      return backend.list();
    },
    create: (name, spec) => {
      events.push('create');
      return backend.create(name, spec);
    },
    delete: id => {
      events.push('delete');
      backend.delete(id);
    },
    shutdown: id => {
      events.push('shutdown');
      backend.shutdown(id);
    },
    boot: (id, consolePort) => {
      events.push('boot');
      return backend.boot(id, consolePort);
    },
  };
}

function counting(t: TestContext, w: World): { deps: EnvDeps; events: string[] } {
  const events: string[] = [];
  const base = w.deps();
  const tools = toolchain();
  const countedTools: Toolchain = {
    ...tools,
    xcodeVersion: () => {
      events.push('xcodebuild -version');
      return tools.xcodeVersion();
    },
    findJava17: env => {
      events.push('java search');
      return tools.findJava17(env);
    },
  };
  const open = fsp.open.bind(fsp);
  const spy = mock.method(fsp, 'open', (file: string, ...rest: []) => {
    events.push(`read ${path.relative(w.project, file)}`);
    return open(file, ...rest);
  });
  t.after(() => {
    spy.mock.restore();
  });
  const devices = Object.fromEntries(
    Object.entries(base.devices).map(([platform, backend]) => [platform, counted(backend, events)]),
  ) as EnvDeps['devices'];
  const { sim } = w;
  const device = sim.device.bind(sim);
  const boot = sim.boot.bind(sim);
  const shutdown = sim.shutdown.bind(sim);
  sim.device = udid => {
    events.push('simulator state');
    return device(udid);
  };
  sim.boot = udid => {
    events.push('boot');
    return boot(udid);
  };
  sim.shutdown = udid => {
    events.push('shutdown');
    return shutdown(udid);
  };
  return {
    deps: {
      ...base,
      env: { ...base.env, AGENTLANE_MAESTRO: '/fake/maestro' },
      devices,
      toolchain: countedTools,
      startDriver: (lane, stateDir, javaHome) => {
        events.push(`driver on ${javaHome ?? 'a JDK it searches for'}`);
        return base.startDriver(lane, stateDir, javaHome);
      },
    },
    events,
  };
}

function stretches(events: readonly string[]): Record<string, number>[] {
  const out: Record<string, number>[] = [{}];
  for (const e of events) {
    if (CHANGES.has(e)) out.push({});
    else if (e === 'device list' || e === 'simulator state') {
      const current = out[out.length - 1] ?? {};
      current[e] = (current[e] ?? 0) + 1;
    }
  }
  return out;
}

const DRIVEN = { ...CONFIG, driver: { flows: '.maestro' } };

const ONE_LIST_PER_TRANSACTION =
  "a new lane's claim lists devices once in each of its two registry transactions: a listing reused across the released write lock would hide other processes' changes";

test("one up on iOS asks each question of the system once, the simulator's state again after it boots it and for the closing doctor, and the device list once in each of the claim's two transactions", async t => {
  const w = world(t);
  w.write(DRIVEN);
  const { deps, events } = counting(t, w);
  const result = await up(deps, OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  assert.equal(result.build?.source, 'build');
  assert.equal(counts(events)['device list'], 2, ONE_LIST_PER_TRANSACTION);
  assert.deepEqual(counts(events), {
    runtimes: 1,
    'device list': 2,
    'simulator state': 3,
    'xcodebuild -version': 1,
    'java search': 1,
    'read app.json': 1,
  });
  assert.deepEqual(
    events.filter(e => CHANGES.has(e)),
    ['create', 'boot'],
  );
  assert.deepEqual(stretches(events), [{ 'device list': 2 }, { 'simulator state': 1 }, { 'simulator state': 2 }]);
  assert.deepEqual(
    events.filter(e => e.startsWith('driver on ')),
    ['driver on /jdk17'],
  );
});

test("the closing doctor reads the simulator's state again, so it reports a simulator that stopped after the launch", async t => {
  const w = world(t);
  w.write(DRIVEN);
  const { deps, events } = counting(t, w);
  let readsBeforeStop = 0;
  const result = await up(
    {
      ...deps,
      startDriver: lane => {
        readsBeforeStop = counts(events)['simulator state'] ?? 0;
        const info = w.sim.devices.get(lane.device?.id ?? '')?.info;
        assert.ok(info, 'the lane holds a simulator');
        info.state = 'Shutdown';
        return Promise.resolve();
      },
    },
    OPTIONS,
  );
  assert.equal(result.doctor.ok, false);
  assert.match(result.doctor.checks.find(c => c.name === 'device')?.detail ?? '', /is Shutdown$/);
  assert.equal(counts(events)['simulator state'], readsBeforeStop + 1);
});

test("a second up on iOS, which changes no device, asks each question once, and the simulator's state again for the closing doctor", async t => {
  const w = world(t);
  w.write(DRIVEN);
  await up(counting(t, w).deps, OPTIONS);
  const { deps, events } = counting(t, w);
  const result = await up(deps, OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  assert.equal(result.build?.source, 'cache');
  assert.deepEqual(counts(events), {
    runtimes: 1,
    'device list': 1,
    'simulator state': 2,
    'xcodebuild -version': 1,
    'java search': 1,
    'read app.json': 1,
  });
  assert.deepEqual(
    events.filter(e => CHANGES.has(e)),
    [],
  );
});

test("one up on Android asks each question of the system once, and the device list once in each of the claim's two transactions", async t => {
  const w = world(t);
  w.write({
    ...DRIVEN,
    app: { ...CONFIG.app, android: { output: 'build/app.apk' } },
    hooks: { ...CONFIG.hooks, build: 'mkdir -p build && printf com.example.fake > build/app.apk' },
  });
  const { deps, events } = counting(t, w);
  const result = await up(deps, { ...OPTIONS, platform: 'android' });
  assert.equal(result.doctor.ok, true, failures(result));
  assert.equal(result.build?.source, 'build');
  assert.equal(counts(events)['device list'], 2, ONE_LIST_PER_TRANSACTION);
  assert.deepEqual(counts(events), {
    runtimes: 1,
    'device list': 2,
    'simulator state': 0,
    'xcodebuild -version': 0,
    'java search': 1,
    'read app.json': 1,
  });
  assert.deepEqual(
    events.filter(e => CHANGES.has(e)),
    ['create', 'boot'],
  );
  assert.deepEqual(stretches(events), [{ 'device list': 2 }, {}, {}]);
});

test('an input the build changes is hashed again, so the build is stored under the key of what was built', async t => {
  const w = world(t);
  w.write({
    ...DRIVEN,
    hooks: { ...CONFIG.hooks, build: `${CONFIG.hooks.build} && printf '{"name":"built"}' > app.json` },
  });
  const { deps, events } = counting(t, w);
  const result = await up(deps, OPTIONS);
  assert.ok(result.build?.source === 'build' && result.build.reason !== 'no-cache-config');
  assert.equal(counts(events)['read app.json'], 2);
  assert.equal(result.build.stored, true);
  assert.notEqual(result.build.storedKey, result.build.key);
  assert.equal(fs.readFileSync(path.join(w.project, 'app.json'), 'utf8'), '{"name":"built"}');
});
