import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { DeviceBackend, DeviceDisk, Platform } from '../../src/devices/backend.ts';
import { DeviceBackendError } from '../../src/devices/backend.ts';
import { simctlBackend } from '../../src/devices/simctl.ts';
import type { ProcessIdentity } from '../../src/processes.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import type { DeviceWork } from '../../src/registry/leases.ts';
import { handOver, KEEPER_PID, leaseDevice } from '../../src/registry/leases.ts';
import { ownerKey, type Owner } from '../../src/registry/owner.ts';
import { databasePath, stateDir } from '../../src/registry/paths.ts';
import type {
  LeftoverResult,
  LeftoverStep,
  OrphanResult,
  PruneContext,
  PruneListing,
  PruneReport,
  PruneResult,
} from '../../src/registry/prune.ts';
import {
  deleteLeftovers,
  deleteOrphan,
  finishLeftovers,
  listPrunable,
  moveLeftoversAside,
  putBackAsideCopies,
  reportPrunable,
} from '../../src/registry/prune.ts';
import { Refusal, UsageError } from '../../src/registry/refusal.ts';
import type { Step } from '../../src/registry/registry.ts';
import { Registry } from '../../src/registry/registry.ts';
import { Store } from '../../src/registry/store.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { fakeXcrun, xcrunsOn, type FakeSimulator } from '../support/fake-xcrun.ts';
import { FakeDevices, FakeProbe, FakeProcesses, tempDir } from '../support/fakes.ts';
import { isolatedEnv, withProcessEnv } from '../support/isolated-env.ts';
import { sharedRegistry, startClaimer, type StressOp } from '../support/stress-plan.ts';
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
    delete: (id, whenRunning) => {
      inner.delete(id, whenRunning);
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

test('a free pool device simctl lists as neither booted nor shut down is shown as starting or stopping, and shut down before it is deleted', () => {
  const w = world();
  try {
    const booting = w.devices.addByHand('agent-env-pool-0000dd', false);
    formerDevice(w.dir, 'ios', 'agent-env-pool-0000dd', booting);
    const listsBooting = over(w.devices, {
      list: () => w.devices.list().map(d => (d.id === booting ? { ...d, booted: false, stopped: false } : d)),
    });
    const r = w.registry({ devices: { ios: listsBooting } });
    const listing = r.prunable();
    assert.deepEqual(
      listing.free.map(d => [d.name, d.state]),
      [['agent-env-pool-0000dd', 'changing']],
    );
    assert.deepEqual(
      pruneAll(r, listing).map(x => [x.device.name, x.outcome]),
      [['agent-env-pool-0000dd', 'deleted']],
    );
    assert.deepEqual(w.devices.calls, [`shutdown ${booting}`, `delete ${booting}`]);
  } finally {
    w.close();
  }
});

interface Cli {
  root: string;
  env: NodeJS.ProcessEnv;
  home: string;
  repo: string;
  own: string;
  former: string;
  sims: FakeDevices;
  emus: FakeDevices;
  backend: DeviceBackend;
  devices: Partial<Record<Platform, DeviceBackend>>;
  disks: Map<string, DeviceDisk>;
  ctx: PruneContext;
  run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  runWith(
    devices: Partial<Record<Platform, DeviceBackend>>,
    ...args: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  report(): PruneReport;
  close(): void;
}

function gitInit(dir: string, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(dir, { recursive: true });
  const made = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', env });
  assert.equal(made.status, 0, made.stderr);
}

function fill(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

function cli(extraEnv: (root: string) => Record<string, string> = () => ({})): Cli {
  const root = fs.realpathSync(tempDir('prune-cli'));
  const env: NodeJS.ProcessEnv = { ...isolatedEnv(root), PATH: process.env.PATH, ...extraEnv(root) };
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  gitInit(repo, env);
  const sims = new FakeDevices(path.join(root, 'sims'));
  const emus = new FakeDevices(path.join(root, 'emus'), 'android');
  const disks = new Map<string, DeviceDisk>();
  const withDisks = (inner: FakeDevices) =>
    over(inner, {
      list: () =>
        inner.list().map(d => {
          const disk = disks.get(d.id);
          return disk ? { ...d, disk } : d;
        }),
    });
  const backend = withDisks(sims);
  const devices = { ios: backend, android: withDisks(emus) };
  const state = path.join(home, '.local', 'state');
  const own = path.join(state, 'agentlane');
  const ctx: PruneContext = { env, cwd: repo, lockWaitMs: 5000 };
  return {
    root,
    env,
    home,
    repo,
    own,
    former: path.join(state, 'agent-env'),
    sims,
    emus,
    backend,
    devices,
    disks,
    ctx,
    run(...args) {
      return this.runWith(devices, ...args);
    },
    async runWith(backends, ...args) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runRegistryCommand('prune', args, {
        env,
        cwd: repo,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        processes: new FakeProcesses(),
        ports: new FakeProbe(),
        devices: backends,
      });
      return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    },
    report() {
      const dir = stateDir(env);
      const store = Store.openExisting(dir, 5000);
      try {
        return reportPrunable(listPrunable(store, dir, devices), ctx);
      } finally {
        store?.close();
      }
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
    formerDevice(c.own, 'ios', 'agent-env-pool-abcdef', id);
    c.sims.addByHand('other-agent-8087', false);

    const listed = await c.run();
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^  agent-env-pool-abcdef  simulator  iPhone 17, iOS 26.5  ${id}  shutdown$`, 'm'));
    assert.match(listed.stdout, /^node_modules\/\.bin\/agentlane prune --yes deletes the 1 pool device no lane holds$/m);
    assert.doesNotMatch(listed.stdout, /other-agent-8087/);
    assert.deepEqual(c.sims.calls, []);

    const json = await c.run('--json');
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as PruneReport & { results?: unknown };
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
    assert.equal(fs.existsSync(databasePath(c.own)), false, 'prune created a registry');
    assert.equal(fs.existsSync(databasePath(c.former)), false, "prune created 0.2.x's registry");

    const id = c.sims.addByHand('agent-env-pool-fa11ed', false);
    formerDevice(c.own, 'ios', 'agent-env-pool-fa11ed', id);
    c.backend.delete = () => {
      throw new DeviceBackendError('xcrun simctl delete failed (fake)');
    };
    const failed = await c.run('--yes');
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, 'agentlane: could not delete agent-env-pool-fa11ed: xcrun simctl delete failed (fake)\n');
    const listed = await c.run('--json');
    assert.deepEqual(names((JSON.parse(listed.stdout) as PruneReport).free), ['agent-env-pool-fa11ed']);
  } finally {
    c.close();
  }
});

test('prune refuses before it opens or lists anything when HOME is not given, so a fixture can never reach the real home', async () => {
  const root = tempDir('prune-no-home');
  try {
    const dir = path.join(root, 'state');
    const sims = new FakeDevices(path.join(root, 'sims'));
    let listed = 0;
    const counted = over(sims, {
      list: () => {
        listed++;
        return sims.list();
      },
    });
    const stderr: string[] = [];
    const code = await runRegistryCommand('prune', ['--yes'], {
      env: { AGENTLANE_STATE_DIR: dir },
      cwd: root,
      stdout: () => undefined,
      stderr: text => stderr.push(text),
      processes: new FakeProcesses(),
      ports: new FakeProbe(),
      devices: { ios: counted },
    });
    assert.equal(code, 2);
    assert.match(stderr.join(''), /prune needs HOME to find every registry and download folder on this machine/);
    assert.equal(listed, 0, 'prune listed devices before refusing');
    assert.equal(fs.existsSync(dir), false, 'prune touched the state folder before refusing');

    const ctx: PruneContext = { env: { AGENTLANE_STATE_DIR: dir }, cwd: root, lockWaitMs: 50 };
    const listing: PruneListing = { stateDir: dir, free: [], kept: [], unrecorded: [] };
    const orphan = { name: 'agent-env-pool-0000ff', platform: 'ios' as const, id: 'X', paths: [], bytes: null };
    const leftover = { kind: 'downloads' as const, path: path.join(root, 'agent-env'), repository: null, bytes: 0 };
    assert.throws(() => reportPrunable(listing, ctx), UsageError);
    assert.throws(() => deleteOrphan(ctx, counted, orphan), UsageError);
    assert.throws(() => deleteLeftovers(ctx, [leftover]), UsageError);
    assert.equal(listed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function disked(c: Cli): { held: string; laneId: string; other: string; repo2: string } {
  const held = 'agentlane-pool-111111';
  formerDevice(c.own, 'ios', held, c.sims.addByHand(held, false));
  const repo2 = path.join(path.dirname(c.repo), 'repo2');
  gitInit(repo2, c.env);
  const laneId = formerLane(c.own, new FakeProcesses().owner(), repo2, held);
  const other = 'agent-env-emu-222222';
  formerDevice(c.former, 'android', other, c.emus.addByHand(other, false));

  const simOrphan = c.sims.addByHand('agent-env-pool-aaaaaa', false);
  c.disks.set(simOrphan, { paths: [path.join(c.home, 'sim', simOrphan)], bytes: 2_700_000_000 });
  const emuOrphan = c.emus.addByHand('agent-env-emu-bbbbbb', false);
  const avd = path.join(c.home, '.android', 'avd');
  fill(path.join(avd, 'agent-env-emu-bbbbbb.ini'), 100);
  fill(path.join(avd, 'agent-env-emu-bbbbbb.avd', 'userdata-qemu.img'), 300_000);
  c.disks.set(emuOrphan, {
    paths: [path.join(avd, 'agent-env-emu-bbbbbb.ini'), path.join(avd, 'agent-env-emu-bbbbbb.avd')],
    bytes: null,
  });
  c.sims.addByHand('agentlane-pool-cccccc', true);
  c.sims.addByHand('iPhone 17 Pro', false);

  fill(path.join(c.home, '.local', 'share', 'agent-env', 'maestro', '2.0.0', 'maestro.zip'), 500_000);
  fill(path.join(c.home, '.local', 'share', 'agentlane', 'maestro', '2.1.0', 'maestro.zip'), 1000);
  fill(path.join(c.repo, '.git', 'agent-env', 'build-cache', 'objects', 'a'), 200_000);
  fill(path.join(c.repo, '.git', 'agentlane', 'build-cache', 'objects', 'b'), 1000);
  fill(path.join(repo2, '.git', 'agent-env', 'build-cache', 'objects', 'c'), 100_000);
  return { held, laneId, other, repo2 };
}

test('prune lists the devices no registry records and what 0.2.x left, with sizes, and --yes deletes exactly those', async () => {
  const c = cli();
  try {
    const { held, laneId, other, repo2 } = disked(c);
    const downloads = path.join(c.home, '.local', 'share', 'agent-env');
    const cache = path.join(c.repo, '.git', 'agent-env', 'build-cache');
    const cache2 = path.join(repo2, '.git', 'agent-env', 'build-cache');

    const listed = await c.run();
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^also checked: ${c.former}$`, 'm'));
    assert.match(listed.stdout, /^named like pool devices but in no registry on this Mac \(2, 2\.7 GB\):$/m);
    assert.match(listed.stdout, /^ {2}agent-env-emu-bbbbbb {2}emulator {2}3\d\d kB$/m);
    assert.match(listed.stdout, /^ {2}agent-env-pool-aaaaaa {2}simulator {2}[0-9A-F-]{36} {2}2\.7 GB$/m);
    assert.match(listed.stdout, /^what 0\.2\.x left \(3, 8\d\d kB\):$/m);
    assert.match(listed.stdout, new RegExp(`^  ${downloads}  0\\.2\\.x's Maestro and browser downloads  5\\d\\d kB$`, 'm'));
    assert.match(listed.stdout, new RegExp(`^  ${cache}  0\\.2\\.x's build cache for ${c.repo}  2\\d\\d kB$`, 'm'));
    assert.match(listed.stdout, new RegExp(`^  ${cache2}  0\\.2\\.x's build cache for ${repo2}  1\\d\\d kB$`, 'm'));
    assert.match(
      listed.stdout,
      /^node_modules\/\.bin\/agentlane prune --yes deletes the 2 devices no registry records and what 0\.2\.x left$/m,
    );
    assert.deepEqual(c.sims.calls, []);
    assert.ok(fs.existsSync(downloads));

    const json = JSON.parse((await c.run('--json')).stdout) as PruneReport;
    assert.deepEqual(json.registries, [c.own, c.former]);
    assert.deepEqual(
      json.orphans.map(d => [
        d.name,
        d.platform,
        d.bytes !== null && d.bytes >= (d.platform === 'ios' ? 2_700_000_000 : 300_100),
      ]),
      [
        ['agent-env-emu-bbbbbb', 'android', true],
        ['agent-env-pool-aaaaaa', 'ios', true],
      ],
    );
    assert.deepEqual(
      json.kept.map(d => [d.name, d.laneId, d.registry, d.reason]).sort(),
      [
        [held, laneId, c.own, `held by lane ${laneId}`],
        ['agentlane-pool-cccccc', null, null, 'no registry records it, but it is not shut down, so something may be using it'],
        [other, null, c.former, `the registry in ${c.former} records it`],
      ].sort(),
    );
    assert.deepEqual(
      json.leftovers.map(l => [l.kind, l.path, l.repository]),
      [
        ['downloads', downloads, null],
        ['build-cache', cache, c.repo],
        ['build-cache', cache2, repo2],
      ],
    );
    assert.ok(json.leftovers.every(l => l.bytes >= 100_000));
    assert.equal(json.leftoversKept, null);

    const deleted = await c.run('--yes', '--json');
    assert.equal(deleted.code, 0, deleted.stderr);
    const done = JSON.parse(deleted.stdout) as { orphanResults: OrphanResult[]; leftoverResults: LeftoverResult[] };
    assert.deepEqual(
      done.orphanResults.map(r => [r.device.name, r.outcome]),
      [
        ['agent-env-emu-bbbbbb', 'deleted'],
        ['agent-env-pool-aaaaaa', 'deleted'],
      ],
    );
    assert.deepEqual(
      done.leftoverResults.map(r => [r.leftover.path, r.outcome]),
      [
        [downloads, 'deleted'],
        [cache, 'deleted'],
        [cache2, 'deleted'],
      ],
    );
    assert.deepEqual(names(c.sims.all()), ['agentlane-pool-cccccc', 'iPhone 17 Pro', held].sort());
    assert.deepEqual(names(c.emus.all()), [other]);
    for (const gone of [downloads, path.dirname(cache), path.dirname(cache2)]) assert.equal(fs.existsSync(gone), false, gone);
    assert.ok(fs.existsSync(path.join(c.home, '.local', 'share', 'agentlane', 'maestro', '2.1.0', 'maestro.zip')));
    assert.ok(fs.existsSync(path.join(c.repo, '.git', 'agentlane', 'build-cache', 'objects', 'b')));
    assert.deepEqual(fs.readdirSync(path.dirname(downloads)), ['agentlane']);

    const again = await c.run('--yes');
    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /no registry on this Mac|what 0\.2\.x left|^deleted/m);
  } finally {
    c.close();
  }
});

