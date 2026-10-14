import fs from 'node:fs';
import path from 'node:path';

import { cachedBuild } from '../../src/cache/build.ts';
import { BuildCache } from '../../src/cache/index.ts';
import { systemClock } from '../../src/clock.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import { makeOutput } from './helpers.ts';

const [dir, key, tag, scratch] = process.argv.slice(2);
if (dir === undefined || key === undefined || tag === undefined || scratch === undefined) {
  throw new Error('usage: build-worker <dir> <key> <tag> <scratch>');
}
const builder = identityOf(systemProcesses, process.pid);
if (!builder) throw new Error('ps could not read this process');

async function waitFor(file: string): Promise<void> {
  while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 10));
}

fs.writeFileSync(path.join(scratch, `ready-${tag}`), '');
await waitFor(path.join(scratch, 'go'));
const result = await cachedBuild({
  cache: new BuildCache({ dir, config: { cacheableVariants: ['Debug'] } }),
  variant: 'Debug',
  worktree: `/worktree-${tag}`,
  mode: 'use',
  key: () => Promise.resolve(key),
  install: output => {
    fs.appendFileSync(path.join(scratch, 'installs'), `${tag} ${output}\n`);
    return Promise.resolve();
  },
  build: async () => {
    fs.appendFileSync(path.join(scratch, 'builds'), `${tag}\n`);
    await waitFor(path.join(scratch, 'finish'));
    return makeOutput(path.join(scratch, `out-${tag}`), 'App.app', tag);
  },
  wait: {
    builder,
    processes: systemProcesses,
    clock: systemClock,
    log: line => {
      fs.appendFileSync(path.join(scratch, `log-${tag}`), `${line}\n`);
    },
    pollMs: 20,
  },
});
process.stdout.write(JSON.stringify(result));
