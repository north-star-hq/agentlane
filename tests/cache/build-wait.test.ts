import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { BuildCache, cachedBuild, type CachedBuildResult } from '../../src/cache/index.ts';
import type { Clock } from '../../src/clock.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import { makeOutput, tempDir } from './helpers.ts';

const WORKER = path.join(import.meta.dirname, 'build-worker.ts');
const KEY = 'a'.repeat(64);

function worker(t: TestContext, dir: string, tag: string, scratch: string): Promise<CachedBuildResult> {
  const child = spawn(process.execPath, [WORKER, dir, KEY, tag, scratch], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.on('close', code => {
      if (code === 0) resolve(JSON.parse(stdout) as CachedBuildResult);
      else reject(new Error(`worker ${tag} exited ${String(code)}: ${stderr}`));
    });
  });
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

test('two builders that miss the same key build it once: the second waits for the first and installs its result', async t => {
  const base = tempDir(t);
  const dir = path.join(base, 'cache');
  const scratch = path.join(base, 'scratch');
  fs.mkdirSync(scratch);
  const results = [worker(t, dir, 'a', scratch), worker(t, dir, 'b', scratch)];
  await until(() => ['a', 'b'].every(tag => fs.existsSync(path.join(scratch, `ready-${tag}`))), 'both workers');
  fs.writeFileSync(path.join(scratch, 'go'), '');
  await until(() => read(path.join(scratch, 'builds')) !== '', 'a build to start');
  const builder = read(path.join(scratch, 'builds')).trim();
  const waiter = builder === 'a' ? 'b' : 'a';
  await until(() => read(path.join(scratch, `log-${waiter}`)) !== '', 'the waiting line');
  assert.match(
    read(path.join(scratch, `log-${waiter}`)),
    new RegExp(
      `^waiting for /worktree-${builder}'s build of ${KEY.slice(0, 12)} \\(pid \\d+\\); building here instead after 45m\\n$`,
    ),
  );
  fs.writeFileSync(path.join(scratch, 'finish'), '');
  const [first, second] = await Promise.all(results);
  const byTag = { a: first, b: second };
  assert.equal(read(path.join(scratch, 'builds')), `${builder}\n`, 'only one worker built');
  const built = byTag[builder as 'a' | 'b'];
  const served = byTag[waiter];
  assert.ok(built?.source === 'build' && built.stored, JSON.stringify(built));
  assert.ok(served?.source === 'cache', JSON.stringify(served));
  assert.equal(served.origin.worktree, `/worktree-${builder}`);
  assert.equal(served.waited?.worktree, `/worktree-${builder}`);
  assert.equal(read(path.join(scratch, 'installs')), `${waiter} ${served.output}\n`);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.building')), [], 'the build lock is gone');
});

function fakeClock(): Clock & { slept: number } {
  const clock = {
    at: 0,
    slept: 0,
    now: () => clock.at,
    sleep: (ms: number) => {
      clock.at += ms;
      clock.slept += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

function deadIdentity(): { pid: number; start: string } {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return { pid: Number(child.stdout), start: 'Sun Mar  1 12:00:00 2026' };
}

function lockedRun(base: string, holder: { pid: number; start: string }, timeoutMs: number) {
  const dir = path.join(base, 'cache');
  fs.mkdirSync(path.join(dir, '.building'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.building', KEY), JSON.stringify({ ...holder, worktree: '/worktree-holder' }));
  const lines: string[] = [];
  let builds = 0;
  const clock = fakeClock();
  const me = { pid: 1, start: 'Sun Mar  1 12:00:00 2026' };
  const result = cachedBuild({
    cache: new BuildCache({ dir, config: { cacheableVariants: ['Debug'] } }),
    variant: 'Debug',
    worktree: '/worktree-me',
    mode: 'use',
    key: () => Promise.resolve(KEY),
    install: () => Promise.resolve(),
    build: () => {
      builds += 1;
      return Promise.resolve(makeOutput(path.join(base, 'out'), 'App.app', 'me'));
    },
    wait: { builder: me, processes: systemProcesses, clock, log: line => lines.push(line), timeoutMs, pollMs: 1000 },
  });
  return { result, lines, clock, builds: () => builds };
}

test('a build lock whose holder is gone does not make the next builder wait', async t => {
  const run = lockedRun(tempDir(t), deadIdentity(), 60_000);
  const result = await run.result;
  assert.ok(result.source === 'build' && result.stored, JSON.stringify(result));
  assert.equal(run.builds(), 1);
  assert.deepEqual(run.lines, []);
  assert.equal(run.clock.slept, 0);
});

test('a builder that waits past the timeout for a live holder builds the key itself, and says so', async t => {
  const self = identityOf(systemProcesses, process.pid);
  assert.ok(self);
  const run = lockedRun(tempDir(t), self, 10_000);
  const result = await run.result;
  assert.ok(result.source === 'build', JSON.stringify(result));
  assert.equal(run.builds(), 1);
  assert.equal(run.clock.slept, 10_000);
  assert.deepEqual(run.lines, [
    `waiting for /worktree-holder's build of ${KEY.slice(0, 12)} (pid ${String(process.pid)}); building here instead after 10s`,
    `stopped waiting for /worktree-holder's build of ${KEY.slice(0, 12)} after 10s; building here`,
  ]);
  assert.equal(result.waited?.ms, 10_000);
});
