import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DeviceBackendError } from '../src/devices/backend.ts';
import { HOUR_MS } from '../src/registry/config.ts';
import type { Owner } from '../src/registry/owner.ts';
import { databasePath } from '../src/registry/paths.ts';
import { Refusal } from '../src/registry/refusal.ts';
import { waitForStep, world } from './support/world.ts';

const NO_DEVICE = { device: null } as const;

test('a lane takes the lowest free port of each type and creates a pool simulator of the newest iPhone and iOS', async () => {
  const w = world();
  try {
    const out = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    assert.equal(out.created, true);
    assert.deepEqual(
      out.lane.ports.map(p => [p.service, p.port]),
      [
        ['metro', 41100],
        ['api', 41200],
      ],
    );
    const device = out.lane.device;
    assert.ok(device);
    assert.ok(device.name.startsWith('agentlane-pool-'));
    assert.equal(device.deviceTypeName, 'iPhone 17');
    assert.equal(device.runtimeName, 'iOS 26.5');
    assert.deepEqual(
      w.devices.all().map(d => [d.id, d.booted]),
      [[device.id, false]],
    );
  } finally {
    w.close();
  }
});

test('claiming again from the same session and folder returns the same lane and adds any new service', async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const folder = w.folder('a');
    const first = await w.registry().claim(w.request(owner, folder));
    const again = await w.registry().claim(
      w.request(owner, folder, {
        services: [
          { name: 'metro', type: 'metro' },
          { name: 'admin', type: 'web' },
        ],
      }),
    );
    assert.equal(again.created, false);
    assert.equal(again.lane.id, first.lane.id);
    assert.equal(again.lane.token, first.lane.token);
    assert.equal(again.lane.device?.id, first.lane.device?.id);
    assert.deepEqual(
      again.lane.ports.map(p => `${p.service}:${String(p.port)}`),
      ['metro:41100', 'api:41200', 'admin:41300'],
    );
    assert.equal(w.devices.all().length, 1);
  } finally {
    w.close();
  }
});

test('two sessions get different ports and different simulators', async () => {
  const w = world();
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    const b = await w.registry().claim(w.request(w.procs.owner(), w.folder('b')));
    assert.notEqual(a.lane.device?.id, b.lane.device?.id);
    const ports = [...a.lane.ports, ...b.lane.ports].map(p => p.port);
    assert.equal(new Set(ports).size, ports.length);
  } finally {
    w.close();
  }
});

test('a plain lane never takes a simulator outside the pool: not one booted by hand, not one that only wears the pool prefix', async () => {
  const w = world();
  try {
    const byHand = w.devices.addByHand('agentlane-p1-x', true);
    const impostor = w.devices.addByHand('agentlane-pool-abc123', false);
    const out = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    assert.ok(out.lane.device);
    assert.notEqual(out.lane.device.id, byHand);
    assert.notEqual(out.lane.device.id, impostor);
    assert.equal(w.devices.all().find(d => d.id === byHand)?.booted, true);
    assert.ok(!w.devices.calls.some(c => c.includes(byHand) || c.includes(impostor)), w.devices.calls.join('\n'));
    assert.equal(w.registry().status().pool.length, 1);
  } finally {
    w.close();
  }
});

test('a released pool simulator is shut down and reused, and one booted by hand while unclaimed is shut down again', async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const a = await w.registry().claim(w.request(owner, w.folder('a'), { boot: true }));
    const id = a.lane.device?.id ?? '';
    assert.equal(w.devices.all()[0]?.booted, true);
    w.registry().releaseOwn(owner, a.lane.worktree);
    assert.equal(w.devices.all()[0]?.booted, false);
    w.devices.setBooted(id, true);
    assert.equal(w.registry().status().pool[0]?.state, 'booted');
    const b = await w.registry().claim(w.request(w.procs.owner(), w.folder('b')));
    assert.equal(b.lane.device?.id, id);
    assert.ok(
      b.notes.some(n => n.startsWith('shut down unclaimed pool simulator')),
      b.notes.join('\n'),
    );
    assert.equal(w.devices.all().length, 1);
  } finally {
    w.close();
  }
});

