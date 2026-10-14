import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { BuildCache, cachedBuild, type CacheMode, type CachedBuildOptions } from '../../src/cache/index.ts';
import { CLOCK, makeOutput, readOutput, tempDir } from './helpers.ts';

const KEY = 'e'.repeat(64);
const MOVED = 'f'.repeat(64);

interface Fake {
  cache: BuildCache;
  dir: string;
  builds: number;
  installs: string[];
  failInstall: boolean;
  keys: (string | Error)[];
  run: (mode: CacheMode, variant?: string, worktree?: string) => ReturnType<typeof cachedBuild>;
}

function fake(t: TestContext): Fake {
  const base = tempDir(t);
  const dir = path.join(base, 'cache');
  const state: Fake = {
    cache: new BuildCache({ dir, config: { cacheableVariants: ['Debug'] }, now: () => CLOCK }),
    dir,
    builds: 0,
    installs: [],
    failInstall: false,
    keys: [],
    run: (mode, variant = 'Debug', worktree = '/repo/a') => {
      const options: CachedBuildOptions = {
        cache: state.cache,
        variant,
        worktree,
        mode,
        key: () => {
          const next = state.keys.length > 1 ? state.keys.shift() : state.keys[0];
          return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? KEY);
        },
        install: output => {
          state.installs.push(output);
          return state.failInstall ? Promise.reject(new Error('simctl install failed')) : Promise.resolve();
        },
        build: () => {
          state.builds += 1;
          return Promise.resolve(
            makeOutput(path.join(base, `build-${String(state.builds)}`), 'App.app', `build-${String(state.builds)}`),
          );
        },
      };
      return cachedBuild(options);
    },
  };
  return state;
}

test('a miss builds and stores; the next run installs from the cache without building', async t => {
  const f = fake(t);
  const first = await f.run('use');
  assert.ok(first.source === 'build');
  assert.equal(first.reason, 'miss');
  assert.equal(first.stored, true);
  assert.equal(f.builds, 1);

  const second = await f.run('use', 'Debug', '/repo/b');
  assert.ok(second.source === 'cache');
  assert.equal(f.builds, 1);
  assert.deepEqual(f.installs, [second.output]);
  assert.deepEqual(second.origin, { worktree: '/repo/a', storedAt: CLOCK });
  assert.deepEqual([...readOutput(second.output).tags], ['build-1\n']);
});

test('--no-cache builds without reading or touching the stored entry', async t => {
  const f = fake(t);
  await f.run('use');
  const result = await f.run('no-cache', 'Debug', '/repo/b');
  assert.deepEqual(result, { source: 'build', reason: 'no-cache', stored: false, problems: [] });
  assert.equal(f.builds, 2);
  assert.equal(f.installs.length, 0);
  const [entry] = await f.cache.list();
  assert.equal(entry?.origin.worktree, '/repo/a');
  assert.deepEqual([...readOutput(entry.output).tags], ['build-1\n']);
});

test('--refresh-cache builds and overwrites the entry under the same key', async t => {
  const f = fake(t);
  await f.run('use');
  const result = await f.run('refresh', 'Debug', '/repo/b');
  assert.equal(result.source === 'build' && result.reason, 'refresh');
  assert.equal(result.source === 'build' && result.storedKey, KEY);
  assert.equal(f.installs.length, 0);
  const entries = await f.cache.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.origin.worktree, '/repo/b');
  assert.deepEqual([...readOutput(entries[0].output).tags], ['build-2\n']);
});

test('a cached build that fails to install is rebuilt and replaced', async t => {
  const f = fake(t);
  await f.run('use');
  f.failInstall = true;
  const result = await f.run('use', 'Debug', '/repo/b');
  assert.ok(result.source === 'build');
  assert.equal(result.reason, 'install-failed');
  assert.equal(result.stored, true);
  assert.match(result.problems[0] ?? '', /simctl install failed/);
  assert.equal((await f.cache.list())[0]?.origin.worktree, '/repo/b');
});

test('a variant that is not cacheable always builds and leaves the cache untouched', async t => {
  const f = fake(t);
  for (const mode of ['use', 'refresh', 'use'] as const) {
    assert.deepEqual(await f.run(mode, 'Release'), { source: 'build', reason: 'not-cacheable', stored: false, problems: [] });
  }
  assert.equal(f.builds, 3);
  assert.equal(f.installs.length, 0);
  assert.equal(fs.existsSync(f.dir), false);
});

test('a key that cannot be computed builds without the cache', async t => {
  const f = fake(t);
  f.keys = [new Error('the command input failed')];
  const result = await f.run('use');
  assert.deepEqual(result, { source: 'build', reason: 'no-key', stored: false, problems: ['the command input failed'] });
  assert.equal(fs.existsSync(f.dir), false);
});

test('when the build moves the key, the entry is stored under the key of what was built', async t => {
  const f = fake(t);
  f.keys = [KEY, MOVED];
  const result = await f.run('use');
  assert.ok(result.source === 'build');
  assert.equal(result.key, KEY);
  assert.equal(result.storedKey, MOVED);
  assert.deepEqual(
    (await f.cache.list()).map(e => e.key),
    [MOVED],
  );
});

test('a broken entry under the key is replaced by the build', async t => {
  const f = fake(t);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.symlinkSync(path.join('.objects', 'gone'), path.join(f.dir, KEY));
  const result = await f.run('use');
  assert.ok(result.source === 'build');
  assert.equal(result.stored, true);
  assert.equal((await f.cache.lookup(KEY, 'Debug')).hit, true);
});
