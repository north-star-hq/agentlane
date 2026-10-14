import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { BuildCache, CacheEvictError, type BuildCacheConfig } from '../../src/cache/index.ts';
import { CLOCK, makeOutput, readOutput, snapshot, tempDir, writeFiles } from './helpers.ts';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Setup {
  dir: string;
  outputs: string;
  clock: { now: Date };
  cache: (config?: Partial<BuildCacheConfig>) => BuildCache;
}

function setup(t: TestContext): Setup {
  const base = tempDir(t);
  const dir = path.join(base, 'git', 'agentlane', 'build-cache');
  const outputs = path.join(base, 'outputs');
  const clock = { now: CLOCK };
  return {
    dir,
    outputs,
    clock,
    cache: config => new BuildCache({ dir, config: { cacheableVariants: ['Debug'], ...config }, now: () => clock.now }),
  };
}

function entryDir(s: Setup, key: string): string {
  return fs.realpathSync(path.join(s.dir, key));
}

function age(s: Setup, key: string, ms: number): void {
  const when = new Date(CLOCK.getTime() - ms);
  fs.utimesSync(entryDir(s, key), when, when);
}

test('a hit serves the stored output and names the worktree and time that produced it', async t => {
  const s = setup(t);
  const cache = s.cache();
  const output = makeOutput(s.outputs, 'Shop.app', 'build-1');
  const stored = await cache.store({ key: KEY_A, variant: 'Debug', output, worktree: '/repo/worktree-a', replace: false });
  assert.equal(stored.stored, true);

  s.clock.now = new Date(CLOCK.getTime() + HOUR);
  const found = await cache.lookup(KEY_A, 'Debug');
  assert.ok(found.hit);
  assert.equal(found.entry.origin.worktree, '/repo/worktree-a');
  assert.equal(found.entry.origin.storedAt.toISOString(), CLOCK.toISOString());
  assert.equal(found.entry.lastUsed.toISOString(), s.clock.now.toISOString());
  assert.equal(path.basename(found.entry.output), 'Shop.app');
  assert.deepEqual(readOutput(found.entry.output), readOutput(output));

  const [listed] = await cache.list();
  assert.equal(listed?.key, KEY_A);
  assert.equal(listed.lastUsed.toISOString(), s.clock.now.toISOString());
});

test('a single-file output is stored and served too', async t => {
  const s = setup(t);
  const cache = s.cache();
  writeFiles(s.outputs, { 'app-debug.apk': 'apk bytes' });
  await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: path.join(s.outputs, 'app-debug.apk'),
    worktree: '/w',
    replace: false,
  });
  const found = await cache.lookup(KEY_A, 'Debug');
  assert.ok(found.hit);
  assert.equal(fs.readFileSync(found.entry.output, 'utf8'), 'apk bytes');
});

test('a store under an existing key keeps the entry unless it replaces it', async t => {
  const s = setup(t);
  const cache = s.cache();
  await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'one/App.app', 'one'),
    worktree: '/w1',
    replace: false,
  });
  const second = await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'two/App.app', 'two'),
    worktree: '/w2',
    replace: false,
  });
  assert.deepEqual(second, { stored: false, reason: 'exists' });
  let found = await cache.lookup(KEY_A, 'Debug');
  assert.ok(found.hit);
  assert.equal(found.entry.origin.worktree, '/w1');
  const oldOutput = found.entry.output;

  const third = await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'three/App.app', 'three'),
    worktree: '/w3',
    replace: true,
  });
  assert.equal(third.stored, true);
  found = await cache.lookup(KEY_A, 'Debug');
  assert.ok(found.hit);
  assert.equal(found.entry.origin.worktree, '/w3');
  assert.deepEqual([...readOutput(found.entry.output).tags], ['three\n']);
  assert.deepEqual([...readOutput(oldOutput).tags], ['one\n'], 'a reader of the replaced entry keeps its files');
  assert.equal((await cache.list()).length, 1);
});