test('with the pool full of free simulators of another type, a lane takes one of them and deletes nothing, and says so', async () => {
  const w = world({ poolSize: 2 });
  try {
    const owner = w.procs.owner();
    const made = [
      await w.registry().claim(w.request(owner, w.folder('a'))),
      await w.registry().claim(w.request(owner, w.folder('b'))),
    ];
    w.registry().releaseOwn(owner, null);
    const pro = { device: { platform: 'ios', deviceType: 'iPhone 17 Pro' } } as const;
    const b = await w.registry().claim(w.request(w.procs.owner(), w.folder('pro'), pro));
    assert.equal(b.lane.device?.deviceTypeName, 'iPhone 17');
    assert.ok(made.some(m => m.lane.device?.id === b.lane.device?.id));
    assert.deepEqual(
      w.devices.calls.filter(c => c.startsWith('delete') || c.startsWith('create')).length,
      2,
      w.devices.calls.join('\n'),
    );
    assert.equal(w.devices.all().length, 2);
    assert.ok(
      b.notes.some(n =>
        /^took free pool simulator agentlane-pool-\w+ \(iPhone 17, iOS 26\.5\) though iPhone 17 Pro, iOS 26\.5 was asked for/.test(
          n,
        ),
      ),
      b.notes.join('\n'),
    );
  } finally {
    w.close();
  }
});

test('a free simulator of the exact type is preferred, and room in the pool makes the asked-for type rather than reusing another', async () => {
  const w = world({ poolSize: 2 });
  try {
    const owner = w.procs.owner();
    const plain = await w.registry().claim(w.request(owner, w.folder('a')));
    w.registry().releaseOwn(owner, null);
    const pro = { device: { platform: 'ios', deviceType: 'iPhone 17 Pro' } } as const;
    const made = await w.registry().claim(w.request(w.procs.owner(), w.folder('pro'), pro));
    assert.equal(made.lane.device?.deviceTypeName, 'iPhone 17 Pro');
    const exact = await w.registry().claim(w.request(w.procs.owner(), w.folder('plain')));
    assert.equal(exact.lane.device?.id, plain.lane.device?.id);
    assert.deepEqual(exact.notes, []);
  } finally {
    w.close();
  }
});

test('a strict lane with the pool full of another type replaces an unclaimed simulator with the type asked for', async () => {
  const w = world({ poolSize: 1 });
  try {
    const owner = w.procs.owner();
    const a = await w.registry().claim(w.request(owner, w.folder('a')));
    w.registry().releaseOwn(owner, a.lane.worktree);
    const b = await w
      .registry()
      .claim(
        w.request(w.procs.owner(), w.folder('b'), { device: { platform: 'ios', deviceType: 'iPhone 17 Pro', strict: true } }),
      );
    assert.equal(b.lane.device?.deviceTypeName, 'iPhone 17 Pro');
    assert.notEqual(b.lane.device.id, a.lane.device?.id);
    assert.deepEqual(
      w.devices.all().map(d => d.id),
      [b.lane.device.id],
    );
    assert.ok(w.devices.calls.includes(`delete ${a.lane.device?.id ?? ''}`));
    assert.ok(b.notes.some(n => n.startsWith('replaced unclaimed pool simulator')));
  } finally {
    w.close();
  }
});

test("a lane whose owner is gone is freed by the next claim; a can't-tell owner is reported in status and left alone", async () => {
  const w = world();
  try {
    const dead = w.procs.owner();
    const codex: Owner = { kind: 'codex', process: null, sessionId: null, threadId: 'thread-without-a-process' };
    const deadLane = await w.registry().claim(w.request(dead, w.folder('dead')));
    const codexLane = await w.registry().claim(w.request(codex, w.folder('codex')));
    w.procs.kill(dead.process?.pid ?? 0);

    const before = w.registry().status();
    assert.equal(before.lanes.find(c => c.id === deadLane.lane.id)?.ownerState, 'dead');
    assert.equal(before.lanes.find(c => c.id === codexLane.lane.id)?.ownerState, 'cant-tell');

    const next = await w.registry().claim(w.request(w.procs.owner(), w.folder('next')));
    assert.deepEqual(
      next.freed.map(f => [f.id, f.reason]),
      [[deadLane.lane.id, 'dead']],
    );
    assert.equal(next.lane.device?.id, deadLane.lane.device?.id);

    const after = w.registry().status();
    const left = after.lanes.find(c => c.id === codexLane.lane.id);
    assert.equal(left?.ownerState, 'cant-tell');
    assert.equal(left.device?.id, codexLane.lane.device?.id);
    assert.equal(
      after.lanes.some(c => c.id === deadLane.lane.id),
      false,
    );
  } finally {
    w.close();
  }
});

