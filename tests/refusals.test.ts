import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Owner } from '../src/registry/owner.ts';
import type { RefusalCode } from '../src/registry/refusal.ts';
import { NotClaimed, Refusal, REFUSAL_CODES } from '../src/registry/refusal.ts';
import { Store } from '../src/registry/store.ts';
import type { World } from './support/world.ts';
import { world } from './support/world.ts';

const NO_DEVICE = { device: null } as const;
const RUNNABLE = /^(node_modules\/\.bin\/agentlane \w|kill \d|lsof |set ")/;

async function refusalOf(action: () => unknown): Promise<Refusal> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  assert.fail('no refusal was raised');
}

type Scenario = (w: World) => Promise<{ refusal: Refusal; holderFolder: string }>;

const scenarios: Record<RefusalCode, Scenario> = {
  'pool-busy': async w => {
    const held = await w.registry().claim(w.request(w.procs.owner(), w.folder('holder')));
    const refusal = await refusalOf(() => w.registry().claim(w.request(w.procs.owner(), w.folder('late'))));
    return { refusal, holderFolder: held.lane.worktree };
  },
  'ports-exhausted': async w => {
    const services = [{ name: 'web', type: 'web' }];
    const held = await w.registry().claim(w.request(w.procs.owner(), w.folder('holder'), { ...NO_DEVICE, services }));
    const refusal = await refusalOf(() =>
      w.registry().claim(w.request(w.procs.owner(), w.folder('late'), { ...NO_DEVICE, services })),
    );
    return { refusal, holderFolder: held.lane.worktree };
  },
  'held-by-live-owner': async w => {
    const held = await w.registry().claim(w.request(w.procs.owner(), w.folder('holder'), NO_DEVICE));
    const refusal = await refusalOf(() => w.registry().releaseById(held.lane.id, w.procs.owner(), false));
    return { refusal, holderFolder: held.lane.worktree };
  },
  'owner-unknown': async w => {
    const codex: Owner = { kind: 'codex', process: null, sessionId: null, threadId: 'thread-9' };
    const held = await w.registry().claim(w.request(codex, w.folder('holder'), NO_DEVICE));
    const refusal = await refusalOf(() => w.registry().releaseById(held.lane.id, w.procs.owner(), false));
    return { refusal, holderFolder: held.lane.worktree };
  },
  'lane-gone': async w => {
    const owner = w.procs.owner();
    const gone = await w.registry().claim(w.request(owner, w.folder('gone'), NO_DEVICE));
    w.registry().release({ id: gone.lane.id, token: gone.lane.token }, owner);
    const refusal = await refusalOf(() => w.registry().touch({ id: gone.lane.id, token: gone.lane.token }, 'look'));
    return { refusal, holderFolder: gone.lane.worktree };
  },
  'token-mismatch': async w => {
    const held = await w.registry().claim(w.request(w.procs.owner(), w.folder('holder'), NO_DEVICE));
    const refusal = await refusalOf(() => w.registry().touch({ id: held.lane.id, token: 'forged' }, 'look'));
    return { refusal, holderFolder: held.lane.worktree };
  },
  'resource-busy': async w => {
    const owner = w.procs.owner();
    const held = await w.registry().claim(w.request(owner, w.folder('holder'), NO_DEVICE));
    const ref = { id: held.lane.id, token: held.lane.token };
    const spec = { name: 'db', cwd: held.lane.worktree, teardown: 'true', timeoutMs: 1000, env: {}, cleared: [] };
    w.registry().startResource(ref, spec);
    const refusal = await refusalOf(() => w.registry().startResource(ref, spec));
    return { refusal, holderFolder: held.lane.worktree };
  },
  'registry-busy': async w => {
    const owner = w.procs.owner();
    const held = await w.registry().claim(w.request(owner, w.folder('holder'), NO_DEVICE));
    const locker = Store.open(w.dir, 1000);
    locker.actor = { who: 'claude session locking (pid 1)', folder: w.folder('locker') };
    try {
      const refusal = await locker.write(() =>
        refusalOf(() => w.registry({ lockWaitMs: 150 }).touch({ id: held.lane.id, token: held.lane.token }, 'look')),
      );
      return { refusal, holderFolder: w.folder('locker') };
    } finally {
      locker.close();
    }
  },
};

test('every refusal code has a scenario here, and every Refusal raised in the source uses one of them', () => {
  assert.deepEqual(Object.keys(scenarios).sort(), [...REFUSAL_CODES].sort());
  const src = path.resolve(import.meta.dirname, '..', 'src');
  const used = new Set<string>();
  const files = fs.readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    for (const m of text.matchAll(/new Refusal\(\s*'([a-z-]+)'/g)) used.add(m[1] ?? '');
  }
  assert.ok(used.size > 0);
  for (const code of used) assert.ok(code in scenarios, `src raises '${code}', which has no scenario`);
  for (const code of REFUSAL_CODES) assert.ok(used.has(code), `'${code}' is listed but never raised`);
});

for (const code of REFUSAL_CODES) {
  test(`refusal '${code}' names the holder (who, folder, start time) and an exact recovery command`, async () => {
    const w = world({
      poolSize: 1,
      blocks: { metro: { first: 47800, last: 47801 }, api: { first: 47810, last: 47811 }, web: { first: 47820, last: 47820 } },
    });
    try {
      const { refusal, holderFolder } = await scenarios[code](w);
      assert.equal(refusal.code, code);
      assert.ok(refusal.holders.length > 0);
      for (const h of refusal.holders) {
        for (const field of [h.who, h.folder, h.since]) assert.ok(field.trim().length > 0, JSON.stringify(h));
        assert.ok(refusal.message.includes(`held by ${h.who} in ${h.folder}, since ${h.since}`), refusal.message);
      }
      assert.ok(
        refusal.holders.some(h => h.folder === holderFolder),
        `no holder in ${holderFolder}:\n${refusal.message}`,
      );
      assert.ok(
        refusal.holders.some(h => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(h.since)),
        refusal.message,
      );
      assert.ok(
        refusal.recovery.some(r => RUNNABLE.test(r)),
        `no runnable recovery command:\n${refusal.message}`,
      );
      for (const r of refusal.recovery) assert.ok(refusal.message.includes(r));
    } finally {
      w.close();
    }
  });
}

test('a Refusal cannot be raised without a holder or a recovery command', () => {
  assert.throws(() => new Refusal('pool-busy', 'x', [], ['agentlane status']), /without a holder or a recovery command/);
  assert.throws(
    () => new Refusal('pool-busy', 'x', [{ who: 'a', folder: 'b', since: 'c' }], []),
    /without a holder or a recovery command/,
  );
});

test('touching without a lane says which claim command to run', () => {
  const w = world();
  try {
    const folder = w.folder('none');
    assert.throws(
      () => w.registry().touchOwn(w.procs.owner(), folder, 'look'),
      (error: unknown) => error instanceof NotClaimed && error.recovery.startsWith('node_modules/.bin/agentlane claim'),
    );
  } finally {
    w.close();
  }
});