test('a variant that is not cacheable is never stored or served', async t => {
  const s = setup(t);
  const cache = s.cache({ cacheableVariants: ['Debug'] });
  const output = makeOutput(s.outputs, 'App.app', 'release');
  assert.deepEqual(await cache.store({ key: KEY_A, variant: 'Release', output, worktree: '/w', replace: false }), {
    stored: false,
    reason: 'not-cacheable',
  });
  assert.deepEqual(await cache.store({ key: KEY_A, variant: 'Release', output, worktree: '/w', replace: true }), {
    stored: false,
    reason: 'not-cacheable',
  });
  assert.equal(fs.existsSync(s.dir), false);

  await s
    .cache({ cacheableVariants: ['Release'] })
    .store({ key: KEY_B, variant: 'Release', output, worktree: '/w', replace: false });
  assert.deepEqual(await cache.lookup(KEY_B, 'Release'), { hit: false, reason: 'not-cacheable' });
});

test('evict refuses anything but a listed hex key or all, before touching anything', async t => {
  const s = setup(t);
  const cache = s.cache();
  await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'App.app', 'a'),
    worktree: '/w',
    replace: false,
  });
  const parent = path.dirname(path.dirname(s.dir));
  writeFiles(parent, { HEAD: 'ref: refs/heads/main\n' });
  const before = snapshot(parent);
  const refused = [
    '.',
    '..',
    '',
    '/',
    s.dir,
    path.join(s.dir, KEY_A),
    '../..',
    `${KEY_A}/..`,
    'a'.repeat(12),
    'A'.repeat(64),
    'g'.repeat(64),
    'ALL',
    '*',
  ];
  for (const target of refused) {
    await assert.rejects(cache.evict(target), CacheEvictError, `evict(${JSON.stringify(target)}) should be refused`);
  }
  await assert.rejects(cache.evict(KEY_B), CacheEvictError, 'a well-formed key with no entry is refused');
  assert.deepEqual(snapshot(parent), before);
});

test('evict of a key removes exactly that entry', async t => {
  const s = setup(t);
  const cache = s.cache();
  await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'a/App.app', 'a'),
    worktree: '/w',
    replace: false,
  });
  await cache.store({
    key: KEY_B,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'b/App.app', 'b'),
    worktree: '/w',
    replace: false,
  });
  const objectA = entryDir(s, KEY_A);
  const objectB = entryDir(s, KEY_B);
  const keptB = snapshot(objectB);

  assert.deepEqual(await cache.evict(KEY_A), [KEY_A]);
  assert.equal(fs.existsSync(objectA), false);
  assert.equal(fs.existsSync(path.join(s.dir, KEY_A)), false);
  assert.deepEqual(
    (await cache.list()).map(e => e.key),
    [KEY_B],
  );
  assert.deepEqual(snapshot(objectB), keptB);
});

test('evict all empties the cache directory and nothing outside it', async t => {
  const s = setup(t);
  const cache = s.cache();
  await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'a/App.app', 'a'),
    worktree: '/w',
    replace: false,
  });
  await cache.store({
    key: KEY_B,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'b/App.app', 'b'),
    worktree: '/w',
    replace: false,
  });
  const parent = path.dirname(path.dirname(s.dir));
  writeFiles(parent, { HEAD: 'ref: refs/heads/main\n', 'agentlane/lanes/one.json': '{}' });
  const cacheRel = path.relative(parent, s.dir);
  const outsideCache = () => snapshot(parent).filter(line => !line.startsWith(cacheRel));
  const before = outsideCache();

  assert.deepEqual((await cache.evict('all')).sort(), [KEY_A, KEY_B]);
  assert.deepEqual(fs.readdirSync(s.dir), []);
  assert.deepEqual(outsideCache(), before);
  assert.deepEqual(await cache.evict('all'), []);
});