test('when ps cannot be read every owner is can-not-tell, and nothing is freed even if an owner died', async () => {
  const w = world();
  try {
    const dead = w.procs.owner();
    const lane = await w.registry().claim(w.request(dead, w.folder('dead'), NO_DEVICE));
    w.procs.kill(dead.process?.pid ?? 0);
    w.procs.blind = true;
    const next = await w.registry().claim(w.request(w.procs.owner(), w.folder('next'), NO_DEVICE));
    assert.deepEqual(next.freed, []);
    assert.equal(
      w
        .registry()
        .status()
        .lanes.find(c => c.id === lane.lane.id)?.ownerState,
      'cant-tell',
    );
  } finally {
    w.close();
  }
});

test('a recycled pid is classified pid-reused, not alive, and its lane is freed', async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const lane = await w.registry().claim(w.request(owner, w.folder('a'), NO_DEVICE));
    w.procs.recycle(owner.process?.pid ?? 0);
    assert.equal(w.registry().status().lanes[0]?.ownerState, 'pid-reused');
    const next = await w.registry().claim(w.request(w.procs.owner(), w.folder('b'), NO_DEVICE));
    assert.deepEqual(
      next.freed.map(f => [f.id, f.reason]),
      [[lane.lane.id, 'pid-reused']],
    );
  } finally {
    w.close();
  }
});

test('a lane whose worktree was deleted is freed even though its owner is alive', async () => {
  const w = world();
  try {
    const folder = w.folder('doomed');
    const lane = await w.registry().claim(w.request(w.procs.owner(), folder, NO_DEVICE));
    fs.rmSync(folder, { recursive: true });
    const next = await w.registry().claim(w.request(w.procs.owner(), w.folder('b'), NO_DEVICE));
    assert.deepEqual(
      next.freed.map(f => [f.id, f.reason]),
      [[lane.lane.id, 'worktree-gone']],
    );
  } finally {
    w.close();
  }
});

test('a lane recorded after the pre-lock process snapshot is not judged from that snapshot', async () => {
  const w = world();
  try {
    let open: () => void = () => undefined;
    w.probe.gate = new Promise(resolve => {
      open = resolve;
    });
    const slow = w.registry().claim(w.request(w.procs.owner(), w.folder('slow'), NO_DEVICE));
    await new Promise(resolve => setImmediate(resolve));
    w.probe.gate = null;
    const late = w.procs.owner();
    const lateLane = await w.registry().claim(w.request(late, w.folder('late'), NO_DEVICE));
    open();
    const out = await slow;
    assert.deepEqual(out.freed, []);
    assert.equal(
      w
        .registry()
        .status()
        .lanes.find(c => c.id === lateLane.lane.id)?.ownerState,
      'alive',
    );
  } finally {
    w.close();
  }
});

test('a port with a listener is skipped, and a full block refuses naming the holders and the listener', async () => {
  const w = world({ blocks: { metro: { first: 47000, last: 47001 } } });
  try {
    w.probe.busy.add(47000);
    const metro = [{ name: 'metro', type: 'metro' }];
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { ...NO_DEVICE, services: metro }));
    assert.equal(a.lane.ports[0]?.port, 47001);
    await assert.rejects(
      w.registry().claim(w.request(w.procs.owner(), w.folder('b'), { ...NO_DEVICE, services: metro })),
      (error: unknown) => {
        assert.ok(error instanceof Refusal);
        assert.equal(error.code, 'ports-exhausted');
        assert.match(error.message, new RegExp(a.lane.worktree));
        assert.match(error.message, /did not start, listening on 47000/);
        return true;
      },
    );
  } finally {
    w.close();
  }
});

test('with the ports exhausted, an idle lane is taken over for its port and the taker is told whose it was', async () => {
  const w = world({ blocks: { metro: { first: 47000, last: 47000 } } });
  try {
    const metro = [{ name: 'metro', type: 'metro' }];
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { ...NO_DEVICE, services: metro }));
    await w.clock.advance(2 * HOUR_MS + 60_000);
    const b = await w.registry().claim(w.request(w.procs.owner(), w.folder('b'), { ...NO_DEVICE, services: metro }));
    assert.equal(b.lane.ports[0]?.port, 47000);
    assert.deepEqual(
      b.tookOver.map(t => [t.id, t.lastUsedAt]),
      [[a.lane.id, a.lane.lastUsedAt]],
    );
  } finally {
    w.close();
  }
});