test('a device a registry records, or that is gone, by the deletion is kept: every registry is locked for the check and none for the delete', () => {
  const c = cli();
  try {
    formerDevice(c.own, 'ios', 'agentlane-pool-000000', c.sims.addByHand('agentlane-pool-000000', false));
    formerDevice(c.former, 'ios', 'agent-env-pool-000000', c.sims.addByHand('agent-env-pool-000000', false));
    const ids = ['1', '2', '3', '4'].map(n => c.sims.addByHand(`agent-env-pool-00000${n}`, false));
    const report = c.report();
    assert.deepEqual(names(report.orphans), [
      'agent-env-pool-000001',
      'agent-env-pool-000002',
      'agent-env-pool-000003',
      'agent-env-pool-000004',
    ]);
    const [byFormer, byOwn, vanished, free] = report.orphans;
    assert.ok(byFormer && byOwn && vanished && free);

    formerDevice(c.former, 'ios', byFormer.name, byFormer.id);
    const theirs = formerLane(c.former, new FakeProcesses().owner(), path.join(c.home, 'theirs'), byFormer.name);
    write(c.own, store => {
      store.db
        .prepare(
          `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
             creator_pid, creator_start, claim_id, created_at)
           VALUES (?, 'ios', NULL, ?, ?, ?, ?, 1, 'start', NULL, ?)`,
        )
        .run(byOwn.name, ...SPEC.ios, Date.now());
    });
    c.sims.delete(vanished.id);

    const lockedNow = (): Record<string, boolean> => {
      const locked: Record<string, boolean> = {};
      for (const dir of [c.own, c.former]) {
        try {
          write(dir, () => undefined, 50);
          locked[dir] = false;
        } catch (error) {
          assert.ok(error instanceof Refusal && error.code === 'registry-busy', String(error));
          locked[dir] = true;
        }
      }
      return locked;
    };
    let atCheck: Record<string, boolean> = {};
    let atDelete: Record<string, boolean> = {};
    const watched = over(c.sims, {
      list: () => {
        atCheck = lockedNow();
        return c.sims.list();
      },
      delete: (id, whenRunning) => {
        atDelete = lockedNow();
        c.sims.delete(id, whenRunning);
      },
    });
    const results = report.orphans.map(d => deleteOrphan(c.ctx, watched, d));
    assert.deepEqual(
      results.map(r => [r.device.name, r.outcome, r.detail]),
      [
        [byFormer.name, 'kept', `the registry in ${c.former} records it now`],
        [byOwn.name, 'kept', `the registry in ${c.own} records it now`],
        [vanished.name, 'gone', 'it no longer exists'],
        [free.name, 'deleted', null],
      ],
    );
    assert.deepEqual(atCheck, { [c.own]: true, [c.former]: true });
    assert.deepEqual(atDelete, { [c.own]: false, [c.former]: false });
    assert.deepEqual(
      c.sims
        .all()
        .map(d => d.id)
        .filter(id => ids.includes(id))
        .sort(),
      [byFormer.id, byOwn.id].sort(),
    );
    assert.ok(theirs);
  } finally {
    c.close();
  }
});