test('prune removes entries unused for longer than the limit and keeps the rest', async t => {
  const s = setup(t);
  const cache = s.cache({ maxAgeDays: 7, maxEntries: 10 });
  for (const [key, tag] of [
    [KEY_A, 'a'],
    [KEY_B, 'b'],
    [KEY_C, 'c'],
  ] as const) {
    await cache.store({
      key,
      variant: 'Debug',
      output: makeOutput(s.outputs, `${tag}/App.app`, tag),
      worktree: '/w',
      replace: false,
    });
  }
  const oldObject = entryDir(s, KEY_A);
  age(s, KEY_A, 8 * DAY);
  age(s, KEY_B, 6 * DAY);
  age(s, KEY_C, HOUR);

  const result = await cache.prune();
  assert.deepEqual(result.removed, [KEY_A]);
  assert.equal(result.objectsRemoved, 1, 'an unreferenced object past the grace period goes with its entry');
  assert.equal(fs.existsSync(oldObject), false);
  assert.deepEqual((await cache.list()).map(e => e.key).sort(), [KEY_B, KEY_C]);
});

test('prune keeps only the most recently used entries, and a recently used object outlives its entry for the grace period', async t => {
  const s = setup(t);
  const cache = s.cache({ maxAgeDays: 30, maxEntries: 2 });
  for (const [key, tag] of [
    [KEY_A, 'a'],
    [KEY_B, 'b'],
    [KEY_C, 'c'],
  ] as const) {
    await cache.store({
      key,
      variant: 'Debug',
      output: makeOutput(s.outputs, `${tag}/App.app`, tag),
      worktree: '/w',
      replace: false,
    });
  }
  age(s, KEY_A, 30 * 60 * 1000);
  age(s, KEY_B, 20 * 60 * 1000);
  age(s, KEY_C, 10 * 60 * 1000);
  const objectA = entryDir(s, KEY_A);

  assert.deepEqual((await cache.prune()).removed, [KEY_A]);
  assert.deepEqual(
    (await cache.list()).map(e => e.key),
    [KEY_C, KEY_B],
  );
  assert.equal(fs.existsSync(objectA), true, 'a reader that looked up the entry half an hour ago can still read it');

  s.clock.now = new Date(CLOCK.getTime() + 2 * HOUR);
  fs.utimesSync(entryDir(s, KEY_B), s.clock.now, s.clock.now);
  fs.utimesSync(entryDir(s, KEY_C), s.clock.now, s.clock.now);
  assert.equal((await cache.prune()).objectsRemoved, 1);
  assert.equal(fs.existsSync(objectA), false);
});

test('prune clears staging left by a crashed store once it is a day old, and broken links', async t => {
  const s = setup(t);
  const cache = s.cache();
  await cache.store({
    key: KEY_A,
    variant: 'Debug',
    output: makeOutput(s.outputs, 'App.app', 'a'),
    worktree: '/w',
    replace: false,
  });
  writeFiles(s.dir, { '.staging/old/out/App.app/Info.plist': 'x', '.staging/fresh/out/App.app/Info.plist': 'x' });
  const old = new Date(CLOCK.getTime() - 2 * DAY);
  fs.utimesSync(path.join(s.dir, '.staging/old'), old, old);
  fs.utimesSync(path.join(s.dir, '.staging/fresh'), CLOCK, CLOCK);
  fs.symlinkSync(path.join('.objects', 'missing'), path.join(s.dir, KEY_B));

  const result = await cache.prune();
  assert.deepEqual(result.removed, [KEY_B]);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, '.staging')), ['fresh']);
  assert.deepEqual(
    (await cache.list()).map(e => e.key),
    [KEY_A],
  );
});

test('an output given through a symlink stores the files it points at', async t => {
  const s = setup(t);
  const cache = s.cache();
  const real = makeOutput(s.outputs, 'Products/Shop.app', 'real');
  fs.symlinkSync(real, path.join(s.outputs, 'latest.app'));
  await cache.store({ key: KEY_A, variant: 'Debug', output: path.join(s.outputs, 'latest.app'), worktree: '/w', replace: false });
  fs.rmSync(path.join(s.outputs, 'Products'), { recursive: true });
  const found = await cache.lookup(KEY_A, 'Debug');
  assert.ok(found.hit);
  assert.equal(path.basename(found.entry.output), 'Shop.app');
  assert.deepEqual([...readOutput(found.entry.output).tags], ['real\n']);
});