test('with the pool full, later claims wait in FIFO order and each gets the slot when the holder releases', async () => {
  const w = world({ poolSize: 1 });
  try {
    const ownerA = w.procs.owner();
    const a = await w.registry().claim(w.request(ownerA, w.folder('a')));
    const bWaits = waitForStep('claim:waiting');
    const ownerB = w.procs.owner();
    const b = w.registry({ onStep: bWaits.onStep, pollMs: 5000 }).claim(w.request(ownerB, w.folder('b'), { waitMs: 60_000 }));
    await bWaits.reached;
    const cWaits = waitForStep('claim:waiting');
    const c = w
      .registry({ onStep: cWaits.onStep, pollMs: 500 })
      .claim(w.request(w.procs.owner(), w.folder('c'), { waitMs: 60_000 }));
    await cWaits.reached;
    assert.deepEqual(
      w
        .registry()
        .status()
        .queue.map(q => path.basename(q.worktree)),
      ['b', 'c'],
    );

    let cDone = false;
    void c.then(() => {
      cDone = true;
    });
    w.registry().releaseOwn(ownerA, a.lane.worktree);
    for (let i = 0; i < 9; i++) await w.clock.advance(500);
    assert.equal(cDone, false, 'c polled first but is behind b in the queue');
    await w.clock.advance(500);
    const bOut = await b;
    assert.equal(bOut.lane.device?.id, a.lane.device?.id);
    assert.equal(cDone, false);

    w.registry().releaseOwn(ownerB, bOut.lane.worktree);
    await w.clock.advance(500);
    const cOut = await c;
    assert.equal(cOut.lane.device?.id, a.lane.device?.id);
    assert.deepEqual(w.registry().status().queue, []);
  } finally {
    w.close();
  }
});

test('a waiter that times out is refused with the holders named and leaves the queue', async () => {
  const w = world({ poolSize: 1 });
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    const waits = waitForStep('claim:waiting');
    const b = w.registry({ onStep: waits.onStep }).claim(w.request(w.procs.owner(), w.folder('b'), { waitMs: 2000 }));
    await waits.reached;
    const verdict = assert.rejects(b, (error: unknown) => {
      assert.ok(error instanceof Refusal);
      assert.equal(error.code, 'pool-busy');
      assert.match(error.message, new RegExp(a.lane.worktree));
      return true;
    });
    for (let i = 0; i < 5; i++) await w.clock.advance(500);
    await verdict;
    assert.deepEqual(w.registry().status().queue, []);
  } finally {
    w.close();
  }
});

test('an idle lane over 2 h is taken over only when no slot is free, and the taker sees whose it was', async () => {
  const w = world({ poolSize: 1 });
  try {
    const ownerA = w.procs.owner();
    const a = await w.registry().claim(w.request(ownerA, w.folder('a')));
    const ref = { id: a.lane.id, token: a.lane.token };

    await w.clock.advance(HOUR_MS);
    await assert.rejects(w.registry().claim(w.request(w.procs.owner(), w.folder('early'))), { code: 'pool-busy' });

    await w.clock.advance(HOUR_MS + 60_000);
    const b = await w.registry().claim(w.request(w.procs.owner(), w.folder('b')));
    assert.equal(b.lane.device?.id, a.lane.device?.id);
    assert.equal(b.tookOver.length, 1);
    const taken = b.tookOver[0];
    assert.equal(taken?.id, a.lane.id);
    assert.equal(taken.lastUsedAt, a.lane.lastUsedAt);
    assert.equal(taken.lastAction, 'claim');
    assert.equal(taken.worktree, a.lane.worktree);

    assert.throws(
      () => w.registry().touch(ref, 'look'),
      (error: unknown) => {
        assert.ok(error instanceof Refusal);
        assert.equal(error.code, 'lane-gone');
        assert.match(error.message, new RegExp(b.lane.worktree));
        assert.match(error.message, /took it over/);
        return true;
      },
    );
  } finally {
    w.close();
  }
});