test('an orphan booted after the listing is kept', () => {
  const c = cli();
  try {
    formerDevice(c.own, 'ios', 'agentlane-pool-000000', c.sims.addByHand('agentlane-pool-000000', false));
    const id = c.sims.addByHand('agent-env-pool-0000b0', false);
    const [orphan] = c.report().orphans;
    assert.ok(orphan);
    assert.equal(orphan.id, id);
    const booting = over(c.sims, {
      list: () => c.sims.list().map(d => (d.id === id ? { ...d, booted: true, stopped: false } : d)),
    });
    assert.deepEqual(deleteOrphan(c.ctx, booting, orphan), {
      device: orphan,
      outcome: 'kept',
      detail: 'it is no longer shut down',
    });
    assert.deepEqual(names(c.sims.all()), ['agent-env-pool-0000b0', 'agentlane-pool-000000']);
  } finally {
    c.close();
  }
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test("what 0.2.x left is listed but kept while 0.2.x's registry has a lane, including one that starts after the listing", async () => {
  const c = cli();
  try {
    const downloads = path.join(c.home, '.local', 'share', 'agent-env');
    fill(path.join(downloads, 'playwright', 'x'), 1000);
    fill(path.join(c.repo, '.git', 'agent-env', 'build-cache', 'objects', 'a'), 1000);
    const lane = formerLane(c.former, new FakeProcesses().owner(), c.repo);

    const listed = await c.run('--yes');
    assert.equal(listed.code, 0, listed.stderr);
    const reason = `the registry in ${c.former}, which 0.2.x may use, has lane ${lane}, which may be 0.2.x's; prune deletes what 0.2.x left once no such registry has lanes`;
    assert.match(listed.stdout, new RegExp(`^  kept: ${escaped(reason)}$`, 'm'));
    assert.doesNotMatch(listed.stdout, /^deleted/m);
    assert.ok(fs.existsSync(downloads));

    write(c.former, store => {
      store.db.prepare('DELETE FROM claims WHERE id = ?').run(lane);
    });
    const report = c.report();
    assert.equal(report.leftoversKept, null);
    assert.equal(report.leftovers.length, 2);
    const late = formerLane(c.former, new FakeProcesses().owner(), c.repo);
    const results = deleteLeftovers(c.ctx, report.leftovers);
    assert.deepEqual(
      results.map(r => r.outcome),
      ['kept', 'kept'],
    );
    assert.match(results[0]?.detail ?? '', new RegExp(`has lane ${late}`));
    assert.ok(fs.existsSync(path.join(downloads, 'playwright', 'x')));
    assert.ok(fs.existsSync(path.join(c.repo, '.git', 'agent-env', 'build-cache', 'objects', 'a')));
  } finally {
    c.close();
  }
});

test('a copy a stopped prune had moved aside is listed and deleted with the rest', async () => {
  const c = cli();
  try {
    const aside = path.join(c.home, '.local', 'share', 'agent-env.deleting-abc123');
    fill(path.join(aside, 'maestro', 'x'), 1000);
    const json = JSON.parse((await c.run('--json')).stdout) as PruneReport;
    assert.deepEqual(
      json.leftovers.map(l => l.path),
      [aside],
    );
    const done = await c.run('--yes');
    assert.equal(done.code, 0, done.stderr);
    assert.equal(fs.existsSync(aside), false);
  } finally {
    c.close();
  }
});

test('deleteLeftovers refuses a path that is not a folder 0.2.x leaves', () => {
  const c = cli();
  try {
    const share = path.join(c.home, '.local', 'share');
    const decoys = [
      path.join(share, 'agentlane'),
      path.join(c.home, 'agent-env'),
      path.join(c.repo, '.git', 'agentlane', 'build-cache'),
      path.join(c.home, 'not-a-repo', 'agent-env', 'build-cache'),
      `${path.join(share, 'agent-env')}/../agentlane`,
    ];
    for (const decoy of decoys) fill(path.join(decoy, 'keep'), 10);
    const results = deleteLeftovers(c.ctx, [
      { kind: 'downloads', path: decoys[0] ?? '', repository: null, bytes: 0 },
      { kind: 'downloads', path: decoys[1] ?? '', repository: null, bytes: 0 },
      { kind: 'build-cache', path: decoys[2] ?? '', repository: c.repo, bytes: 0 },
      { kind: 'build-cache', path: decoys[3] ?? '', repository: null, bytes: 0 },
      { kind: 'downloads', path: decoys[4] ?? '', repository: null, bytes: 0 },
    ]);
    assert.deepEqual(
      results.map(r => [r.outcome, r.detail]),
      decoys.map(() => ['failed', 'refused: it is not a folder 0.2.x leaves']),
    );
    for (const decoy of decoys) assert.ok(fs.existsSync(path.join(decoy, 'keep')), decoy);
  } finally {
    c.close();
  }
});

test("a .git/agent-env that is a symlink to this version's folder is neither listed nor deleted", async () => {
  const c = cli();
  try {
    const current = path.join(c.repo, '.git', 'agentlane');
    fill(path.join(current, 'build-cache', 'objects', 'keep'), 1000);
    fs.symlinkSync(current, path.join(c.repo, '.git', 'agent-env'));
    const share = path.join(c.home, '.local', 'share');
    fill(path.join(share, 'agentlane', 'maestro', 'keep'), 1000);
    fs.symlinkSync(path.join(share, 'agentlane'), path.join(share, 'agent-env'));

    const done = JSON.parse((await c.run('--yes', '--json')).stdout) as PruneReport & { leftoverResults: LeftoverResult[] };
    assert.ok(fs.existsSync(path.join(current, 'build-cache', 'objects', 'keep')), JSON.stringify(done.leftoverResults));
    assert.ok(fs.existsSync(path.join(share, 'agentlane', 'maestro', 'keep')));
    assert.deepEqual(done.leftovers, []);
    assert.deepEqual(done.leftoverResults, []);
    const direct = deleteLeftovers(c.ctx, [
      { kind: 'build-cache', path: path.join(c.repo, '.git', 'agent-env', 'build-cache'), repository: c.repo, bytes: 0 },
      { kind: 'downloads', path: path.join(share, 'agent-env'), repository: null, bytes: 0 },
    ]);
    assert.deepEqual(
      direct.map(r => [r.outcome, r.detail]),
      [
        ['failed', 'refused: it is not a folder 0.2.x leaves'],
        ['failed', 'refused: it is not a folder 0.2.x leaves'],
      ],
    );
    assert.ok(fs.existsSync(path.join(current, 'build-cache', 'objects', 'keep')));
    assert.ok(fs.existsSync(path.join(share, 'agentlane', 'maestro', 'keep')));
    assert.ok(fs.lstatSync(path.join(share, 'agent-env')).isSymbolicLink());
  } finally {
    c.close();
  }
});

test('a 0.2.x lane in the registry AGENT_ENV_STATE_DIR names keeps its device and what 0.2.x left', async () => {
  const c = cli(root => ({ AGENT_ENV_STATE_DIR: path.join(root, 'agent-env-override') }));
  try {
    const override = path.join(c.root, 'agent-env-override');
    const theirs = 'agent-env-pool-abc123';
    formerDevice(override, 'ios', theirs, c.sims.addByHand(theirs, false));
    const lane = formerLane(override, new FakeProcesses().owner(), path.join(c.root, 'their-worktree'), theirs);
    const downloads = path.join(c.home, '.local', 'share', 'agent-env');
    fill(path.join(downloads, 'maestro', 'x'), 1000);

    const done = JSON.parse((await c.run('--yes', '--json')).stdout) as PruneReport & { leftoverResults: LeftoverResult[] };
    assert.ok(done.registries.includes(override), done.registries.join(', '));
    assert.deepEqual(done.orphans, []);
    assert.deepEqual(
      done.kept.map(d => [d.name, d.laneId, d.registry]),
      [[theirs, lane, override]],
    );
    assert.match(
      done.leftoversKept ?? '',
      new RegExp(`^the registry in ${escaped(override)}, which 0\\.2\\.x may use, has lane ${lane},`),
    );
    assert.deepEqual(done.leftoverResults, []);
    assert.ok(fs.existsSync(path.join(downloads, 'maestro', 'x')));
    assert.deepEqual(names(c.sims.all()), [theirs]);
  } finally {
    c.close();
  }
});

test('with XDG_STATE_HOME elsewhere, prune still reads the registries in ~/.local/state', async () => {
  const c = cli(root => ({ XDG_STATE_HOME: path.join(root, 'xdg'), AGENTLANE_STATE_DIR: path.join(root, 'xdg', 'agentlane') }));
  try {
    const held = 'agentlane-pool-0000c1';
    formerDevice(c.own, 'ios', held, c.sims.addByHand(held, false));
    const lane = formerLane(c.own, new FakeProcesses().owner(), path.join(c.root, 'mine'), held);
    const theirs = formerLane(c.former, new FakeProcesses().owner(), c.repo);
    const downloads = path.join(c.home, '.local', 'share', 'agent-env');
    fill(path.join(downloads, 'maestro', 'x'), 1000);

    const done = JSON.parse((await c.run('--yes', '--json')).stdout) as PruneReport & { leftoverResults: LeftoverResult[] };
    assert.ok(done.registries.includes(c.own) && done.registries.includes(c.former), done.registries.join(', '));
    assert.deepEqual(done.orphans, []);
    assert.deepEqual(
      done.kept.map(d => [d.name, d.laneId, d.registry]),
      [[held, lane, c.own]],
    );
    assert.match(
      done.leftoversKept ?? '',
      new RegExp(`^the registry in ${escaped(c.former)}, which 0\\.2\\.x may use, has lane ${theirs},`),
    );
    assert.ok(fs.existsSync(path.join(downloads, 'maestro', 'x')));
    assert.deepEqual(names(c.sims.all()), [held]);
  } finally {
    c.close();
  }
});

test('a registry 0.2.x may use that is created with a lane while the leftovers are aside gets them put back', () => {
  const c = cli();
  try {
    const downloads = path.join(c.home, '.local', 'share', 'agent-env');
    const cache = path.join(c.repo, '.git', 'agent-env', 'build-cache');
    fill(path.join(downloads, 'maestro', 'x'), 1000);
    fill(path.join(cache, 'objects', 'a'), 1000);
    const report = c.report();
    assert.equal(report.leftoversKept, null);
    assert.equal(fs.existsSync(databasePath(c.former)), false);

    const steps = moveLeftoversAside(c.ctx, report.leftovers);
    assert.equal(fs.existsSync(downloads), false);
    assert.equal(fs.existsSync(cache), false);
    const lane = formerLane(c.former, new FakeProcesses().owner(), c.repo);
    const results = finishLeftovers(c.ctx, steps);

    assert.deepEqual(
      results.map(r => [r.leftover.path, r.outcome]),
      [
        [downloads, 'kept'],
        [cache, 'kept'],
      ],
    );
    assert.match(results[0]?.detail ?? '', new RegExp(`has lane ${lane}, .*, found after it was moved aside$`));
    assert.ok(fs.existsSync(path.join(downloads, 'maestro', 'x')));
    assert.ok(fs.existsSync(path.join(cache, 'objects', 'a')));
    assert.deepEqual(fs.readdirSync(path.dirname(downloads)), ['agent-env']);
    assert.deepEqual(fs.readdirSync(path.dirname(cache)), ['build-cache']);
  } finally {
    c.close();
  }
});

test('a registry reached through a symlinked AGENTLANE_STATE_DIR is opened and locked once', () => {
  const c = cli(root => ({ AGENTLANE_STATE_DIR: path.join(root, 'linked-state') }));
  try {
    const linked = path.join(c.root, 'linked-state');
    formerDevice(c.own, 'ios', 'agentlane-pool-000000', c.sims.addByHand('agentlane-pool-000000', false));
    fs.symlinkSync(c.own, linked);
    c.sims.addByHand('agent-env-pool-0000aa', false);

    const report = c.report();
    assert.deepEqual(report.registries, [linked, c.former]);
    const [orphan] = report.orphans;
    assert.ok(orphan);
    const result = deleteOrphan({ ...c.ctx, lockWaitMs: 400 }, c.backend, orphan);
    assert.deepEqual([result.outcome, result.detail], ['deleted', null]);
    assert.deepEqual(names(c.sims.all()), ['agentlane-pool-000000']);
  } finally {
    c.close();
  }
});

test('an orphan that is running when it is deleted is kept, not shut down', () => {
  const c = cli();
  try {
    const name = 'agent-env-emu-0000d1';
    c.emus.addByHand(name, true, undefined, 5584);
    const looksStopped = over(c.emus, { list: () => c.emus.list().map(d => ({ ...d, booted: false, stopped: true })) });
    const [orphan] = reportPrunable(listPrunable(null, c.own, { android: looksStopped }), c.ctx).orphans;
    assert.ok(orphan);
    assert.deepEqual(deleteOrphan(c.ctx, looksStopped, orphan), {
      device: orphan,
      outcome: 'kept',
      detail: 'it is no longer shut down',
    });
    assert.deepEqual(names(c.emus.all()), [name]);
    assert.deepEqual(c.emus.calls, []);
  } finally {
    c.close();
  }
});

const NOT_SHUT_DOWN = ['Booting', 'Shutting Down', 'A State simctl Adds Later'];

test('a simulator no registry records is deleted only while simctl lists it as Shutdown: at the listing, under the locks and at the delete', async () => {
  const c = cli();
  try {
    const xcrun = fakeXcrun(path.join(c.root, 'xcrun'));
    const sim = (name: string, state: string): FakeSimulator => ({ udid: randomUUID().toUpperCase(), name, state });
    const busy = NOT_SHUT_DOWN.map((state, i) => sim(`agentlane-pool-0000a${String(i)}`, state));
    const idle = sim('agentlane-pool-0000b0', 'Shutdown');
    await withProcessEnv({ ...isolatedEnv(c.root), PATH: xcrun.searchPath }, async () => {
      assert.deepEqual(xcrunsOn(process.env.PATH ?? ''), [path.join(xcrun.bin, 'xcrun')]);
      xcrun.set([...busy, idle]);
      const run = await c.runWith({ ios: simctlBackend }, '--yes', '--json');
      assert.equal(run.code, 0, run.stderr);
      const done = JSON.parse(run.stdout) as PruneReport & { orphanResults: OrphanResult[] };
      assert.deepEqual(
        done.orphanResults.map(r => [r.device.name, r.outcome]),
        [[idle.name, 'deleted']],
      );
      assert.deepEqual(
        done.kept.map(d => [d.name, d.reason]),
        busy.map(d => [d.name, 'no registry records it, but it is not shut down, so something may be using it']),
      );

      for (const state of NOT_SHUT_DOWN) {
        const later = sim('agentlane-pool-0000c0', 'Shutdown');
        xcrun.set([later]);
        const [orphan] = reportPrunable(listPrunable(null, c.own, { ios: simctlBackend }), c.ctx).orphans;
        assert.ok(orphan);
        assert.equal(orphan.id, later.udid);

        xcrun.set([{ ...later, state }]);
        const deletesWhatever: DeviceBackend = {
          ...simctlBackend,
          delete: id => {
            simctlBackend.delete(id);
          },
        };
        const atCheck = deleteOrphan(c.ctx, deletesWhatever, orphan);
        assert.deepEqual([atCheck.outcome, atCheck.detail], ['kept', 'it is no longer shut down'], `${state}, under the locks`);

        xcrun.set([later]);
        const startsAfterTheCheck: DeviceBackend = {
          ...simctlBackend,
          list: () => {
            const listed = simctlBackend.list();
            xcrun.set([{ ...later, state }]);
            return listed;
          },
        };
        const atDelete = deleteOrphan(c.ctx, startsAfterTheCheck, orphan);
        assert.deepEqual([atDelete.outcome, atDelete.detail], ['kept', 'it is no longer shut down'], `${state}, at the delete`);
      }
      assert.deepEqual(xcrun.deleted(), [idle.udid]);
    });
  } finally {
    c.close();
  }
});

function formerFolders(c: Cli): { share: string; downloads: string; cache: string } {
  const share = path.join(c.home, '.local', 'share');
  return { share, downloads: path.join(share, 'agent-env'), cache: path.join(c.repo, '.git', 'agent-env', 'build-cache') };
}

function asideOf(steps: readonly LeftoverStep[], target: string): string {
  const step = steps.find(s => s.leftover.path === target);
  assert.ok(step && 'aside' in step, `${target} was not moved aside`);
  return step.aside;
}

test('after a prune stopped between its two steps, the next prune --yes puts the newest copy back while a 0.2.x lane exists', async () => {
  const c = cli();
  try {
    const { share, downloads, cache } = formerFolders(c);
    const older = `${downloads}.deleting-1000000000000-aaaaaa`;
    fill(path.join(older, 'maestro', 'old'), 1000);
    fill(path.join(downloads, 'maestro', 'new'), 1000);
    fill(path.join(cache, 'objects', 'a'), 1000);
    const steps = moveLeftoversAside(c.ctx, c.report().leftovers);
    const newer = asideOf(steps, downloads);
    const cacheAside = asideOf(steps, cache);
    assert.equal(fs.existsSync(downloads), false);
    assert.equal(fs.existsSync(cache), false);
    const lane = formerLane(c.former, new FakeProcesses().owner(), c.repo);

    const run = await c.run('--yes', '--json');
    assert.equal(run.code, 0, run.stderr);
    const done = JSON.parse(run.stdout) as PruneReport & { leftoverResults: LeftoverResult[] };
    assert.match(done.leftoversKept ?? '', new RegExp(`has lane ${lane},`));
    const why = done.leftoversKept ?? '';
    assert.deepEqual(
      done.leftoverResults.map(r => [r.leftover.path, r.outcome, r.detail]),
      [
        [older, 'kept', `${why}; ${downloads} exists again, so the old copy stays at ${older}`],
        [newer, 'kept', `${why}; put back at ${downloads}`],
        [cacheAside, 'kept', `${why}; put back at ${cache}`],
      ],
    );
    assert.ok(fs.existsSync(path.join(downloads, 'maestro', 'new')));
    assert.ok(fs.existsSync(path.join(cache, 'objects', 'a')));
    assert.ok(fs.existsSync(path.join(older, 'maestro', 'old')));
    assert.deepEqual(fs.readdirSync(share).sort(), ['agent-env', path.basename(older)].sort());
    assert.deepEqual(fs.readdirSync(path.dirname(cache)), ['build-cache']);
  } finally {
    c.close();
  }
});

test('after a prune stopped between its two steps, with no 0.2.x lane the next prune --yes deletes the copies it left aside', async () => {
  const c = cli();
  try {
    const { share, downloads, cache } = formerFolders(c);
    fill(path.join(downloads, 'maestro', 'x'), 1000);
    fill(path.join(cache, 'objects', 'a'), 1000);
    const steps = moveLeftoversAside(c.ctx, c.report().leftovers);
    const asides = [asideOf(steps, downloads), asideOf(steps, cache)];

    const run = await c.run('--yes', '--json');
    assert.equal(run.code, 0, run.stderr);
    const done = JSON.parse(run.stdout) as { leftoverResults: LeftoverResult[] };
    assert.deepEqual(
      done.leftoverResults.map(r => [r.leftover.path, r.outcome]),
      asides.map(aside => [aside, 'deleted']),
    );
    assert.deepEqual(fs.readdirSync(share), []);
    assert.equal(fs.existsSync(path.dirname(cache)), false);
  } finally {
    c.close();
  }
});

test('a 0.2.x lane found at either locked check gets back the copy an earlier prune left aside', () => {
  const c = cli();
  try {
    const { downloads, cache } = formerFolders(c);
    const left = `${downloads}.deleting-1000000000000-aaaaaa`;
    fill(path.join(left, 'maestro', 'x'), 1000);
    fill(path.join(cache, 'objects', 'a'), 1000);

    const listed = c.report();
    assert.equal(listed.leftoversKept, null);
    const first = formerLane(c.former, new FakeProcesses().owner(), c.repo);
    const beforeTheMove = moveLeftoversAside(c.ctx, listed.leftovers);
    assert.deepEqual(
      beforeTheMove.map(r => [r.leftover.path, 'outcome' in r ? r.outcome : 'aside']),
      [
        [left, 'kept'],
        [cache, 'kept'],
      ],
    );
    assert.ok(fs.existsSync(path.join(downloads, 'maestro', 'x')));
    assert.equal(fs.existsSync(left), false);
    assert.ok(fs.existsSync(path.join(cache, 'objects', 'a')));

    write(c.former, store => {
      store.db.prepare('DELETE FROM claims WHERE id = ?').run(first);
    });
    fs.renameSync(downloads, left);
    const steps = moveLeftoversAside(c.ctx, c.report().leftovers);
    assert.equal(fs.existsSync(cache), false);
    formerLane(c.former, new FakeProcesses().owner(), c.repo);
    const afterTheMove = finishLeftovers(c.ctx, steps);
    assert.deepEqual(
      afterTheMove.map(r => r.outcome),
      ['kept', 'kept'],
    );
    assert.ok(fs.existsSync(path.join(downloads, 'maestro', 'x')));
    assert.ok(fs.existsSync(path.join(cache, 'objects', 'a')));
    assert.deepEqual(fs.readdirSync(path.dirname(downloads)), ['agent-env']);
    assert.deepEqual(fs.readdirSync(path.dirname(cache)), ['build-cache']);
  } finally {
    c.close();
  }
});

function commitFailsOnce<T>(run: () => T): T {
  const exec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'exec')?.value as (
    this: DatabaseSync,
    sql: string,
  ) => void;
  let armed = true;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    if (armed && sql === 'COMMIT') {
      armed = false;
      throw new Error('database or disk is full');
    }
    exec.call(this, sql);
  };
  try {
    const result = run();
    assert.equal(armed, false, 'no COMMIT ran');
    return result;
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
}

test('a prune whose lock fails to commit after it took a copy for removal still deletes it, and says so', () => {
  const c = cli();
  try {
    const { share, downloads } = formerFolders(c);
    write(c.former, () => undefined);
    fill(path.join(downloads, 'maestro', 'x'), 1000);
    const steps = moveLeftoversAside(c.ctx, c.report().leftovers);
    asideOf(steps, downloads);
    const results = commitFailsOnce(() => finishLeftovers(c.ctx, steps));
    assert.deepEqual(
      results.map(r => [r.leftover.path, r.outcome, r.detail]),
      [[downloads, 'deleted', null]],
    );
    assert.deepEqual(fs.readdirSync(share), []);
  } finally {
    c.close();
  }
});

test('a prune whose lock fails to commit after it moved a copy aside goes on to delete it', () => {
  const c = cli();
  try {
    const { share, downloads } = formerFolders(c);
    write(c.former, () => undefined);
    fill(path.join(downloads, 'maestro', 'x'), 1000);
    const steps = commitFailsOnce(() => moveLeftoversAside(c.ctx, c.report().leftovers));
    asideOf(steps, downloads);
    assert.deepEqual(
      finishLeftovers(c.ctx, steps).map(r => [r.leftover.path, r.outcome, r.detail]),
      [[downloads, 'deleted', null]],
    );
    assert.deepEqual(fs.readdirSync(share), []);
  } finally {
    c.close();
  }
});

test('a prune whose lock fails to commit after it put a copy back for a 0.2.x lane says it put it back', () => {
  const c = cli();
  try {
    const { share, downloads } = formerFolders(c);
    fill(path.join(downloads, 'maestro', 'x'), 1000);
    const aside = asideOf(moveLeftoversAside(c.ctx, c.report().leftovers), downloads);
    formerLane(c.former, new FakeProcesses().owner(), c.repo);
    const listed = c.report();
    assert.ok(listed.leftoversKept);
    const results = commitFailsOnce(() => putBackAsideCopies(c.ctx, listed.leftovers));
    assert.deepEqual(
      results.map(r => [r.leftover.path, r.outcome, r.detail]),
      [[aside, 'kept', `${listed.leftoversKept}; put back at ${downloads}`]],
    );
    assert.deepEqual(fs.readdirSync(share), ['agent-env']);
    assert.ok(fs.existsSync(path.join(downloads, 'maestro', 'x')));
  } finally {
    c.close();
  }
});

test('a copy is put back only where its real path is the one 0.2.x reads', () => {
  const c = cli();
  try {
    const { share } = formerFolders(c);
    const current = path.join(share, 'agentlane');
    fill(path.join(current, 'maestro', 'keep'), 10);
    const linkedCopy = path.join(share, 'agent-env.deleting-1000000000000-aaaaaa');
    fs.symlinkSync(current, linkedCopy);
    const git = path.join(c.repo, '.git');
    const currentCopy = path.join(git, 'agentlane', 'build-cache.deleting-1000000000000-bbbbbb');
    fill(path.join(currentCopy, 'objects', 'keep'), 10);
    fs.symlinkSync(path.join(git, 'agentlane'), path.join(git, 'agent-env'));
    formerLane(c.former, new FakeProcesses().owner(), c.repo);

    const results = putBackAsideCopies(c.ctx, [
      { kind: 'downloads', path: linkedCopy, repository: null, bytes: 0 },
      {
        kind: 'build-cache',
        path: path.join(git, 'agent-env', path.basename(currentCopy)),
        repository: c.repo,
        bytes: 0,
      },
    ]);
    assert.deepEqual(
      results.map(r => [r.outcome, r.detail?.endsWith(': refused: it is not a folder 0.2.x leaves')]),
      [
        ['kept', true],
        ['kept', true],
      ],
    );
    assert.equal(fs.existsSync(path.join(share, 'agent-env')), false);
    assert.ok(fs.lstatSync(linkedCopy).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(git, 'agentlane', 'build-cache')), false);
    assert.ok(fs.existsSync(path.join(currentCopy, 'objects', 'keep')));
  } finally {
    c.close();
  }
});

