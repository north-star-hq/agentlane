import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BROWSER_DEBUG_SERVICE, BROWSER_STREAM_SERVICE } from '../../src/browser/kinds.ts';
import { databasePath } from '../../src/registry/paths.ts';
import { browserSession } from '../../src/registry/registry.ts';
import type { RegistryConfig } from '../../src/registry/config.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import { world } from '../support/world.ts';

const SCHEMA_0_1_3 = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'registry-0.1.3.sql'), 'utf8');
const BLOCKS: Partial<RegistryConfig> = {
  blocks: { ...DEFAULT_CONFIG.blocks, browser: { first: 20_400, last: 20_405 } },
};
const WEB = { device: null, services: [{ name: 'site', type: 'web' }] } as const;

test("a browser lane holds its own session and debugging port, agent-browser's a stream port too, beside a device, and a release frees the ports", async () => {
  const w = world(BLOCKS);
  try {
    const a = w.procs.owner();
    const b = w.procs.owner();
    const first = await w.registry().claim(w.request(a, w.folder('one'), { ...WEB, browser: { driver: 'playwright' } }));
    const second = await w.registry().claim(w.request(b, w.folder('two'), { ...WEB, browser: { driver: 'agent-browser' } }));
    assert.ok(first.lane.browser && second.lane.browser);
    assert.equal(first.lane.browser.session, browserSession(first.lane.id));
    assert.equal(first.lane.browser.driver, 'playwright');
    assert.equal(first.lane.browser.streamPort, null);
    assert.equal(second.lane.browser.driver, 'agent-browser');
    assert.notEqual(second.lane.browser.streamPort, null);
    const ports = [first.lane, second.lane].flatMap(c =>
      c.ports.filter(p => p.service === BROWSER_DEBUG_SERVICE || p.service === BROWSER_STREAM_SERVICE).map(p => p.port),
    );
    assert.equal(new Set(ports).size, 3, `the browsers share a port: ${ports.join(', ')}`);
    assert.ok(ports.every(p => p >= 20_400 && p <= 20_405));
    assert.equal(first.lane.browser.debugPort, first.lane.ports.find(p => p.service === BROWSER_DEBUG_SERVICE)?.port);

    const both = await w.registry().claim(w.request(a, w.folder('one')));
    assert.equal(both.lane.id, first.lane.id, 'a device up on a web lane made a second lane');
    assert.notEqual(both.lane.device, null);
    assert.deepEqual(both.lane.browser, first.lane.browser, 'the device up changed the browser');

    const changed = await w.registry().claim(w.request(a, w.folder('one'), { ...WEB, browser: { driver: 'agent-browser' } }));
    assert.ok(changed.lane.browser);
    assert.equal(changed.lane.browser.driver, 'agent-browser');
    assert.equal(changed.replacedDriver, 'playwright');
    assert.notEqual(changed.lane.browser.streamPort, null);

    w.registry().releaseOwn(a, null, []);
    assert.deepEqual(
      w
        .registry()
        .endedBrowsers()
        .map(e => e.lane),
      [first.lane.id],
      'a released lane leaves its browser for the sweep, which forgets it once nothing of it runs',
    );
    const third = await w
      .registry()
      .claim(w.request(w.procs.owner(), w.folder('three'), { ...WEB, browser: { driver: 'agent-browser' } }));
    const freed = third.lane.ports.filter(p => p.service.startsWith('browser')).map(p => p.port);
    assert.equal(freed.length, 2, "the released lane's browser ports were not freed");
    w.registry().forgetBrowser(first.lane.id);
    assert.deepEqual(w.registry().endedBrowsers(), []);
  } finally {
    w.close();
  }
});

test('a project service named browser is refused, since the lane names its browser ports so', async () => {
  const w = world(BLOCKS);
  try {
    await assert.rejects(
      w
        .registry()
        .claim(w.request(w.procs.owner(), w.folder('x'), { device: null, services: [{ name: 'browser', type: 'web' }] })),
      /browser/,
    );
  } finally {
    w.close();
  }
});

test("the browsers table keeps the registry format 1 and 0.1.3's tables as 0.1.3 made them, with no foreign key, so a lane 0.1.3 deletes leaves its browser for this version to stop", async () => {
  const w = world(BLOCKS);
  try {
    const owner = w.procs.owner();
    const { lane } = await w.registry().claim(w.request(owner, w.folder('wt'), { ...WEB, browser: { driver: 'playwright' } }));
    const reference = new DatabaseSync(':memory:');
    reference.exec(SCHEMA_0_1_3);
    const old = new DatabaseSync(databasePath(w.dir));
    try {
      assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 1, '0.1.3 refuses any other format');
      const sqlOf = (db: DatabaseSync, name: string) =>
        (
          db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql?: string } | undefined
        )?.sql
          ?.replace(/\s+/g, ' ')
          .trim();
      for (const row of reference.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        const name = String(row.name);
        if (name === 'sqlite_sequence') continue;
        assert.equal(sqlOf(old, name), sqlOf(reference, name), `table ${name} differs from 0.1.3's`);
      }
      assert.deepEqual(old.prepare('PRAGMA foreign_key_list(browsers)').all(), []);
      const listed = old
        .prepare('SELECT id FROM claims')
        .all()
        .map(r => String(r.id));
      assert.deepEqual(listed, [lane.id], "0.1.3's status query reads the lane");
      old.exec('PRAGMA foreign_keys = ON');
      old.prepare('DELETE FROM claims WHERE id = ?').run(lane.id);
    } finally {
      old.close();
      reference.close();
    }
    const [ended] = w.registry().endedBrowsers();
    assert.equal(ended?.lane, lane.id);
    assert.equal(ended.session, browserSession(lane.id));
  } finally {
    w.close();
  }
});

test('a registry 0.1.3 created gains the browsers table when this version opens it, and stays format 1', async () => {
  const w = world(BLOCKS);
  try {
    fs.mkdirSync(w.dir, { recursive: true });
    const old = new DatabaseSync(databasePath(w.dir));
    old.exec(SCHEMA_0_1_3);
    old.exec('PRAGMA user_version = 1');
    old.close();
    const { lane } = await w
      .registry()
      .claim(w.request(w.procs.owner(), w.folder('wt'), { ...WEB, browser: { driver: 'playwright' } }));
    assert.notEqual(lane.browser, null);
    const db = new DatabaseSync(databasePath(w.dir));
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browsers').get()?.n, 1);
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});
