import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import { liveHolder, tryLock, unlock } from '../driver/lock.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { formatAge } from '../registry/format.ts';
import type { BuildCache, CacheEntry, EntryOrigin, PruneResult } from './store.ts';

export type CacheMode = 'use' | 'no-cache' | 'refresh';

export type BuildReason = 'not-cacheable' | 'no-cache' | 'refresh' | 'miss' | 'install-failed' | 'no-key';

export interface CachedBuildOptions {
  cache: BuildCache;
  variant: string;
  worktree: string;
  mode: CacheMode;
  key: () => Promise<string>;
  install: (output: string) => Promise<void>;
  build: () => Promise<string>;
  /** Lets a miss wait for another process already building the same key, instead of building it twice. */
  wait?: BuildWait;
}

export interface BuildWait {
  /** The process running this build, recorded in the key's build lock. */
  builder: ProcessIdentity;
  processes: ProcessTable;
  clock: Clock;
  log: (line: string) => void;
  timeoutMs?: number;
  pollMs?: number;
}

export const BUILD_WAIT_TIMEOUT_MS = 45 * 60_000;
const BUILD_WAIT_POLL_MS = 2000;

export interface WaitedFor {
  worktree: string;
  pid: number | null;
  ms: number;
}

export interface CacheServed {
  source: 'cache';
  key: string;
  output: string;
  origin: EntryOrigin;
  waited?: WaitedFor;
}

export interface Built {
  source: 'build';
  reason: BuildReason;
  key?: string;
  storedKey?: string;
  stored: boolean;
  problems: string[];
  pruned?: PruneResult;
  waited?: WaitedFor;
}

export type CachedBuildResult = CacheServed | Built;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LockRecord extends ProcessIdentity {
  worktree: string;
}

function lockWorktree(file: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockRecord>;
    return typeof parsed.worktree === 'string' ? parsed.worktree : 'another worktree';
  } catch {
    return 'another worktree';
  }
}

type BuildTurn =
  { kind: 'build'; lock: string | undefined; waited?: WaitedFor } | { kind: 'served'; entry: CacheEntry; waited?: WaitedFor };

/**
 * Takes the key's build lock, or, while a live process holds it, waits for that build to land in the cache. A holder
 * proven gone (its pid exited or now has another start time) loses the lock; after the timeout this process builds
 * without it.
 */
async function takeTurn(options: CachedBuildOptions, wait: BuildWait, key: string): Promise<BuildTurn> {
  const { cache, variant } = options;
  const file = path.join(cache.dir, '.building', key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record: LockRecord = { ...wait.builder, worktree: options.worktree };
  const started = wait.clock.now();
  const timeoutMs = wait.timeoutMs ?? BUILD_WAIT_TIMEOUT_MS;
  let waited: WaitedFor | undefined;
  for (;;) {
    const attempt = tryLock(file, record, wait.processes);
    const found = await cache.lookup(key, variant);
    const sofar = waited ? { ...waited, ms: wait.clock.now() - started } : undefined;
    if (found.hit) {
      if (attempt.acquired) unlock(file, wait.builder);
      return { kind: 'served', entry: found.entry, ...(sofar ? { waited: sofar } : {}) };
    }
    if (attempt.acquired) return { kind: 'build', lock: file, ...(sofar ? { waited: sofar } : {}) };
    const holder = attempt.holder ?? liveHolder(file, wait.processes);
    if (!waited) {
      waited = { worktree: lockWorktree(file), pid: holder?.pid ?? null, ms: 0 };
      const by = waited.pid === null ? '' : ` (pid ${String(waited.pid)})`;
      wait.log(
        `waiting for ${waited.worktree}'s build of ${key.slice(0, 12)}${by}; building here instead after ${formatAge(timeoutMs)}`,
      );
    }
    if (wait.clock.now() - started >= timeoutMs) {
      wait.log(
        `stopped waiting for ${waited.worktree}'s build of ${key.slice(0, 12)} after ${formatAge(wait.clock.now() - started)}; building here`,
      );
      return { kind: 'build', lock: undefined, waited: { ...waited, ms: wait.clock.now() - started } };
    }
    await wait.clock.sleep(wait.pollMs ?? BUILD_WAIT_POLL_MS);
  }
}

export async function cachedBuild(options: CachedBuildOptions): Promise<CachedBuildResult> {
  const { cache, variant } = options;
  if (!cache.isCacheable(variant) || options.mode === 'no-cache') {
    await options.build();
    return { source: 'build', reason: cache.isCacheable(variant) ? 'no-cache' : 'not-cacheable', stored: false, problems: [] };
  }

  const problems: string[] = [];
  let key: string;
  try {
    key = await options.key();
  } catch (error) {
    await options.build();
    return { source: 'build', reason: 'no-key', stored: false, problems: [message(error)] };
  }

  let reason: BuildReason = 'refresh';
  let replace = true;
  let lock: string | undefined;
  let waited: WaitedFor | undefined;
  const serve = async (entry: CacheEntry, waitedFor?: WaitedFor): Promise<CacheServed | undefined> => {
    try {
      await options.install(entry.output);
      return { source: 'cache', key, output: entry.output, origin: entry.origin, ...(waitedFor ? { waited: waitedFor } : {}) };
    } catch (error) {
      problems.push(`installing the cached build failed: ${message(error)}`);
      reason = 'install-failed';
      return undefined;
    }
  };
  if (options.mode === 'use') {
    const found = await cache.lookup(key, variant);
    if (found.hit) {
      const served = await serve(found.entry);
      if (served) return served;
    } else {
      reason = 'miss';
      replace = found.reason === 'broken';
      if (options.wait) {
        const turn = await takeTurn(options, options.wait, key);
        if (turn.kind === 'served') {
          const served = await serve(turn.entry, turn.waited);
          if (served) return served;
        } else {
          lock = turn.lock;
          waited = turn.waited;
        }
      }
    }
  }

  try {
    return await buildAndStore(options, { reason, key, replace, problems, ...(waited ? { waited } : {}) });
  } finally {
    if (lock !== undefined && options.wait) unlock(lock, options.wait.builder);
  }
}

async function buildAndStore(
  options: CachedBuildOptions,
  run: { reason: BuildReason; key: string; replace: boolean; problems: string[]; waited?: WaitedFor },
): Promise<Built> {
  const { cache, variant } = options;
  const { problems } = run;
  const output = await options.build();
  const result: Built = {
    source: 'build',
    reason: run.reason,
    key: run.key,
    stored: false,
    problems,
    ...(run.waited ? { waited: run.waited } : {}),
  };
  let storedKey: string;
  try {
    storedKey = await options.key();
  } catch (error) {
    problems.push(`the key could not be recomputed after the build, so nothing was stored: ${message(error)}`);
    return result;
  }
  try {
    const stored = await cache.store({ key: storedKey, variant, output, worktree: options.worktree, replace: run.replace });
    result.stored = stored.stored;
    result.storedKey = storedKey;
  } catch (error) {
    problems.push(`storing the build failed: ${message(error)}`);
    return result;
  }
  try {
    result.pruned = await cache.prune();
  } catch (error) {
    problems.push(`pruning the cache failed: ${message(error)}`);
  }
  return result;
}