test("a device backend that doesn't say whether a device is shut down has it kept at the listing and under the locks", () => {
  const c = cli();
  try {
    const name = 'agentlane-pool-0000e0';
    const id = c.sims.addByHand(name, false);
    const silent = over(c.sims, {
      list: () =>
        c.sims.list().map(d => ({ id: d.id, name: d.name, deviceType: d.deviceType, runtime: d.runtime, booted: d.booted })),
    });
    const listed = reportPrunable(listPrunable(null, c.own, { ios: silent }), c.ctx);
    assert.deepEqual(listed.orphans, []);
    assert.deepEqual(
      listed.kept.map(d => [d.name, d.reason]),
      [[name, 'no registry records it, but it is not shut down, so something may be using it']],
    );

    const [orphan] = c.report().orphans;
    assert.ok(orphan);
    assert.equal(orphan.id, id);
    assert.deepEqual(deleteOrphan(c.ctx, silent, orphan), {
      device: orphan,
      outcome: 'kept',
      detail: 'it is no longer shut down',
    });
    assert.deepEqual(names(c.sims.all()), [name]);
    assert.deepEqual(c.sims.calls, []);
  } finally {
    c.close();
  }
});

function lanesFound(dir: string, lane: string): string {
  return `the registry in ${dir}, which 0.2.x may use, has lane ${lane}, which may be 0.2.x's; prune deletes what 0.2.x left once no such registry has lanes`;
}

