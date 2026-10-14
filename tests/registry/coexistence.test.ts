import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createEmulatorBackend, findAndroidSdk } from '../../src/devices/emulator.ts';
import { DeviceBackendError } from '../../src/devices/backend.ts';
import { enginePaths } from '../../src/driver/paths.ts';
import { FORMER } from '../../src/name.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import { describeOwner, ownerKey, type Owner } from '../../src/registry/owner.ts';
import { databasePath, diskNames, lanesRoot, stateDir } from '../../src/registry/paths.ts';
import { Registry } from '../../src/registry/registry.ts';
import { Refusal } from '../../src/registry/refusal.ts';
import { Store } from '../../src/registry/store.ts';
import { laneDir } from '../../src/up/lane-files.ts';
import { FakeClock, FakeDevices, FakeProbe, FakeProcesses, tempDir } from '../support/fakes.ts';
import { portBlock } from '../support/ports.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const FORMER_CLI = process.env.AGENTLANE_FORMER_CLI;
const BLOCKS = {
  metro: { first: 21_100, last: 21_103 },
  api: { first: 21_200, last: 21_203 },
  web: { first: 21_300, last: 21_303 },
  browser: { first: 21_400, last: 21_405 },
};

interface Mac {
  xdg: string;
  procs: FakeProcesses;
  probe: FakeProbe;
  sims: FakeDevices;
  emulators: FakeDevices;
  registry(dir: string): Registry;
  folder(name: string): string;
  close(): void;
}

