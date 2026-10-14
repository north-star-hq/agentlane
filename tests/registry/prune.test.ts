import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DeviceBackend, Platform } from '../../src/devices/backend.ts';
import { DeviceBackendError } from '../../src/devices/backend.ts';
import { ownerKey, type Owner } from '../../src/registry/owner.ts';
import { databasePath } from '../../src/registry/paths.ts';
import type { PruneListing, PruneResult } from '../../src/registry/prune.ts';
import { Refusal } from '../../src/registry/refusal.ts';
import type { Registry } from '../../src/registry/registry.ts';
import { Store } from '../../src/registry/store.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { FakeDevices, FakeProbe, FakeProcesses, tempDir } from '../support/fakes.ts';
import { world, type World } from '../support/world.ts';

const SPEC: Readonly<Record<Platform, readonly string[]>> = {
  ios: [
    'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
    'iPhone 17',
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    'iOS 26.5',
  ],
  android: ['pixel_8', 'Pixel 8', 'system-images;android-36;google_apis;arm64-v8a', 'Android API 36 (Google APIs, arm64-v8a)'],
};

function write(dir: string, body: (store: Store) => void, lockWaitMs = 5000): void {
  const store = Store.open(dir, lockWaitMs);
  try {
    store.write(() => {
      body(store);
    });
  } finally {
    store.close();
  }
}