function filesIn(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(entry => fs.statSync(path.join(dir, entry)).isFile())
    .sort();
}

function outcomes(results: readonly LeftoverResult[]): (string | null)[][] {
  return results.map(r => [r.leftover.path, r.outcome, r.detail]);
}

test('a 0.2.x lane found after the move gets back the folder this prune moved, over a copy whose name carries a later time', () => {
  const c = cli();
  try {
    const { share, downloads } = formerFolders(c);
    const later = `${downloads}.deleting-9999999999999-ffffff`;
    fill(path.join(later, 'maestro', 'stale'), 10);
    fill(path.join(downloads, 'maestro', 'current'), 10);
    const steps = moveLeftoversAside(c.ctx, c.report().leftovers);
    const moved = asideOf(steps, downloads);
    const lane = formerLane(c.former, new FakeProcesses().owner(), c.repo);

    const why = `${lanesFound(c.former, lane)}, found after it was moved aside`;
    assert.deepEqual(outcomes(finishLeftovers(c.ctx, steps)), [
      [downloads, 'kept', why],
      [later, 'kept', `${why}; ${downloads} exists again, so the old copy stays at ${later}`],
    ]);
    assert.deepEqual(filesIn(downloads), [path.join('maestro', 'current')]);
    assert.deepEqual(filesIn(later), [path.join('maestro', 'stale')]);
    assert.equal(fs.existsSync(moved), false);
    assert.deepEqual(fs.readdirSync(share).sort(), ['agent-env', path.basename(later)].sort());
  } finally {
    c.close();
  }
});