function mac(): Mac {
  const root = tempDir('coexistence');
  const procs = new FakeProcesses();
  const probe = new FakeProbe();
  const clock = new FakeClock();
  const sims = new FakeDevices(path.join(root, 'sims'));
  const emulators = new FakeDevices(path.join(root, 'emulators'), 'android');
  const open: Registry[] = [];
  return {
    xdg: path.join(root, 'xdg'),
    procs,
    probe,
    sims,
    emulators,
    registry(dir) {
      const registry = Registry.open({
        dir,
        processes: procs,
        ports: probe,
        devices: { ios: sims, android: emulators },
        config: { ...DEFAULT_CONFIG, blocks: BLOCKS },
        clock,
        pollMs: 500,
        self: procs.spawn(),
      });
      open.push(registry);
      return registry;
    },
    folder(name) {
      const folder = path.join(root, 'worktrees', name);
      fs.mkdirSync(folder, { recursive: true });
      return folder;
    },
    close() {
      for (const r of open) r.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

interface FormerLane {
  id: string;
  ports: number[];
  device: string;
  session: string;
}

/** A lane as 0.2.x writes it: its row, its ports, its pool simulator and its browser, with 0.2.x's statements. */
function formerLane(dir: string, owner: Owner, worktree: string, deviceId: string, device: string): FormerLane {
  const store = Store.open(dir, 5000);
  const id = randomBytes(4).toString('hex');
  const session = `${FORMER.tool}-${id}`;
  const ports = [BLOCKS.metro.first, BLOCKS.api.first, BLOCKS.browser.first];
  const now = Date.now();
  try {
    store.write(() => {
      const db = store.db;
      db.prepare(
        `INSERT INTO claims (id, token, owner_key, owner_kind, owner_pid, owner_start, owner_session, owner_thread,
           project_root, worktree, created_at, last_used_at, last_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        randomBytes(24).toString('base64url'),
        ownerKey(owner),
        owner.kind,
        owner.process?.pid ?? null,
        owner.process?.start ?? null,
        null,
        null,
        worktree,
        worktree,
        now,
        now,
        'claim',
      );
      const insertPort = db.prepare('INSERT INTO ports (port, type, service, claim_id) VALUES (?, ?, ?, ?)');
      insertPort.run(ports[0] ?? 0, 'metro', 'metro', id);
      insertPort.run(ports[1] ?? 0, 'api', 'api', id);
      insertPort.run(ports[2] ?? 0, 'browser', 'browser', id);
      db.prepare('INSERT INTO browsers (claim_id, driver, session, worktree, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        'playwright',
        session,
        worktree,
        now,
      );
      db.prepare(
        `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
           creator_pid, creator_start, claim_id, created_at)
         VALUES (?, 'ios', ?, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', 'iPhone 17',
           'com.apple.CoreSimulator.SimRuntime.iOS-26-5', 'iOS 26.5', NULL, NULL, ?, ?)`,
      ).run(device, deviceId, id, now);
    });
  } finally {
    store.close();
  }
  return { id, ports, device, session };
}

function freeFormerDevice(dir: string, deviceId: string, name: string): void {
  const store = Store.open(dir, 5000);
  try {
    store.write(() => {
      store.db
        .prepare(
          `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
             creator_pid, creator_start, claim_id, created_at)
           VALUES (?, 'ios', ?, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', 'iPhone 17',
             'com.apple.CoreSimulator.SimRuntime.iOS-26-5', 'iOS 26.5', NULL, NULL, NULL, ?)`,
        )
        .run(name, deviceId, Date.now());
    });
  } finally {
    store.close();
  }
}

function schemaOf(dir: string): { version: number; tables: string[] } {
  const store = Store.open(dir, 5000);
  try {
    const version = store.db.prepare('PRAGMA user_version').get()?.user_version;
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map(row => String(row.name));
    return { version: Number(version), tables };
  } finally {
    store.close();
  }
}

test("the registry is 0.2.x's while only 0.2.x has one on this Mac, and this version's own once it has one", () => {
  const m = mac();
  try {
    const own = path.join(m.xdg, 'agentlane');
    const former = path.join(m.xdg, FORMER.tool);
    assert.equal(stateDir({ XDG_STATE_HOME: m.xdg }), own);
    Store.open(former, 5000).close();
    assert.equal(stateDir({ XDG_STATE_HOME: m.xdg }), former, "0.2.x's registry is the only one, so both versions share it");
    Store.open(own, 5000).close();
    assert.equal(stateDir({ XDG_STATE_HOME: m.xdg }), own);
    assert.equal(stateDir({ XDG_STATE_HOME: m.xdg, AGENTLANE_STATE_DIR: '/elsewhere' }), '/elsewhere');
  } finally {
    m.close();
  }
});

test("in 0.2.x's folder this version writes 0.2.x's names, which 0.2.x reads; in its own folder, its own", () => {
  const m = mac();
  try {
    const former = path.join(m.xdg, FORMER.tool);
    const own = path.join(m.xdg, 'agentlane');
    assert.equal(lanesRoot(former), path.join(former, 'claims'));
    assert.equal(laneDir(former, '0a1b2c3d'), path.join(former, 'claims', '0a1b2c3d'));
    assert.equal(enginePaths(former, '0a1b2c3d').shots, path.join(former, 'claims', '0a1b2c3d', 'shots'));
    assert.match(path.basename(path.dirname(enginePaths(former, '0a1b2c3d', '/t').socket)), /^(driver|agent-env-[0-9a-f]{16})$/);
    assert.deepEqual(diskNames(former).pool, { ios: 'agent-env-pool-', android: 'agent-env-emu-' });
    assert.equal(lanesRoot(own), path.join(own, 'lanes'));
    assert.deepEqual(diskNames(own).pool, { ios: 'agentlane-pool-', android: 'agentlane-emu-' });
    const deep = path.join(m.xdg, 'x'.repeat(80), FORMER.tool);
    assert.match(path.basename(path.dirname(enginePaths(deep, '0a1b2c3d', '/t').socket)), /^agent-env-[0-9a-f]{16}$/);
  } finally {
    m.close();
  }
});

test("in 0.2.x's folder a new pool simulator and emulator get 0.2.x's names, and the registry keeps 0.2.x's format", async () => {
  const m = mac();
  try {
    const former = path.join(m.xdg, FORMER.tool);
    const own = path.join(m.xdg, 'agentlane');
    Store.open(former, 5000).close();
    const before = schemaOf(former);
    const sim = await m.registry(former).claim({
      owner: m.procs.owner(),
      worktree: m.folder('sim'),
      projectRoot: m.folder('sim'),
      services: [],
      device: { platform: 'ios' },
      waitMs: 0,
    });
    assert.match(sim.lane.device?.name ?? '', /^agent-env-pool-[0-9a-f]{6}$/);
    const emu = await m.registry(former).claim({
      owner: m.procs.owner(),
      worktree: m.folder('emu'),
      projectRoot: m.folder('emu'),
      services: [],
      device: { platform: 'android' },
      waitMs: 0,
    });
    assert.match(emu.lane.device?.name ?? '', /^agent-env-emu-[0-9a-f]{6}$/);
    assert.deepEqual(schemaOf(former), before, 'this version changed the registry 0.2.x reads');
    assert.equal(before.version, 1);
    const mine = await m.registry(own).claim({
      owner: m.procs.owner(),
      worktree: m.folder('mine'),
      projectRoot: m.folder('mine'),
      services: [],
      device: { platform: 'ios' },
      waitMs: 0,
    });
    assert.match(mine.lane.device?.name ?? '', /^agentlane-pool-[0-9a-f]{6}$/);
  } finally {
    m.close();
  }
});

test('a lane 0.2.x holds keeps its ports, simulator and browser while this version claims beside it, and a free 0.2.x pool simulator is adopted', async () => {
  const m = mac();
  try {
    const former = path.join(m.xdg, FORMER.tool);
    const theirs = m.procs.owner();
    const heldId = m.sims.addByHand('agent-env-pool-aaaaaa', true);
    const freeId = m.sims.addByHand('agent-env-pool-bbbbbb', false);
    const old = formerLane(former, theirs, m.folder('theirs'), heldId, 'agent-env-pool-aaaaaa');
    freeFormerDevice(former, freeId, 'agent-env-pool-bbbbbb');
    const dir = stateDir({ XDG_STATE_HOME: m.xdg });
    assert.equal(dir, former);

    const me = m.procs.owner();
    const registry = m.registry(dir);
    const out = await registry.claim({
      owner: me,
      worktree: m.folder('mine'),
      projectRoot: m.folder('mine'),
      services: [
        { name: 'metro', type: 'metro' },
        { name: 'api', type: 'api' },
      ],
      device: { platform: 'ios' },
      browser: { driver: 'playwright' },
      waitMs: 0,
    });
    const mine = out.lane.ports.map(p => p.port);
    assert.deepEqual(
      mine.filter(p => old.ports.includes(p)),
      [],
      `this version handed out a port 0.2.x holds: ${mine.join(', ')}`,
    );
    assert.equal(out.lane.device?.name, 'agent-env-pool-bbbbbb', "the free 0.2.x simulator wasn't adopted");
    assert.ok(!m.sims.calls.some(c => c.startsWith('create')), 'a simulator was created though a free one was in the pool');
    assert.notEqual(out.lane.browser?.session, old.session);
    assert.deepEqual(out.freed, []);
    assert.deepEqual(out.tookOver, []);

    const status = registry.status();
    const held = status.lanes.find(l => l.id === old.id);
    assert.ok(held, 'the 0.2.x lane is gone from the registry');
    assert.equal(held.device?.name, 'agent-env-pool-aaaaaa');
    assert.deepEqual(held.ports.map(p => p.port).sort(), [...old.ports].sort());
    assert.equal(held.browser?.session, old.session);
    assert.ok(!m.sims.calls.some(c => c.includes(heldId)), `this version acted on 0.2.x's simulator: ${m.sims.calls.join('; ')}`);

    assert.throws(() => registry.releaseById(old.id, me, false), Refusal, "this version released a live 0.2.x owner's lane");
    const ended = registry.releaseOwn(me, null);
    assert.deepEqual(
      ended.map(e => e.id),
      [out.lane.id],
    );
    assert.ok(
      registry.status().lanes.some(l => l.id === old.id),
      `releasing this version's lane ended 0.2.x's: ${describeOwner(theirs)}`,
    );
  } finally {
    m.close();
  }
});

test("the emulator backend stops 0.2.x's pool emulators, and still refuses AVDs the registry never made", () => {
  const home = tempDir('coexistence-sdk');
  const root = path.join(home, 'sdk');
  for (const tool of ['platform-tools/adb', 'emulator/emulator', 'cmdline-tools/latest/bin/avdmanager']) {
    fs.mkdirSync(path.dirname(path.join(root, tool)), { recursive: true });
    fs.writeFileSync(path.join(root, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  try {
    const sdk = findAndroidSdk({ ANDROID_HOME: root, HOME: home });
    assert.ok(sdk);
    const backend = createEmulatorBackend({ env: {}, logDir: path.join(home, 'logs'), sdk });
    for (const name of ['agent-env-emu-0a1b2c', 'agentlane-emu-0a1b2c']) {
      assert.doesNotThrow(() => {
        backend.shutdown(name);
      }, `${name} was refused`);
    }
    for (const name of ['agent-env-pool-0a1b2c', 'agent-env-emu-a', 'my-pixel-api36']) {
      assert.throws(() => {
        backend.shutdown(name);
      }, DeviceBackendError);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
}

function run(cli: string, args: string[], env: NodeJS.ProcessEnv): { code: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

interface Listed {
  id: string;
  ports: { port: number }[];
}

test(
  "0.2.x's own build and this one share the registry: neither hands out the other's ports, and each releases only its own lane",
  { skip: !FORMER_CLI && 'set AGENTLANE_FORMER_CLI to a 0.2.x build, such as <checkout>/dist/cli.js' },
  async () => {
    const formerCli = FORMER_CLI ?? '';
    const base = await portBlock();
    const root = tempDir('coexistence-cli');
    const xdg = path.join(root, 'xdg');
    const former = path.join(xdg, FORMER.tool);
    fs.mkdirSync(former, { recursive: true });
    fs.writeFileSync(
      path.join(former, 'config.json'),
      JSON.stringify({ ports: { metro: [base, base + 3], api: [base + 10, base + 13], web: [base + 20, base + 23] } }),
    );
    const folder = (name: string) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const a = sleeper();
    const b = sleeper();
    try {
      const formerEnv = { AGENT_ENV_STATE_DIR: former, AGENT_ENV_OWNER_PID: String(a.pid) };
      const ownEnv = { XDG_STATE_HOME: xdg, AGENTLANE_OWNER_PID: String(b.pid) };
      const theirs = run(formerCli, ['claim', '--no-device', '--worktree', folder('theirs'), '--json'], formerEnv);
      assert.equal(theirs.code, 0, theirs.err);
      assert.ok(fs.existsSync(databasePath(former)));
      const mine = run(CLI, ['claim', '--no-device', '--worktree', folder('mine'), '--json'], ownEnv);
      assert.equal(mine.code, 0, mine.err);
      assert.equal(fs.existsSync(path.join(xdg, 'agentlane')), false, 'this version made a second registry');
      const theirPorts = (JSON.parse(theirs.out) as { claim: Listed }).claim.ports.map(p => p.port);
      const myPorts = (JSON.parse(mine.out) as { lane: Listed }).lane.ports.map(p => p.port);
      assert.deepEqual(
        myPorts.filter(p => theirPorts.includes(p)),
        [],
      );

      const listedByFormer = run(formerCli, ['claims', '--json'], formerEnv);
      assert.equal(listedByFormer.code, 0, listedByFormer.err);
      const formerSees = (JSON.parse(listedByFormer.out) as { claims: Listed[] }).claims;
      const myId = (JSON.parse(mine.out) as { lane: Listed }).lane.id;
      assert.ok(
        formerSees.some(c => c.id === myId),
        "0.2.x can't see this version's lane",
      );

      const again = run(formerCli, ['claim', '--no-device', '--worktree', folder('theirs-2'), '--json'], formerEnv);
      assert.equal(again.code, 0, again.err);
      const againPorts = (JSON.parse(again.out) as { claim: Listed }).claim.ports.map(p => p.port);
      assert.deepEqual(
        againPorts.filter(p => myPorts.includes(p)),
        [],
        "0.2.x handed out this version's ports",
      );

      const released = run(formerCli, ['release', '--worktree', folder('theirs')], formerEnv);
      assert.equal(released.code, 0, released.err);
      const after = run(CLI, ['lanes', '--json'], ownEnv);
      assert.equal(after.code, 0, after.err);
      const lanes = (JSON.parse(after.out) as { lanes: Listed[] }).lanes.map(l => l.id);
      assert.ok(lanes.includes(myId), "0.2.x's release ended this version's lane");

      const mineReleased = run(CLI, ['release', '--worktree', folder('mine')], ownEnv);
      assert.equal(mineReleased.code, 0, mineReleased.err);
      const left = (JSON.parse(run(formerCli, ['claims', '--json'], formerEnv).out) as { claims: Listed[] }).claims;
      assert.deepEqual(
        left.map(c => c.id),
        [(JSON.parse(again.out) as { claim: Listed }).claim.id],
      );
      run(formerCli, ['release', '--worktree', folder('theirs-2')], formerEnv);
    } finally {
      a.kill();
      b.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