/** A pool device row as 0.2.x writes it, held by `laneId` or free. */
function formerDevice(dir: string, platform: Platform, name: string, id: string, laneId: string | null = null): void {
  write(dir, store => {
    store.db
      .prepare(
        `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
           creator_pid, creator_start, claim_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(name, platform, id, ...SPEC[platform], laneId, Date.now());
  });
}

/** A lane as 0.2.x writes it; with `device`, 0.2.x's claim of that pool device. */
function formerLane(dir: string, owner: Owner, worktree: string, device?: string): string {
  const id = randomBytes(4).toString('hex');
  const now = Date.now();
  write(dir, store => {
    store.db
      .prepare(
        `INSERT INTO claims (id, token, owner_key, owner_kind, owner_pid, owner_start, owner_session, owner_thread,
           project_root, worktree, created_at, last_used_at, last_action)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'claim')`,
      )
      .run(
        id,
        randomBytes(24).toString('base64url'),
        ownerKey(owner),
        owner.kind,
        owner.process?.pid ?? null,
        owner.process?.start ?? null,
        worktree,
        worktree,
        now,
        now,
      );
    if (device !== undefined) store.db.prepare('UPDATE devices SET claim_id = ? WHERE name = ?').run(id, device);
  });
  return id;
}

async function freeDevices(w: World, registry: Registry, count: number, platform: Platform = 'ios'): Promise<string[]> {
  const lanes = [];
  for (let i = 0; i < count; i++) {
    const owner = w.procs.owner();
    const folder = w.folder(`${platform}-${String(i)}`);
    lanes.push({ owner, folder, out: await registry.claim(w.request(owner, folder, { services: [], device: { platform } })) });
  }
  for (const lane of lanes) registry.releaseOwn(lane.owner, lane.folder);
  return lanes.map(lane => lane.out.lane.device?.name ?? '');
}

function over(inner: FakeDevices, changes: Partial<DeviceBackend>): DeviceBackend {
  return {
    platform: inner.platform,
    resolveSpec: request => inner.resolveSpec(request),
    list: () => inner.list(),
    create: (name, spec) => inner.create(name, spec),
    delete: id => {
      inner.delete(id);
    },
    shutdown: id => {
      inner.shutdown(id);
    },
    boot: (id, port) => inner.boot(id, port),
    ...changes,
  };
}

function names(devices: readonly { name: string }[]): string[] {
  return devices.map(d => d.name).sort();
}

function pruneAll(registry: Registry, listing: PruneListing): PruneResult[] {
  return listing.free.map(d => registry.pruneDevice(d));
}

test("prune deletes the pool devices no lane holds, this version's and 0.2.x's, and leaves held, unrecorded and other devices", async () => {
  const w = world();
  try {
    const r = w.registry();
    const held = await r.claim(w.request(w.procs.owner(), w.folder('mine')));
    const heldName = held.lane.device?.name ?? '';
    const [freeSim = ''] = await freeDevices(w, r, 1);
    const [freeEmu = ''] = await freeDevices(w, r, 1, 'android');
    formerDevice(w.dir, 'ios', 'agent-env-pool-bbbbbb', w.devices.addByHand('agent-env-pool-bbbbbb', false));
    formerDevice(w.dir, 'android', 'agent-env-emu-cccccc', w.emulators.addByHand('agent-env-emu-cccccc', false));
    formerDevice(w.dir, 'ios', 'agent-env-pool-aaaaaa', w.devices.addByHand('agent-env-pool-aaaaaa', true));
    const formerLaneId = formerLane(w.dir, w.procs.owner(), w.folder('theirs'), 'agent-env-pool-aaaaaa');
    w.devices.addByHand('other-agent-8087', false);
    w.devices.addByHand('agent-env-dev', false);
    w.devices.addByHand('agent-env-pool-dddddd', false);
    w.emulators.addByHand('my-pixel-api36', false);
    w.emulators.addByHand('agentlane-emu-eeeeee', false);

    const listing = r.prunable();
    assert.deepEqual(names(listing.free), [freeEmu, freeSim, 'agent-env-emu-cccccc', 'agent-env-pool-bbbbbb'].sort());
    assert.match(freeSim, /^agentlane-pool-/);
    assert.match(freeEmu, /^agentlane-emu-/);
    assert.deepEqual(
      listing.kept.map(d => [d.name, d.laneId]).sort(),
      [
        ['agent-env-pool-aaaaaa', formerLaneId],
        [heldName, held.lane.id],
      ].sort(),
    );
    assert.deepEqual(names(listing.unrecorded), ['agent-env-pool-dddddd', 'agentlane-emu-eeeeee']);

    const results = pruneAll(r, listing);
    assert.deepEqual(
      results.map(x => x.outcome),
      ['deleted', 'deleted', 'deleted', 'deleted'],
      JSON.stringify(results),
    );
    assert.deepEqual(
      names(w.devices.all()),
      ['agent-env-dev', 'agent-env-pool-aaaaaa', 'agent-env-pool-dddddd', 'other-agent-8087', heldName].sort(),
    );
    assert.deepEqual(names(w.emulators.all()), ['agentlane-emu-eeeeee', 'my-pixel-api36']);
    const status = r.status();
    assert.deepEqual(names(status.pool), ['agent-env-pool-aaaaaa', heldName].sort());
    assert.deepEqual(
      status.lanes.map(l => [l.id, l.device?.name]).sort(),
      [
        [formerLaneId, 'agent-env-pool-aaaaaa'],
        [held.lane.id, heldName],
      ].sort(),
    );
    assert.equal(
      w.devices.all().find(d => d.name === 'agent-env-pool-aaaaaa')?.booted,
      true,
      "0.2.x's lane's simulator was shut down",
    );
  } finally {
    w.close();
  }
});

test('a lane claimed between the listing and the deletion keeps its device', async () => {
  const w = world();
  try {
    const r = w.registry();
    await freeDevices(w, r, 2);
    const listing = r.prunable();
    assert.equal(listing.free.length, 2);

    const late = await w.registry().claim(w.request(w.procs.owner(), w.folder('late'), { services: [] }));
    const taken = late.lane.device?.name;
    assert.ok(taken !== undefined && listing.free.some(d => d.name === taken), 'the late lane did not take a listed device');

    const results = pruneAll(r, listing);
    const kept = results.find(x => x.device.name === taken);
    assert.equal(kept?.outcome, 'kept');
    assert.equal(kept.detail, `lane ${late.lane.id} claimed it after the listing`);
    assert.deepEqual(
      results.filter(x => x.device.name !== taken).map(x => x.outcome),
      ['deleted'],
    );
    assert.deepEqual(names(w.devices.all()), [taken]);
    assert.equal(r.status().lanes.find(l => l.id === late.lane.id)?.device?.name, taken);
  } finally {
    w.close();
  }
});

test('each deletion holds the registry lock, and a 0.2.x lane that claims a device while prune runs keeps it', () => {
  const w = world();
  try {
    let lockedDuringDelete: boolean | null = null;
    const watched = over(w.devices, {
      delete: id => {
        try {
          write(w.dir, () => undefined, 50);
          lockedDuringDelete = false;
        } catch (error) {
          assert.ok(error instanceof Refusal && error.code === 'registry-busy', String(error));
          lockedDuringDelete = true;
        }
        w.devices.delete(id);
      },
    });
    formerDevice(w.dir, 'ios', 'agent-env-pool-111111', w.devices.addByHand('agent-env-pool-111111', false));
    formerDevice(w.dir, 'ios', 'agent-env-pool-222222', w.devices.addByHand('agent-env-pool-222222', false));
    const r = w.registry({ devices: { ios: watched } });
    const listing = r.prunable();
    assert.deepEqual(names(listing.free), ['agent-env-pool-111111', 'agent-env-pool-222222']);

    const [first, second] = listing.free;
    assert.ok(first && second);
    assert.equal(r.pruneDevice(first).outcome, 'deleted');
    assert.equal(lockedDuringDelete, true, 'another process could write the registry while a device was being deleted');

    const theirs = formerLane(w.dir, w.procs.owner(), w.folder('theirs'), second.name);
    const result = r.pruneDevice(second);
    assert.equal(result.outcome, 'kept');
    assert.equal(result.detail, `lane ${theirs} claimed it after the listing`);
    assert.deepEqual(names(w.devices.all()), [second.name]);
    assert.equal(r.status().pool.find(d => d.name === second.name)?.laneId, theirs);
  } finally {
    w.close();
  }
});

test('a pool device already gone loses only its record, a booted one is shut down first, and an unlistable platform is left alone', () => {
  const w = world();
  try {
    formerDevice(w.dir, 'ios', 'agent-env-pool-0000aa', 'B0B0B0B0-0000-4000-8000-000000000000');
    const booted = w.devices.addByHand('agent-env-pool-0000bb', true);
    formerDevice(w.dir, 'ios', 'agent-env-pool-0000bb', booted);
    formerDevice(w.dir, 'android', 'agent-env-emu-0000cc', w.emulators.addByHand('agent-env-emu-0000cc', false));
    const blind = over(w.emulators, {
      list: () => {
        throw new DeviceBackendError('adb is not answering (fake)');
      },
    });
    const r = w.registry({ devices: { ios: w.devices, android: blind } });
    const listing = r.prunable();
    assert.deepEqual(
      listing.free.map(d => [d.name, d.state]),
      [
        ['agent-env-pool-0000aa', 'missing'],
        ['agent-env-pool-0000bb', 'booted'],
      ],
    );
    assert.deepEqual(
      listing.kept.map(d => [d.name, d.reason]),
      [['agent-env-emu-0000cc', 'could not list the emulators: adb is not answering (fake)']],
    );
    assert.deepEqual(
      pruneAll(r, listing).map(x => [x.device.name, x.outcome]),
      [
        ['agent-env-pool-0000aa', 'forgotten'],
        ['agent-env-pool-0000bb', 'deleted'],
      ],
    );
    assert.deepEqual(w.devices.calls, [`shutdown ${booted}`, `delete ${booted}`]);
    assert.deepEqual(names(r.status().pool), ['agent-env-emu-0000cc']);
    assert.deepEqual(names(w.emulators.all()), ['agent-env-emu-0000cc']);
  } finally {
    w.close();
  }
});

interface Cli {
  dir: string;
  sims: FakeDevices;
  backend: DeviceBackend;
  run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  close(): void;
}

function cli(): Cli {
  const root = tempDir('prune-cli');
  const dir = path.join(root, 'state');
  const sims = new FakeDevices(path.join(root, 'sims'));
  const backend = over(sims, {});
  return {
    dir,
    sims,
    backend,
    async run(...args) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runRegistryCommand('prune', args, {
        env: { AGENTLANE_STATE_DIR: dir },
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        processes: new FakeProcesses(),
        ports: new FakeProbe(),
        devices: { ios: backend },
      });
      return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('agentlane prune lists without deleting, --yes deletes, and --json prints both', async () => {
  const c = cli();
  try {
    const id = c.sims.addByHand('agent-env-pool-abcdef', false);
    formerDevice(c.dir, 'ios', 'agent-env-pool-abcdef', id);
    c.sims.addByHand('other-agent-8087', false);

    const listed = await c.run();
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^  agent-env-pool-abcdef  simulator  iPhone 17, iOS 26.5  ${id}  shutdown$`, 'm'));
    assert.match(listed.stdout, /^node_modules\/\.bin\/agentlane prune --yes deletes the 1 pool device no lane holds$/m);
    assert.doesNotMatch(listed.stdout, /other-agent-8087/);
    assert.deepEqual(c.sims.calls, []);

    const json = await c.run('--json');
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as PruneListing & { results?: unknown };
    assert.deepEqual(names(parsed.free), ['agent-env-pool-abcdef']);
    assert.equal(parsed.results, undefined);

    const deleted = await c.run('--yes', '--json');
    assert.equal(deleted.code, 0, deleted.stderr);
    const done = JSON.parse(deleted.stdout) as { results: PruneResult[] };
    assert.deepEqual(
      done.results.map(x => [x.device.name, x.outcome]),
      [['agent-env-pool-abcdef', 'deleted']],
    );
    assert.deepEqual(names(c.sims.all()), ['other-agent-8087']);

    const again = await c.run('--yes');
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^no pool device is free to delete$/m);
  } finally {
    c.close();
  }
});

test('agentlane prune --yes exits 1 and keeps the record when a deletion fails, and never creates a registry', async () => {
  const c = cli();
  try {
    const none = await c.run('--yes');
    assert.equal(none.code, 0, none.stderr);
    assert.equal(fs.existsSync(databasePath(c.dir)), false, 'prune created a registry');

    const id = c.sims.addByHand('agent-env-pool-fa11ed', false);
    formerDevice(c.dir, 'ios', 'agent-env-pool-fa11ed', id);
    c.backend.delete = () => {
      throw new DeviceBackendError('xcrun simctl delete failed (fake)');
    };
    const failed = await c.run('--yes');
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, 'agentlane: could not delete agent-env-pool-fa11ed: xcrun simctl delete failed (fake)\n');
    const listed = await c.run('--json');
    assert.deepEqual(names((JSON.parse(listed.stdout) as PruneListing).free), ['agent-env-pool-fa11ed']);
  } finally {
    c.close();
  }
});
