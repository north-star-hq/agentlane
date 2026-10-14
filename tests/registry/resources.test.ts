import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Refusal } from '../../src/registry/refusal.ts';
import { databasePath } from '../../src/registry/paths.ts';
import { TEARDOWN_RETRY_MS } from '../../src/registry/resources.ts';
import type { Lane, ResourceSpec } from '../../src/registry/types.ts';
import type { World } from '../support/world.ts';
import { world } from '../support/world.ts';

const NO_DEVICE = { device: null, services: [] } as const;
const SCHEMA_0_1_3 = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'registry-0.1.3.sql'), 'utf8');

function spec(over: Partial<ResourceSpec> = {}): ResourceSpec {
  return { name: 'db', cwd: '/repo', teardown: 'drop-db', timeoutMs: 1000, env: {}, cleared: ['DATABASE_URL'], ...over };
}

async function claimed(w: World, folder = 'wt'): Promise<Lane> {
  return (await w.registry().claim(w.request(w.procs.owner(), w.folder(folder), NO_DEVICE))).lane;
}

function ref(lane: Lane) {
  return { id: lane.id, token: lane.token };
}

test('a resource starts once per lane: kept once created, created again after a failure or a dead creator, and refused while a live run holds it', async () => {
  const w = world();
  try {
    const lane = await claimed(w);
    const first = w.registry();
    assert.deepEqual(first.startResource(ref(lane), spec()), { kind: 'create', retry: null });
    const busy = (() => {
      try {
        w.registry().startResource(ref(lane), spec());
      } catch (error) {
        return error;
      }
      return null;
    })();
    assert.ok(busy instanceof Refusal && busy.code === 'resource-busy', String(busy));

    first.failResource(lane.id, 'db', 'create exited 3: make-db');
    const again = w.registry();
    assert.deepEqual(again.startResource(ref(lane), spec()), { kind: 'create', retry: 'create exited 3: make-db' });
    again.finishResource(lane.id, 'db', { DATABASE_URL: 'postgres://db/app_1' });
    const kept = w.registry().startResource(ref(lane), spec());
    assert.equal(kept.kind, 'kept');
    assert.deepEqual(kept.exports, { DATABASE_URL: 'postgres://db/app_1' });
    assert.deepEqual(w.registry().find(lane.owner, lane.worktree)?.resources, [
      { name: 'db', exports: { DATABASE_URL: 'postgres://db/app_1' } },
    ]);

    const creator = w.procs.spawn();
    w.registry({ self: creator }).startResource(ref(lane), spec({ name: 'cache' }));
    w.procs.kill(creator.pid);
    assert.deepEqual(w.registry().startResource(ref(lane), spec({ name: 'cache' })), {
      kind: 'create',
      retry: 'its last create did not finish',
    });
  } finally {
    w.close();
  }
});

test('the resources of an ended lane are leased to one reaper at a time, last created first, and a failed teardown waits for the retry interval unless its lane is named', async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const lane = (await w.registry().claim(w.request(owner, w.folder('wt'), NO_DEVICE))).lane;
    const maker = w.registry();
    for (const name of ['pg', 'db']) {
      maker.startResource(ref(lane), spec({ name }));
      maker.finishResource(lane.id, name, {});
    }
    assert.deepEqual(w.registry().takeTeardowns(), [], 'a live lane was offered for teardown');
    w.registry().release(ref(lane), owner);

    const reaper = w.registry();
    assert.deepEqual(
      reaper.takeTeardowns().map(t => t.name),
      ['db', 'pg'],
    );
    assert.deepEqual(w.registry().takeTeardowns(), [], 'a second reaper took teardowns the first one holds');

    reaper.finishTeardown(lane.id, 'db');
    reaper.failTeardown(lane.id, 'pg', 'server down');
    assert.deepEqual(
      w
        .registry()
        .pendingTeardowns()
        .map(t => [t.name, t.attempts, t.problem]),
      [['pg', 1, 'server down']],
    );
    assert.deepEqual(w.registry().takeTeardowns(), [], 'a teardown that just failed was retried at once');
    const named = w.registry();
    assert.deepEqual(
      named.takeTeardowns({ lane: lane.id }).map(t => t.name),
      ['pg'],
    );
    named.failTeardown(lane.id, 'pg', 'server down');
    await w.clock.advance(TEARDOWN_RETRY_MS);
    const later = w.registry();
    const [pg] = later.takeTeardowns();
    assert.equal(pg?.attempts, 2);
    later.finishTeardown(lane.id, 'pg');
    assert.deepEqual(w.registry().pendingTeardowns(), []);
  } finally {
    w.close();
  }
});

test('a teardown leased to a reaper that died is taken by the next one', async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const lane = (await w.registry().claim(w.request(owner, w.folder('wt'), NO_DEVICE))).lane;
    const maker = w.registry();
    maker.startResource(ref(lane), spec());
    maker.finishResource(lane.id, 'db', {});
    w.registry().release(ref(lane), owner);
    const doomed = w.procs.spawn();
    assert.equal(w.registry({ self: doomed }).takeTeardowns().length, 1);
    w.procs.kill(doomed.pid);
    assert.deepEqual(
      w
        .registry()
        .takeTeardowns()
        .map(t => t.name),
      ['db'],
    );
  } finally {
    w.close();
  }
});

function tableSql(db: DatabaseSync): Map<string, string> {
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  return new Map(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'")
      .all()
      .map(row => [String(row.name), normalize(String(row.sql))]),
  );
}

test("a registry this version uses stays format 1, keeps 0.1.3's tables as 0.1.3 made them, and a lane 0.1.3 deletes leaves its resources for this version to tear down", async () => {
  const w = world();
  try {
    const owner = w.procs.owner();
    const lane = (await w.registry().claim(w.request(owner, w.folder('wt'), NO_DEVICE))).lane;
    const maker = w.registry();
    maker.startResource(ref(lane), spec());
    maker.finishResource(lane.id, 'db', { DATABASE_URL: 'postgres://db/app_1' });

    const reference = new DatabaseSync(':memory:');
    reference.exec(SCHEMA_0_1_3);
    const old = new DatabaseSync(databasePath(w.dir));
    try {
      assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 1, '0.1.3 refuses any other format');
      const ours = tableSql(old);
      for (const [name, sql] of tableSql(reference)) assert.equal(ours.get(name), sql, `table ${name} differs from 0.1.3's`);
      assert.deepEqual(
        old.prepare('PRAGMA foreign_key_list(resources)').all(),
        [],
        "a foreign key from resources to claims would let 0.1.3's lane delete cascade the teardown records away",
      );
      old.exec('PRAGMA foreign_keys = ON');
      old.prepare('DELETE FROM claims WHERE id = ?').run(lane.id);
    } finally {
      old.close();
      reference.close();
    }
    const [pending] = w.registry().takeTeardowns();
    assert.equal(pending?.lane, lane.id);
    assert.deepEqual(pending.exports, { DATABASE_URL: 'postgres://db/app_1' });
  } finally {
    w.close();
  }
});

test('a registry 0.1.3 created gains the resources table when this version opens it, and stays format 1', async () => {
  const w = world();
  try {
    fs.mkdirSync(w.dir, { recursive: true });
    const old = new DatabaseSync(databasePath(w.dir));
    old.exec(SCHEMA_0_1_3);
    old.exec('PRAGMA user_version = 1');
    old.close();

    const lane = await claimed(w);
    const registry = w.registry();
    assert.equal(registry.startResource(ref(lane), spec()).kind, 'create');
    const db = new DatabaseSync(databasePath(w.dir));
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.ok(tableSql(db).has('resources'));
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});
