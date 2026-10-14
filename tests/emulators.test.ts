import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneVariables } from '../src/hooks/env.ts';
import { HOUR_MS, parseConfig, withProjectBlocks } from '../src/registry/config.ts';
import type { Owner } from '../src/registry/owner.ts';
import { UsageError } from '../src/registry/refusal.ts';
import type { LaneRequest } from '../src/registry/types.ts';
import type { World } from './support/world.ts';
import { world } from './support/world.ts';

const ANDROID = { device: { platform: 'android' } } as const;
const KILL = (serial: string) => [`force-stop dev.mobile.maestro ${serial}`, `emu kill ${serial}`];

function android(w: World, owner: Owner, folder: string, extra: Partial<LaneRequest> = {}): LaneRequest {
  return w.request(owner, w.folder(folder), { ...ANDROID, ...extra });
}

test('an Android lane creates a registry AVD from the newest Google APIs image and boots it on its own console port', async () => {
  const w = world();
  try {
    const out = await w.registry().claim(android(w, w.procs.owner(), 'a'));
    const device = out.lane.device;
    assert.ok(device);
    assert.match(device.name, /^agentlane-emu-[0-9a-f]{6}$/);
    assert.equal(device.id, device.name);
    assert.equal(device.deviceType, 'pixel_8');
    assert.equal(device.runtime, 'system-images;android-36;google_apis;arm64-v8a');
    assert.equal(device.serial, 'emulator-5584');
    assert.deepEqual(w.emulators.calls, [`create ${device.name}`, `boot ${device.name} on 5584`]);
    assert.equal(w.emulators.list()[0]?.serial, 'emulator-5584');
    assert.deepEqual(w.devices.calls, [], 'an Android lane never touches a simulator');
    const vars = laneVariables(out.lane, null, null);
    assert.equal(vars.AGENTLANE_PLATFORM, 'android');
    assert.equal(vars.AGENTLANE_DEVICE, 'emulator-5584');
    assert.equal(vars.AGENTLANE_EMULATOR_PORT, '5584');
  } finally {
    w.close();
  }
});

test('two Android lanes get two emulators on distinct port pairs, skipping pairs where anything listens', async () => {
  const w = world();
  try {
    w.probe.busy.add(5585);
    const a = await w.registry().claim(android(w, w.procs.owner(), 'a'));
    const b = await w.registry().claim(android(w, w.procs.owner(), 'b'));
    assert.deepEqual([a.lane.device?.serial, b.lane.device?.serial], ['emulator-5582', 'emulator-5580']);
    assert.notEqual(a.lane.device?.id, b.lane.device?.id);
    assert.deepEqual(
      w.emulators
        .list()
        .map(d => d.serial)
        .sort(),
      ['emulator-5580', 'emulator-5582'],
    );
  } finally {
    w.close();
  }
});

test('AVDs the registry did not create are never booted, stopped or adopted, even ones named like the pool', async () => {
  const w = world({ emulatorPoolSize: 1 });
  try {
    w.emulators.addByHand('my-pixel-api36', true, undefined, 5554);
    w.emulators.addByHand('agentlane-emu-a', false);
    w.emulators.addByHand('agentlane-emu-b', true, undefined, 5556);
    w.probe.busy.add(5554).add(5555).add(5556).add(5557);
    const owner = w.procs.owner();
    const out = await w.registry().claim(android(w, owner, 'a'));
    assert.match(out.lane.device?.name ?? '', /^agentlane-emu-[0-9a-f]{6}$/);
    w.registry().releaseOwn(owner, null);
    const strict = { device: { platform: 'android', deviceType: 'pixel_9', strict: true } } as const;
    const replaced = await w.registry().claim(android(w, w.procs.owner(), 'b', strict));
    assert.equal(replaced.lane.device?.deviceType, 'pixel_9');
    assert.ok(w.emulators.calls.includes(`delete ${out.lane.device?.id ?? ''}`));
    const foreign = ['my-pixel-api36', 'agentlane-emu-a', 'agentlane-emu-b'];
    for (const call of w.emulators.calls) for (const name of foreign) assert.ok(!call.split(' ').includes(name), call);
    assert.deepEqual(
      w.emulators
        .all()
        .filter(d => foreign.includes(d.name))
        .map(d => [d.name, d.booted]),
      [
        ['agentlane-emu-a', false],
        ['agentlane-emu-b', true],
        ['my-pixel-api36', true],
      ].sort(),
    );
    assert.deepEqual(
      w
        .registry()
        .status()
        .pool.map(p => p.name)
        .filter(n => foreign.includes(n)),
      [],
    );
  } finally {
    w.close();
  }
});