test("a can't-tell lane idle over 2 h is taken over only under pressure, for a device or a port, and the sweep never frees it", async () => {
  const w = world({
    poolSize: 2,
    blocks: { metro: { first: 41100, last: 41101 }, api: { first: 41200, last: 41219 } },
  });
  try {
    const thread: Owner = { kind: 'codex', process: null, sessionId: null, threadId: 't-idle' };
    const unknown = await w.registry().claim(w.request(thread, w.folder('unknown')));
    await w.clock.advance(3 * HOUR_MS);

    const roomy = await w.registry().claim(w.request(w.procs.owner(), w.folder('roomy')));
    const sweeper = await w.registry().claim(w.request(w.procs.owner(), w.folder('sweeper'), { device: null, services: [] }));
    for (const out of [roomy, sweeper]) assert.deepEqual([out.freed, out.tookOver], [[], []]);
    assert.equal(
      w
        .registry()
        .status()
        .lanes.find(c => c.id === unknown.lane.id)?.ownerState,
      'cant-tell',
    );

    const pressed = await w.registry().claim(w.request(w.procs.owner(), w.folder('pressed'), NO_DEVICE));
    assert.deepEqual(pressed.freed, []);
    assert.deepEqual(
      pressed.tookOver.map(e => [e.id, e.reason, e.owner]),
      [[unknown.lane.id, 'taken-over', 'codex thread t-idle (no process recorded)']],
    );
    assert.equal(pressed.lane.ports.find(p => p.service === 'metro')?.port, unknown.lane.ports[0]?.port);
  } finally {
    w.close();
  }
});

test('an idle lane is left alone while a slot is free, and a touch keeps a lane from going idle', async () => {
  const w = world({ poolSize: 2 });
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    await w.clock.advance(3 * HOUR_MS);
    const b = await w.registry().claim(w.request(w.procs.owner(), w.folder('b')));
    assert.deepEqual(b.tookOver, []);
    assert.notEqual(b.lane.device?.id, a.lane.device?.id);
    w.registry().touch({ id: a.lane.id, token: a.lane.token }, 'device call');
    await w.clock.advance(HOUR_MS);
    await assert.rejects(w.registry().claim(w.request(w.procs.owner(), w.folder('c'))), { code: 'pool-busy' });
    assert.equal(w.registry().status().lanes.length, 2);
  } finally {
    w.close();
  }
});

test('a failed boot rolls back the new lane and shuts its simulator down', async () => {
  const w = world();
  try {
    w.devices.failBoot = true;
    await assert.rejects(w.registry().claim(w.request(w.procs.owner(), w.folder('a'), { boot: true })), DeviceBackendError);
    const status = w.registry().status();
    assert.deepEqual(status.lanes, []);
    assert.equal(status.pool.length, 1);
    assert.equal(status.pool[0]?.laneId, null);
    assert.equal(w.devices.all()[0]?.booted, false);
  } finally {
    w.close();
  }
});

test('a failed simulator create leaves no lane, reservation or queue ticket behind', async () => {
  const w = world();
  try {
    w.devices.failCreate = true;
    await assert.rejects(w.registry().claim(w.request(w.procs.owner(), w.folder('a'))), DeviceBackendError);
    const status = w.registry().status();
    assert.deepEqual([status.lanes, status.pool, status.queue], [[], [], []]);
  } finally {
    w.close();
  }
});

test('a reservation left by a dead creator is adopted when its simulator exists and dropped when it does not', async () => {
  const w = world();
  try {
    w.registry();
    const creator = w.procs.spawn();
    w.procs.kill(creator.pid);
    const made = w.devices.addByHand('agentlane-pool-0dead1', false);
    const db = new DatabaseSync(databasePath(w.dir));
    const insert = db.prepare(
      `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name, creator_pid, creator_start, claim_id, created_at)
       VALUES (?, 'ios', NULL, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', 'iPhone 17', 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', 'iOS 26.5', ?, ?, NULL, 0)`,
    );
    insert.run('agentlane-pool-0dead1', creator.pid, creator.start);
    insert.run('agentlane-pool-0dead2', creator.pid, creator.start);
    db.close();
    const out = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    assert.equal(out.lane.device?.id, made);
    assert.ok(out.notes.some(n => n.startsWith('adopted pool simulator agentlane-pool-0dead1')));
    assert.ok(out.notes.some(n => n.startsWith('dropped the reservation for agentlane-pool-0dead2')));
    assert.deepEqual(
      w
        .registry()
        .status()
        .pool.map(p => p.name),
      ['agentlane-pool-0dead1'],
    );
  } finally {
    w.close();
  }
});

test('release by id refuses a live or unjudgeable owner, frees a proven one, and --force frees any', async () => {
  const w = world();
  try {
    const me = w.procs.owner();
    const live = await w.registry().claim(w.request(w.procs.owner(), w.folder('live'), NO_DEVICE));
    const codex: Owner = { kind: 'codex', process: null, sessionId: null, threadId: 't1' };
    const unknown = await w.registry().claim(w.request(codex, w.folder('unknown'), NO_DEVICE));
    const deadOwner = w.procs.owner();
    const dead = await w.registry().claim(w.request(deadOwner, w.folder('dead'), NO_DEVICE));
    w.procs.kill(deadOwner.process?.pid ?? 0);

    assert.throws(() => w.registry().releaseById(live.lane.id, me, false), { code: 'held-by-live-owner' });
    assert.throws(() => w.registry().releaseById(unknown.lane.id, me, false), { code: 'owner-unknown' });
    assert.equal(w.registry().releaseById(dead.lane.id, me, false).reason, 'dead');
    assert.equal(w.registry().releaseById(unknown.lane.id, me, true).reason, 'forced');
    assert.equal(w.registry().status().lanes.length, 1);
  } finally {
    w.close();
  }
});