test('of the copies earlier prunes left, the latest by a well-formed name goes back, and an earlier-format or malformed name counts as oldest', async () => {
  const c = cli();
  try {
    const { downloads } = formerFolders(c);
    const copy = (suffix: string) => `${downloads}.deleting-${suffix}`;
    const latest = copy('1700000000000-cccccc');
    const others = [
      copy('1e0015'),
      copy('1e15-aaaaaa'),
      copy('0x1fffffffffffff-aaaaaa'),
      copy('1800000000000-aaaaaa-x'),
      copy('1000000000000-bbbbbb'),
    ];
    for (const aside of [latest, ...others]) fill(path.join(aside, 'maestro', path.basename(aside)), 10);
    const lane = formerLane(c.former, new FakeProcesses().owner(), c.repo);

    const run = await c.run('--yes', '--json');
    assert.equal(run.code, 0, run.stderr);
    const done = JSON.parse(run.stdout) as { leftoverResults: LeftoverResult[] };
    const why = lanesFound(c.former, lane);
    assert.deepEqual(
      outcomes(done.leftoverResults).sort(),
      [
        [latest, 'kept', `${why}; put back at ${downloads}`],
        ...others.map(aside => [aside, 'kept', `${why}; ${downloads} exists again, so the old copy stays at ${aside}`]),
      ].sort(),
    );
    assert.deepEqual(filesIn(downloads), [path.join('maestro', path.basename(latest))]);
  } finally {
    c.close();
  }
});