test("release force-stops Maestro's driver before it stops the emulator, and frees the port pair", async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const out = await w.registry().claim(android(w, owner, 'a'));
    const serial = out.lane.device?.serial ?? '';
    w.registry().releaseOwn(owner, out.lane.worktree);
    assert.deepEqual(w.emulators.calls.slice(-2), KILL(serial));
    assert.equal(w.emulators.all()[0]?.booted, false);
    const again = await w.registry().claim(android(w, w.procs.owner(), 'b'));
    assert.equal(again.lane.device?.id, out.lane.device?.id);
    assert.equal(again.lane.device?.serial, serial);
  } finally {
    w.close();
  }
});

test("the sweep stops a dead owner's emulator the same way, and leaves a can't-tell owner's emulator running", async () => {
  const w = world();
  try {
    const dead = w.procs.owner();
    const gone = await w.registry().claim(android(w, dead, 'dead'));
    const thread: Owner = { kind: 'codex', process: null, sessionId: null, threadId: 't-emu' };
    const unknown = await w.registry().claim(android(w, thread, 'unknown'));
    w.procs.kill(dead.process?.pid ?? 0);
    const next = await w.registry().claim(w.request(w.procs.owner(), w.folder('next'), { device: null, services: [] }));
    assert.deepEqual(
      next.freed.map(f => [f.id, f.reason]),
      [[gone.lane.id, 'dead']],
    );
    assert.deepEqual(w.emulators.calls.slice(-2), KILL(gone.lane.device?.serial ?? ''));
    const left = w.emulators.all().find(d => d.id === unknown.lane.device?.id);
    assert.equal(left?.booted, true);
    assert.equal(
      w.emulators.calls.some(c => c.endsWith(unknown.lane.device?.serial ?? '?')),
      false,
    );
  } finally {
    w.close();
  }
});

test('the same session claiming again keeps its emulator and port without a restart', async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const first = await w.registry().claim(android(w, owner, 'a'));
    const again = await w.registry().claim(w.request(owner, first.lane.worktree, ANDROID));
    assert.equal(again.lane.id, first.lane.id);
    assert.equal(again.lane.device?.serial, first.lane.device?.serial);
    assert.equal(w.emulators.calls.filter(c => c.startsWith('emu kill')).length, 0);
  } finally {
    w.close();
  }
});

test('an idle emulator taken over is restarted on the new lane port, which stops the old holder driver', async () => {
  const w = world({ emulatorPoolSize: 1 });
  try {
    const old = await w.registry().claim(android(w, w.procs.owner(), 'old'));
    await w.clock.advance(3 * HOUR_MS);
    const taker = await w.registry().claim(android(w, w.procs.owner(), 'taker'));
    assert.deepEqual(
      taker.tookOver.map(e => e.id),
      [old.lane.id],
    );
    assert.equal(taker.lane.device?.id, old.lane.device?.id);
    assert.notEqual(taker.lane.device?.serial, old.lane.device?.serial);
    assert.deepEqual(w.emulators.calls.slice(-3), [
      `boot ${taker.lane.device?.id ?? ''} on ${taker.lane.device?.serial?.slice('emulator-'.length) ?? ''}`,
      ...KILL(old.lane.device?.serial ?? ''),
    ]);
    assert.equal(w.emulators.list()[0]?.serial, taker.lane.device?.serial);
  } finally {
    w.close();
  }
});

