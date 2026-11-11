import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneVariables } from '../src/hooks/env.ts';
import { DEFAULT_CONFIG, HOUR_MS, parseConfig, withProjectBlocks } from '../src/registry/config.ts';
import type { Owner } from '../src/registry/owner.ts';
import { UsageError } from '../src/registry/refusal.ts';
import type { LaneRequest } from '../src/registry/types.ts';
import type { Lane } from '../src/registry/types.ts';
import { FakeProbe } from './support/fakes.ts';
import { sharedRegistry, startClaimer } from './support/stress-plan.ts';
import type { World } from './support/world.ts';
import { parkNow, world } from './support/world.ts';

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

test("an idle emulator lane is never taken over; once parked, its emulator boots for the next lane on that lane's console port, and the parked lane keeps its own", async () => {
  const w = world({ emulatorPoolSize: 1 });
  try {
    const old = await w.registry().claim(android(w, w.procs.owner(), 'old'));
    await w.clock.advance(3 * HOUR_MS);
    await assert.rejects(w.registry().claim(android(w, w.procs.owner(), 'taker')), { code: 'pool-busy' });
    assert.ok(parkNow(w.registry(), old.lane));
    const taker = await w.registry().claim(android(w, w.procs.owner(), 'taker'));
    assert.equal(taker.lane.device?.id, old.lane.device?.id);
    assert.notEqual(taker.lane.device?.serial, old.lane.device?.serial);
    assert.deepEqual(w.emulators.calls.slice(-3), [
      ...KILL(old.lane.device?.serial ?? ''),
      `boot ${taker.lane.device?.id ?? ''} on ${taker.lane.device?.serial?.slice('emulator-'.length) ?? ''}`,
    ]);
    assert.equal(w.emulators.list()[0]?.serial, taker.lane.device?.serial);
    const parked = w
      .registry()
      .status()
      .lanes.find(c => c.id === old.lane.id);
    assert.equal(parked?.device, null);
    assert.deepEqual(parked.ports, old.lane.ports);
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

test('when memory is what is short, an idle lane of the other kind is never taken over, and parking it makes the room', async () => {
  const w = world({ memoryBudgetMb: 4000 });
  try {
    const sim = await w.registry().claim(w.request(w.procs.owner(), w.folder('sim')));
    await w.clock.advance(3 * HOUR_MS);
    await assert.rejects(w.registry().claim(android(w, w.procs.owner(), 'emu')), { code: 'pool-busy' });
    assert.ok(parkNow(w.registry(), sim.lane));
    const emu = await w.registry().claim(android(w, w.procs.owner(), 'emu'));
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

test('an emulator still shutting down after its release keeps its console port pair, and its AVD, from the next Android lane', async () => {
  const s = sharedRegistry({
    ...DEFAULT_CONFIG,
    blocks: { metro: { first: 47800, last: 47803 }, api: { first: 47900, last: 47903 } },
  });
  try {
    const releaser = startClaimer(
      s.plan(
        [
          {
            kind: 'claim',
            worktree: s.folder('releaser'),
            platform: 'android',
            device: 'pixel_8',
            strict: false,
            boot: true,
            waitMs: 0,
          },
          { kind: 'release' },
        ],
        { gate: ['shutdown'] },
      ),
    );
    const stopping = await s.reached('shutdown', releaser);
    const serial = s.emulators.list().find(d => d.id === stopping)?.serial;
    assert.ok(serial, 'the emulator is still running');

    const next = await s.registry().claim({
      owner: s.owner,
      worktree: s.folder('next'),
      projectRoot: s.folder('next'),
      services: [{ name: 'metro', type: 'metro' }],
      device: { platform: 'android' },
      waitMs: 0,
    });
    assert.ok(next.lane.device?.serial);
    assert.notEqual(next.lane.device.id, stopping);
    assert.notEqual(next.lane.device.serial, serial);

    s.open('shutdown');
    const exit = await releaser.exited;
    assert.equal(exit.code, 0, `${exit.stdout}${exit.stderr}`);
    assert.equal(s.emulators.all().find(d => d.id === stopping)?.booted, false);
  } finally {
    s.close();
  }
});

const PIXEL = (deviceType: string) => ({ device: { platform: 'android', deviceType } }) as const;

async function freeEmulators(w: World, types: readonly string[]): Promise<void> {
  const held: { owner: Owner; lane: Lane }[] = [];
  for (const [i, type] of types.entries()) {
    const owner = w.procs.owner();
    held.push({ owner, lane: (await w.registry().claim(android(w, owner, `made-${String(i)}`, PIXEL(type)))).lane });
  }
  for (const { owner, lane } of held) w.registry().release({ id: lane.id, token: lane.token }, owner);
  assert.deepEqual(
    w.emulators
      .all()
      .map(d => [d.deviceType, d.booted])
      .sort(),
    types.map(t => [t, false]).sort(),
  );
}

for (const shutdown of ['still running', 'failed'] as const) {
  test(`an Android lane whose device listing predates another lane's emulator never takes that emulator's console pair after its release, while the shutdown is ${shutdown}`, async () => {
    const w = world();
    try {
      await freeEmulators(w, ['pixel_8', 'pixel_9']);
      let openProbe: () => void = () => undefined;
      w.probe.gate = new Promise<void>(resolve => (openProbe = resolve));
      const late = w.registry().claim(android(w, w.procs.owner(), 'late', PIXEL('pixel_9')));

      const owner = w.procs.owner();
      const early = await w.registry({ ports: new FakeProbe() }).claim(android(w, owner, 'early', PIXEL('pixel_8')));
      const running = early.lane.device;
      assert.ok(running?.serial);
      const ref = { id: early.lane.id, token: early.lane.token };
      if (shutdown === 'failed') {
        w.emulators.failShutdown = true;
        const notes: string[] = [];
        w.registry({ ports: new FakeProbe() }).release(ref, owner, notes);
        assert.ok(
          notes.some(n => n.startsWith('could not shut down')),
          notes.join('\n'),
        );
      } else {
        const stillStopping = (step: string) => {
          if (step === 'release:committed') throw new Error('the shutdown is still running');
        };
        assert.throws(() => w.registry({ ports: new FakeProbe(), onStep: stillStopping }).release(ref, owner), /still running/);
      }
      assert.equal(w.emulators.list().find(d => d.id === running.id)?.serial, running.serial, 'that emulator still runs');

      openProbe();
      const got = (await late).lane.device;
      assert.ok(got?.serial);
      assert.equal(got.deviceType, 'pixel_9');
      assert.equal(w.emulators.list().find(d => d.id === running.id)?.serial, running.serial, 'that emulator still runs');
      assert.notEqual(got.serial, running.serial);
      const serials = w.emulators.list().flatMap(d => (d.serial ? [d.serial] : []));
      assert.equal(new Set(serials).size, serials.length, `two emulators on one port pair: ${serials.join(', ')}`);
    } finally {
      w.close();
    }
  });
}

test("a released emulator's console pair stays reserved until its shutdown settles, even when the device listing can't name the pair it runs on", async () => {
  const w = world();
  try {
    await freeEmulators(w, ['pixel_8', 'pixel_9']);
    const owner = w.procs.owner();
    const early = await w.registry().claim(android(w, owner, 'early', PIXEL('pixel_8')));
    const running = early.lane.device;
    assert.ok(running?.serial);
    const stillStopping = (step: string) => {
      if (step === 'release:committed') throw new Error('the shutdown is still running');
    };
    assert.throws(
      () => w.registry({ onStep: stillStopping }).release({ id: early.lane.id, token: early.lane.token }, owner),
      /still running/,
    );
    w.emulators.unnamedSerials.add(running.id);
    assert.equal(w.emulators.list().find(d => d.id === running.id)?.booted, true);

    const late = await w.registry().claim(android(w, w.procs.owner(), 'late', PIXEL('pixel_9')));
    assert.ok(late.lane.device?.serial);
    assert.notEqual(late.lane.device.serial, running.serial);
  } finally {
    w.close();
  }
});