test('touch and process records compare the lane token', async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const out = await w.registry().claim(w.request(owner, w.folder('a'), NO_DEVICE));
    const ref = { id: out.lane.id, token: out.lane.token };
    assert.throws(() => w.registry().touch({ id: ref.id, token: 'not-it' }, 'look'), { code: 'token-mismatch' });
    w.registry().recordProcess(ref, { service: 'metro', pid: 4242, start: 'Mon Oct 12 09:00:00 2026', cwd: out.lane.worktree });
    assert.deepEqual(
      w
        .registry()
        .status()
        .lanes[0]?.processes.map(p => p.pid),
      [4242],
    );
    w.registry().forgetProcess(ref, 'metro');
    assert.deepEqual(w.registry().status().lanes[0]?.processes, []);
    w.registry().release(ref, owner);
    assert.throws(() => w.registry().touch(ref, 'look'), { code: 'lane-gone' });
  } finally {
    w.close();
  }
});

test('status never carries a token', async () => {
  const w = world();
  try {
    const out = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    assert.equal(JSON.stringify(w.registry().status()).includes(out.lane.token), false);
  } finally {
    w.close();
  }
});

test("a claimed simulator deleted by hand is replaced at its owner's next claim", async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const folder = w.folder('a');
    const first = await w.registry().claim(w.request(owner, folder));
    w.devices.delete(first.lane.device?.id ?? '');
    const again = await w.registry().claim(w.request(owner, folder));
    assert.equal(again.lane.id, first.lane.id);
    assert.ok(again.lane.device);
    assert.notEqual(again.lane.device.id, first.lane.device?.id);
  } finally {
    w.close();
  }
});

test('a claim queued behind others still proceeds at once when there are more free slots than claims ahead of it', async () => {
  const w = world({ poolSize: 2 });
  try {
    w.registry();
    const waiter = w.procs.spawn();
    const db = new DatabaseSync(databasePath(w.dir));
    db.prepare(
      `INSERT INTO queue (waiter_pid, waiter_start, owner_key, owner_label, worktree, enqueued_at) VALUES (?, ?, 'k', 'a waiter', '/w', 0)`,
    ).run(waiter.pid, waiter.start);
    db.close();
    const first = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    assert.ok(first.lane.device);
    await assert.rejects(w.registry().claim(w.request(w.procs.owner(), w.folder('b'))), { code: 'pool-busy' });
  } finally {
    w.close();
  }
});

test('a lane that fails after taking over an idle lane never leaves that lane holding a deleted simulator', async () => {
  const w = world({ poolSize: 1 });
  try {
    const a = await w.registry().claim(w.request(w.procs.owner(), w.folder('a')));
    await w.clock.advance(3 * HOUR_MS);
    const taker = w.procs.spawn();
    const db = new DatabaseSync(databasePath(w.dir));
    db.prepare(
      `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name, creator_pid, creator_start, claim_id, created_at)
       VALUES ('agentlane-pool-0ta6e4', 'ios', NULL, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', 'iPhone 17 Pro',
               'com.apple.CoreSimulator.SimRuntime.iOS-26-5', 'iOS 26.5', ?, ?, NULL, 0)`,
    ).run(taker.pid, taker.start);
    db.close();
    let failed = false;
    const crash = (step: string) => {
      if (step === 'claim:inserted' && !failed) {
        failed = true;
        throw new Error('crash after the lane rows were written');
      }
    };
    await assert.rejects(
      w
        .registry({ self: taker, onStep: crash })
        .claim(w.request(w.procs.owner(), w.folder('b'), { device: { platform: 'ios', deviceType: 'iPhone 17 Pro' } })),
      /crash after the lane rows/,
    );
    const status = w.registry().status();
    for (const c of status.lanes) assert.notEqual(c.deviceState, 'missing', `lane ${c.id} holds a deleted simulator`);
    assert.ok(failed);
    assert.ok(a.lane.device);
  } finally {
    w.close();
  }
});