const RACES = [
  'puts back before the first checks again',
  'lists while the first deletes',
  'listed before the first took its copy for deletion',
  'finds the lane at its first check',
  'finds the lane at its second check',
] as const;

test('a prune that puts copies back never restores one another prune is deleting, and each prune reports what it did', t => {
  const installed = path.join('maestro', '2.0.0', '.installed');
  const library = path.join('maestro', '2.0.0', 'lib', 'a');
  const files = [installed, library, path.join('maestro', '2.0.0', 'lib', 'b')].sort();
  for (const race of RACES) {
    const c = cli();
    try {
      const { share, downloads } = formerFolders(c);
      for (const file of files) fill(path.join(downloads, file), 10);
      const steps = moveLeftoversAside(c.ctx, c.report().leftovers);
      const aside = asideOf(steps, downloads);
      const listedMeanwhile = c.report().leftovers;
      const second: { lane: string; deleting: string; results: LeftoverResult[] | null } = {
        lane: '',
        deleting: '',
        results: null,
      };
      const laneStarts = () => {
        second.lane = formerLane(c.former, new FakeProcesses().owner(), c.repo);
      };
      const secondPrune = (): LeftoverResult[] => {
        switch (race) {
          case 'puts back before the first checks again':
          case 'lists while the first deletes':
            laneStarts();
            return putBackAsideCopies(c.ctx, c.report().leftovers);
          case 'listed before the first took its copy for deletion':
            laneStarts();
            return putBackAsideCopies(c.ctx, listedMeanwhile);
          case 'finds the lane at its first check': {
            const listed = c.report().leftovers;
            laneStarts();
            return deleteLeftovers(c.ctx, listed);
          }
          case 'finds the lane at its second check': {
            const movedBySecond = moveLeftoversAside(c.ctx, c.report().leftovers);
            laneStarts();
            return finishLeftovers(c.ctx, movedBySecond);
          }
        }
      };
      if (race === 'puts back before the first checks again') second.results = secondPrune();

      const rm = fs.rmSync;
      let interleaved = false;
      const rmSync = t.mock.method(fs, 'rmSync', (target: fs.PathLike, options?: fs.RmOptions) => {
        if (interleaved || typeof target !== 'string' || path.dirname(target) !== share) {
          rm(target, options);
          return;
        }
        interleaved = true;
        second.deleting = target;
        const { ino } = fs.statSync(target);
        rm(path.join(target, library));
        second.results = secondPrune();
        const sameFolder = fs
          .readdirSync(share)
          .map(name => path.join(share, name))
          .find(entry => fs.lstatSync(entry).ino === ino);
        if (sameFolder !== undefined) {
          for (const entry of fs.readdirSync(sameFolder)) rm(path.join(sameFolder, entry), { recursive: true, force: true });
        }
        rm(target, options);
      });
      const first = finishLeftovers(c.ctx, steps);
      rmSync.mock.restore();

      assert.ok(second.results, `${race}: the second prune never ran`);
      const atTheLanesPath = fs.existsSync(downloads) ? filesIn(downloads) : 'absent';
      const why = lanesFound(c.former, second.lane);
      if (race === 'puts back before the first checks again') {
        assert.deepEqual(atTheLanesPath, files, race);
        assert.deepEqual(fs.readdirSync(share), ['agent-env'], race);
        assert.deepEqual(outcomes(first), [[downloads, 'gone', `${aside} no longer exists`]], race);
        assert.deepEqual(outcomes(second.results), [[aside, 'kept', `${why}; put back at ${downloads}`]], race);
        continue;
      }
      const reported = {
        'lists while the first deletes': [],
        'listed before the first took its copy for deletion': [[aside, 'gone', 'it no longer exists']],
        'finds the lane at its first check': [[second.deleting, 'kept', why]],
        'finds the lane at its second check': [[second.deleting, 'kept', `${why}, found after it was moved aside`]],
      };
      assert.equal(atTheLanesPath, 'absent', race);
      assert.deepEqual(fs.readdirSync(share), [], race);
      assert.deepEqual(outcomes(first), [[downloads, 'deleted', null]], race);
      assert.deepEqual(outcomes(second.results), reported[race], race);
    } finally {
      c.close();
    }
  }
});

const HOLDER: ProcessIdentity = { pid: 4242, start: 'Tue Nov 10 09:00:00 2026' };
const KEEPER: ProcessIdentity = { pid: KEEPER_PID, start: 'Sun Oct 11 07:00:00 2026' };

function lease(dir: string, name: string, works: readonly DeviceWork[], keeper: ProcessIdentity | null): void {
  write(dir, store => {
    const terms = (work: DeviceWork) => ({
      reservation: `${name}.${work}.${randomBytes(2).toString('hex')}`,
      work,
      holder: HOLDER,
      keeper,
      consolePort: null,
      now: Date.now(),
    });
    const [first, ...then] = works;
    assert.ok(first);
    let held = leaseDevice(store.db, name, terms(first));
    assert.ok(held, `${name} could not be leased`);
    for (const work of then) held = handOver(store.db, held, terms(work));
  });
}

interface Leased {
  dir: string;
  platform: Platform;
  name: string;
  listedAs: string;
  works: DeviceWork[];
  keeper: ProcessIdentity | null;
}

test('a device a lease holds, for any work and in any registry prune reads, is kept at the listing and under the locks, and prune --yes deletes nothing', async () => {
  const c = cli();
  try {
    const cases: Leased[] = [
      {
        dir: c.own,
        platform: 'ios',
        name: 'agentlane-pool-a00001',
        listedAs: 'agentlane-pool-a00001',
        works: ['shutdown'],
        keeper: KEEPER,
      },
      {
        dir: c.own,
        platform: 'android',
        name: 'agentlane-emu-a00002',
        listedAs: 'agentlane-emu-a00002',
        works: ['delete'],
        keeper: null,
      },
      {
        dir: c.own,
        platform: 'ios',
        name: 'agentlane-pool-a00003',
        listedAs: 'agentlane-pool-a00004',
        works: ['shutdown', 'delete'],
        keeper: KEEPER,
      },
      {
        dir: c.former,
        platform: 'ios',
        name: 'agent-env-pool-b00001',
        listedAs: 'agent-env-pool-b00001',
        works: ['delete'],
        keeper: KEEPER,
      },
      {
        dir: c.former,
        platform: 'android',
        name: 'agent-env-emu-b00002',
        listedAs: 'agent-env-emu-b00002',
        works: ['shutdown'],
        keeper: null,
      },
      {
        dir: c.former,
        platform: 'ios',
        name: 'agent-env-pool-b00003',
        listedAs: 'agent-env-pool-b00004',
        works: ['shutdown', 'delete'],
        keeper: KEEPER,
      },
    ];
    const fakes = { ios: c.sims, android: c.emus };
    const leased = cases.map(x => {
      const id = fakes[x.platform].addByHand(x.listedAs, false);
      formerDevice(x.dir, x.platform, x.name, id);
      lease(x.dir, x.name, x.works, x.keeper);
      return { ...x, id };
    });
    const holder = (x: Leased) => `a process ${x.works.at(-1) === 'delete' ? 'deleting it' : 'shutting it down'} (pid 4242)`;

    const report = c.report();
    assert.deepEqual(names(report.orphans), []);
    const kept = report.kept.map(d => [d.name, d.platform, d.id, d.laneId, d.registry, d.reason]);
    assert.deepEqual(
      kept.sort(),
      leased
        .map(x =>
          x.dir === c.own
            ? [x.name, x.platform, x.id, null, c.own, `held by ${holder(x)}`]
            : [x.listedAs, x.platform, x.id, null, c.former, `held by ${holder(x)} in the registry in ${c.former}`],
        )
        .sort(),
    );

    assert.deepEqual(
      leased.map(x => {
        const checked = deleteOrphan(c.ctx, c.devices[x.platform], {
          name: x.listedAs,
          platform: x.platform,
          id: x.id,
          paths: [],
          bytes: null,
        });
        return [x.listedAs, checked.outcome, checked.detail];
      }),
      leased.map(x => [x.listedAs, 'kept', `the registry in ${x.dir} now records it as held by ${holder(x)}`]),
    );

    const pruned = await c.run('--yes');
    assert.equal(pruned.code, 0, pruned.stderr);
    const [shutdown] = leased;
    assert.ok(shutdown);
    assert.match(
      pruned.stdout,
      new RegExp(`^  ${shutdown.name}  simulator  ${shutdown.id}  held by a process shutting it down \\(pid 4242\\)$`, 'm'),
    );
    assert.doesNotMatch(pruned.stdout, /no registry on this Mac|^deleted/m);
    const done = JSON.parse((await c.run('--yes', '--json')).stdout) as PruneReport & {
      results: PruneResult[];
      orphanResults: OrphanResult[];
    };
    assert.deepEqual([done.free, done.orphans, done.results, done.orphanResults], [[], [], [], []]);
    assert.deepEqual(names(done.kept), names(report.kept));

    assert.deepEqual([...c.sims.calls, ...c.emus.calls], []);
    assert.deepEqual([...c.sims.all(), ...c.emus.all()].map(d => d.id).sort(), leased.map(x => x.id).sort());
  } finally {
    c.close();
  }
});

