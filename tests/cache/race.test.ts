import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { BuildCache } from '../../src/cache/index.ts';
import { readOutput, tempDir } from './helpers.ts';

const WORKER = path.join(import.meta.dirname, 'race-worker.ts');
const KEY = 'd'.repeat(64);
const ROUNDS = 12;
const WRITERS = 5;
const READERS = 2;

function worker(role: string, dir: string, tag: string, scratch: string): { ready: string; result: Promise<unknown> } {
  const child = spawn(process.execPath, [WORKER, role, dir, KEY, tag, scratch], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const result = new Promise((resolve, reject) => {
    child.on('close', code => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`${role} ${tag} exited ${String(code)}: ${stderr}`));
    });
  });
  return { ready: path.join(scratch, `ready-${tag}`), result };
}

async function allExist(files: string[]): Promise<void> {
  while (!files.every(file => fs.existsSync(file))) await new Promise(resolve => setImmediate(resolve));
}

async function round(base: string, n: number, writerRole: 'store' | 'replace', seeded: boolean) {
  const dir = path.join(base, `cache-${String(n)}`);
  const scratch = path.join(base, `scratch-${String(n)}`);
  fs.mkdirSync(scratch, { recursive: true });
  const cache = new BuildCache({ dir, config: { cacheableVariants: ['Debug'] } });
  if (seeded) {
    const seed = path.join(scratch, 'seed', 'App.app');
    fs.mkdirSync(seed, { recursive: true });
    for (let i = 0; i <= 40; i += 1) fs.writeFileSync(path.join(seed, `f${String(i)}`), 'seed\n');
    await cache.store({ key: KEY, variant: 'Debug', output: seed, worktree: '/seed', replace: false });
  }
  const writers = Array.from({ length: WRITERS }, (_, i) => worker(writerRole, dir, `w${String(i)}`, scratch));
  const readers = Array.from({ length: READERS }, (_, i) => worker('read', dir, `r${String(i)}`, scratch));
  await allExist([...writers, ...readers].map(w => w.ready));
  fs.writeFileSync(path.join(scratch, 'go'), '');
  const stores = (await Promise.all(writers.map(w => w.result))) as { stored: boolean }[];
  fs.writeFileSync(path.join(scratch, 'done'), '');
  const reads = (await Promise.all(readers.map(r => r.result))) as { hits: number; problems: string[] }[];
  return { cache, dir, stores, reads };
}

test('concurrent stores under one key leave exactly one complete entry, and readers never see a partial one', async t => {
  const base = tempDir(t);
  for (let n = 0; n < ROUNDS; n += 1) {
    const replace = n % 2 === 1;
    const { cache, dir, stores, reads } = await round(base, n, replace ? 'replace' : 'store', replace);
    for (const read of reads) assert.deepEqual(read.problems, [], `round ${String(n)}`);
    const entries = await cache.list();
    assert.equal(entries.length, 1, `round ${String(n)}: one entry`);
    const { files, tags } = readOutput(entries[0]?.output ?? '');
    assert.equal(files, 41, `round ${String(n)}: the entry is complete`);
    assert.equal(tags.size, 1, `round ${String(n)}: the entry comes from one writer`);
    if (replace) {
      assert.equal(stores.filter(s => s.stored).length, WRITERS, `round ${String(n)}: every replace publishes`);
      assert.notEqual(entries[0]?.origin.worktree, '/seed');
    } else {
      assert.equal(stores.filter(s => s.stored).length, 1, `round ${String(n)}: exactly one store wins`);
      assert.equal(fs.readdirSync(path.join(dir, '.objects')).length, 1, `round ${String(n)}: losers leave no object`);
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, '.staging')), [], `round ${String(n)}: no staging left`);
  }
});
