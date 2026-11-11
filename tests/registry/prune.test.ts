import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DeviceBackend, DeviceDisk, Platform } from '../../src/devices/backend.ts';
import { DeviceBackendError } from '../../src/devices/backend.ts';
import { ownerKey, type Owner } from '../../src/registry/owner.ts';
import { databasePath, stateDir } from '../../src/registry/paths.ts';
import type {
  LeftoverResult,
  OrphanResult,
  PruneContext,
  PruneListing,
  PruneReport,
  PruneResult,
} from '../../src/registry/prune.ts';
import { deleteLeftovers, deleteOrphan, listPrunable, reportPrunable } from '../../src/registry/prune.ts';
import { Refusal, UsageError } from '../../src/registry/refusal.ts';
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
  report(): PruneReport;
  close(): void;
}

function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const made = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
}

function fill(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

/** Every folder prune reads or deletes in sits under a temporary home. */
function cli(): Cli {
  const root = fs.realpathSync(tempDir('prune-cli'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  gitInit(repo);
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
  const env = {
    HOME: home,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    AGENTLANE_STATE_DIR: own,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
  };
  const ctx: PruneContext = { env, cwd: repo, lockWaitMs: 5000 };
  return {
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
    async run(...args) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runRegistryCommand('prune', args, {
        env,
        cwd: repo,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        processes: new FakeProcesses(),
        ports: new FakeProbe(),
        devices,
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

/**
 * This version's registry with a lane holding a simulator, 0.2.x's registry with a free emulator and no lanes, two
 * orphans, a booted orphan, a device with no pool name, and what 0.2.x left in the data folder and two repositories.
 */
function disked(c: Cli): { held: string; laneId: string; other: string; repo2: string } {
  const held = 'agentlane-pool-111111';
  formerDevice(c.own, 'ios', held, c.sims.addByHand(held, false));
  const repo2 = path.join(path.dirname(c.repo), 'repo2');
  gitInit(repo2);
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
      json.kept.map(d => [d.name, d.laneId, d.reason]).sort(),
      [
        [held, laneId, `held by lane ${laneId}`],
        ['agentlane-pool-cccccc', null, 'no registry records it, but it is booted, so something may be using it'],
        [other, null, `the registry in ${c.former} records it`],
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

test('a device a registry records, or that is gone, by the deletion is kept, and every registry stays locked while one is deleted', () => {
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

    const locked: Record<string, boolean> = {};
    const watched = over(c.sims, {
      delete: id => {
        for (const dir of [c.own, c.former]) {
          try {
            write(dir, () => undefined, 50);
            locked[dir] = false;
          } catch (error) {
            assert.ok(error instanceof Refusal && error.code === 'registry-busy', String(error));
            locked[dir] = true;
          }
        }
        c.sims.delete(id);
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
    assert.deepEqual(locked, { [c.own]: true, [c.former]: true });
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
    const booting = over(c.sims, { list: () => c.sims.list().map(d => (d.id === id ? { ...d, booted: true } : d)) });
    assert.deepEqual(deleteOrphan(c.ctx, booting, orphan), {
      device: orphan,
      outcome: 'kept',
      detail: 'it was booted after the listing',
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
    const reason = `the registry in ${c.former}, the one 0.2.x reads, has lane ${lane}, which may be 0.2.x's; prune deletes what 0.2.x left once that registry has no lanes`;
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