test('simulators and emulators share one memory budget, and each kind keeps its own count', async () => {
  const w = world({ memoryBudgetMb: 8000, emulatorPoolSize: 1 });
  try {
    const sim = await w.registry().claim(w.request(w.procs.owner(), w.folder('sim')));
    const emuOwner = w.procs.owner();
    const emu = await w.registry().claim(android(w, emuOwner, 'emu'));
    assert.ok(sim.lane.device && emu.lane.device);
    await assert.rejects(w.registry().claim(w.request(w.procs.owner(), w.folder('sim2'))), (error: Error) => {
      assert.match(error.message, /no pool simulator is free/);
      assert.match(error.message, /7\.4 GB of the 8 GB memory budget in use/);
      assert.match(error.message, new RegExp(emu.lane.worktree));
      return true;
    });
    w.registry().releaseOwn(emuOwner, null);
    const sim2 = await w.registry().claim(w.request(w.procs.owner(), w.folder('sim2')));
    assert.ok(sim2.lane.device);

    const roomy = world({ emulatorPoolSize: 1 });
    try {
      await roomy.registry().claim(android(roomy, roomy.procs.owner(), 'one'));
      await assert.rejects(roomy.registry().claim(android(roomy, roomy.procs.owner(), 'two')), { code: 'pool-busy' });
    } finally {
      roomy.close();
    }
  } finally {
    w.close();
  }
});

test('when memory is what is short, an idle lane of the other kind is taken over to make room', async () => {
  const w = world({ memoryBudgetMb: 4000 });
  try {
    const sim = await w.registry().claim(w.request(w.procs.owner(), w.folder('sim')));
    await w.clock.advance(3 * HOUR_MS);
    const emu = await w.registry().claim(android(w, w.procs.owner(), 'emu'));
    assert.deepEqual(
      emu.tookOver.map(e => e.id),
      [sim.lane.id],
    );
    assert.equal(emu.lane.device?.platform, 'android');
    assert.equal(
      w
        .registry()
        .status()
        .pool.find(p => p.platform === 'ios')?.laneId,
      null,
    );
  } finally {
    w.close();
  }
});

test('with every console port pair taken the lane is refused before anything is taken over or created', async () => {
  const w = world();
  try {
    for (let p = 5554; p <= 5585; p++) w.probe.busy.add(p);
    await assert.rejects(w.registry().claim(android(w, w.procs.owner(), 'a')), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'ports-exhausted');
      assert.match(error.message, /5554-5585/);
      return true;
    });
    assert.deepEqual(w.emulators.calls, []);
    const status = w.registry().status();
    assert.deepEqual([status.lanes, status.pool, status.queue], [[], [], []]);
  } finally {
    w.close();
  }
});

test('a failed boot of a new Android lane releases it and stops the emulator', async () => {
  const w = world();
  try {
    w.emulators.failBoot = true;
    await assert.rejects(w.registry().claim(android(w, w.procs.owner(), 'a')), /boot failed/);
    assert.deepEqual(w.registry().status().lanes, []);
    assert.equal(w.emulators.all()[0]?.booted, false);
  } finally {
    w.close();
  }
});

test("the 'emulator' service name is reserved, and port blocks may not overlap the emulator ports", async () => {
  const w = world();
  try {
    await assert.rejects(
      w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { services: [{ name: 'emulator', type: 'web' }] })),
      UsageError,
    );
  } finally {
    w.close();
  }
  assert.throws(() => parseConfig({ ports: { web: [5580, 5590] } }, 'config.json'), /overlaps the Android emulator/);
  const base = parseConfig({ emulatorPoolSize: 2, memoryBudgetGB: 12.5 }, 'config.json');
  assert.deepEqual([base.emulatorPoolSize, base.memoryBudgetMb], [2, 12500]);
  assert.throws(() => parseConfig({ memoryBudgetGB: 2 }, 'config.json'), /at least 4/);
  assert.throws(() => withProjectBlocks(base, { admin: { first: 5500, last: 5560 } }, 'agentlane.json'), /emulator/);
});