interface Probe {
  work: string;
  offered: boolean;
  kept: string | null;
  checked: [string, string | null];
}

test('prune keeps a simulator while this version shuts it down, deletes it to make room or creates one outside the registry lock', async () => {
  const c = cli();
  const procs = new FakeProcesses();
  const self = procs.spawn();
  let stepped: (step: Step) => void = () => undefined;
  const r = Registry.open({
    dir: c.own,
    processes: procs,
    ports: new FakeProbe(),
    devices: c.devices,
    config: { ...DEFAULT_CONFIG, poolSize: 1 },
    self,
    onStep: step => {
      stepped(step);
    },
  });
  try {
    const probes: Probe[] = [];
    const probe = (work: string, name: string, id: string) => {
      const report = c.report();
      const checked = deleteOrphan(c.ctx, c.backend, { name, platform: 'ios', id, paths: [], bytes: null });
      probes.push({
        work,
        offered: report.orphans.some(d => d.id === id),
        kept: report.kept.find(d => d.id === id || d.name === name)?.reason ?? null,
        checked: [checked.outcome, checked.detail],
      });
    };
    const lane = (folder: string, deviceType: string, strict: boolean) => {
      const worktree = path.join(c.root, 'worktrees', folder);
      fs.mkdirSync(worktree, { recursive: true });
      return {
        owner: procs.owner(),
        worktree,
        projectRoot: worktree,
        services: [],
        device: { platform: 'ios' as const, deviceType, strict },
        waitMs: 0,
      };
    };

    const released = lane('released', 'iPhone 17', false);
    const held = (await r.claim(released)).lane;
    const device = held.device;
    assert.ok(device);
    let work: 'shutdown' | 'delete' = 'shutdown';
    const probed = new Set<string>();
    c.sims.during = (call, target) => {
      if (call !== work || target !== device.id || probed.has(call)) return;
      probed.add(call);
      probe(call, device.name, device.id);
    };
    r.release({ id: held.id, token: held.token }, released.owner);
    assert.ok(
      c.sims.all().some(d => d.id === device.id),
      'the released simulator is gone',
    );
    assert.equal(r.status().pool.find(d => d.name === device.name)?.laneId, null);

    work = 'delete';
    stepped = step => {
      if (step !== 'claim:created-device') return;
      const name =
        c.sims.calls
          .filter(call => call.startsWith('create '))
          .at(-1)
          ?.slice('create '.length) ?? '';
      probe('create', name, c.sims.all().find(d => d.name === name)?.id ?? '');
    };
    const strict = (await r.claim(lane('strict', 'iPhone 17 Pro', true))).lane;

    const by = `a process shutting it down (pid ${String(self.pid)})`;
    const retiring = `a process deleting it (pid ${String(self.pid)})`;
    assert.deepEqual(probes, [
      {
        work: 'shutdown',
        offered: false,
        kept: `held by ${by}`,
        checked: ['kept', `the registry in ${c.own} now records it as held by ${by}`],
      },
      {
        work: 'delete',
        offered: false,
        kept: `held by ${retiring}`,
        checked: ['kept', `the registry in ${c.own} now records it as held by ${retiring}`],
      },
      {
        work: 'create',
        offered: false,
        kept: 'a claim is creating it',
        checked: ['kept', `the registry in ${c.own} records it now`],
      },
    ]);
    assert.equal(strict.device?.deviceTypeName, 'iPhone 17 Pro');
    assert.deepEqual(names(c.sims.all()), [strict.device.name]);
    assert.deepEqual(
      c.sims.calls.filter(call => call.startsWith('delete ')),
      [`delete ${device.id}`],
    );
  } finally {
    r.close();
    c.close();
  }
});

const CLAIMER = path.join(import.meta.dirname, '..', 'support', 'stress-claimer.ts');

function readRegistry<T>(dir: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath(dir), { readOnly: true, timeout: 5000 });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function waitUntil(done: () => boolean, what: string): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(what);
    Atomics.wait(cell, 0, 0, 10);
  }
}

test("a release's lease that ends, and a claim that takes the simulator, between prune's locked check and its delete leave the new lane its simulator", async () => {
  const s = sharedRegistry({ ...DEFAULT_CONFIG, poolSize: 1 });
  const root = fs.realpathSync(tempDir('prune-race'));
  try {
    const env = { ...isolatedEnv(root), PATH: process.env.PATH, AGENTLANE_STATE_DIR: s.stateDir };
    const ctx: PruneContext = { env, cwd: root, lockWaitMs: 5000 };
    const claim = (folder: string): StressOp => ({
      kind: 'claim',
      worktree: s.folder(folder),
      platform: 'ios',
      device: 'iPhone 17',
      strict: false,
      boot: false,
      waitMs: 0,
    });
    const releaser = startClaimer(s.plan([claim('released'), { kind: 'release' }], { gate: ['shutdown'] }));
    const id = await s.reached('shutdown', releaser);
    const name = s.sims.all().find(d => d.id === id)?.name ?? '';
    const store = Store.openExisting(s.stateDir, 5000);
    let listing: PruneReport;
    try {
      listing = reportPrunable(listPrunable(store, s.stateDir, { ios: s.sims, android: s.emulators }), ctx);
    } finally {
      store?.close();
    }

    const next: { lane: { id: string; device: string | null } | null } = { lane: null };
    const settleAndClaim = () => {
      if (next.lane) return;
      s.open('shutdown');
      waitUntil(
        () => readRegistry(s.stateDir, db => db.prepare('SELECT COUNT(*) AS n FROM device_leases').get()?.n === 0),
        'the release never ended its lease',
      );
      const claimed = spawnSync(process.execPath, [CLAIMER, JSON.stringify(s.plan([claim('next')]))], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(claimed.status, 0, claimed.stderr);
      const line = /^claimed (.*)$/m.exec(claimed.stdout)?.[1];
      assert.ok(line, claimed.stdout);
      next.lane = JSON.parse(line) as { id: string; device: string | null };
    };
    const racing = over(s.sims, {
      delete: (target, whenRunning) => {
        settleAndClaim();
        s.sims.delete(target, whenRunning);
      },
    });
    const checked = deleteOrphan(ctx, racing, { name, platform: 'ios', id, paths: [], bytes: null });
    settleAndClaim();
    const ended = await releaser.exited;

    assert.ok(
      s.sims.all().some(d => d.id === id),
      'prune deleted the simulator the next lane claimed',
    );
    assert.equal(next.lane?.device, id);
    assert.equal(
      readRegistry(s.stateDir, db => db.prepare('SELECT claim_id FROM devices WHERE device_id = ?').get(id)?.claim_id),
      next.lane.id,
    );
    const by = `a process shutting it down (pid ${String(releaser.pid)})`;
    assert.deepEqual(
      [checked.outcome, checked.detail],
      ['kept', `the registry in ${s.stateDir} now records it as held by ${by}`],
    );
    assert.equal(
      listing.orphans.some(d => d.id === id),
      false,
      'prune offered the simulator the release was shutting down',
    );
    assert.equal(listing.kept.find(d => d.id === id)?.reason, `held by ${by}`);
    assert.equal(ended.code, 0, ended.stderr);
  } finally {
    s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
