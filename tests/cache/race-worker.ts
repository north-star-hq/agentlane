import fs from 'node:fs';
import path from 'node:path';

import { BuildCache } from '../../src/cache/index.ts';
import { makeOutput, readOutput } from './helpers.ts';

const [role, dir, key, tag, scratch] = process.argv.slice(2);
if (role === undefined || dir === undefined || key === undefined || tag === undefined || scratch === undefined) {
  throw new Error('usage: race-worker <store|replace|read> <dir> <key> <tag> <scratch>');
}
const FILES = 40;
const cache = new BuildCache({ dir, config: { cacheableVariants: ['Debug'] } });
const go = path.join(scratch, 'go');
const done = path.join(scratch, 'done');

async function waitFor(file: string): Promise<void> {
  while (!fs.existsSync(file)) await new Promise(resolve => setImmediate(resolve));
}

if (role === 'read') {
  fs.writeFileSync(path.join(scratch, `ready-${tag}`), '');
  await waitFor(go);
  let hits = 0;
  const problems: string[] = [];
  while (!fs.existsSync(done) || hits === 0) {
    const found = await cache.lookup(key, 'Debug');
    if (!found.hit) {
      if (fs.existsSync(done)) problems.push('no entry after every store finished');
      if (problems.length > 0) break;
      continue;
    }
    hits += 1;
    const { tags, files } = readOutput(found.entry.output);
    if (files !== FILES + 1 || tags.size !== 1)
      problems.push(`partial entry: ${String(files)} files, tags ${[...tags].join(',')}`);
    if (problems.length > 0) break;
  }
  process.stdout.write(JSON.stringify({ hits, problems }));
} else {
  const output = makeOutput(path.join(scratch, `out-${tag}`), 'App.app', tag, FILES);
  fs.writeFileSync(path.join(scratch, `ready-${tag}`), '');
  await waitFor(go);
  const result = await cache.store({ key, variant: 'Debug', output, worktree: `/worktree-${tag}`, replace: role === 'replace' });
  process.stdout.write(JSON.stringify({ stored: result.stored }));
}
