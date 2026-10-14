import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_ENTRIES, type BuildCacheConfig } from './config.ts';

const execFileAsync = promisify(execFile);

export const CACHE_DIR_PARTS = ['agentlane', 'build-cache'] as const;

const OBJECTS = '.objects';
const STAGING = '.staging';
const META = 'meta.json';
const OUT = 'out';
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const UNREFERENCED_GRACE_MS = 60 * 60 * 1000;
export const STAGING_GRACE_MS = DAY_MS;

export function isCacheKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export async function cacheDirFor(worktree: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.join(stdout.trim(), ...CACHE_DIR_PARTS);
}

export interface EntryOrigin {
  worktree: string;
  storedAt: Date;
}

export interface CacheEntry {
  key: string;
  variant: string;
  output: string;
  origin: EntryOrigin;
  lastUsed: Date;
}

export type LookupResult = { hit: true; entry: CacheEntry } | { hit: false; reason: 'not-cacheable' | 'absent' | 'broken' };

export type StoreResult = { stored: true; entry: CacheEntry } | { stored: false; reason: 'not-cacheable' | 'exists' };

export interface StoreRequest {
  key: string;
  variant: string;
  output: string;
  worktree: string;
  replace: boolean;
}

export interface PruneResult {
  removed: string[];
  objectsRemoved: number;
}

export class CacheEvictError extends Error {
  override name = 'CacheEvictError';
}

interface EntryMeta {
  schema: 1;
  key: string;
  variant: string;
  worktree: string;
  storedAt: string;
  output: string;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
}

function objectIdOf(entry: CacheEntry): string {
  return path.basename(path.dirname(path.dirname(entry.output)));
}

function parseMeta(text: string): EntryMeta | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const meta = value as Partial<EntryMeta>;
  const fields = [meta.key, meta.variant, meta.worktree, meta.storedAt, meta.output];
  if (meta.schema !== 1 || !fields.every(f => typeof f === 'string')) return undefined;
  return meta as EntryMeta;
}

export interface BuildCacheOptions {
  dir: string;
  config: Pick<BuildCacheConfig, 'cacheableVariants' | 'maxAgeDays' | 'maxEntries'>;
  now?: () => Date;
}

export class BuildCache {
  readonly dir: string;
  readonly cacheableVariants: readonly string[];
  readonly maxAgeMs: number;
  readonly maxEntries: number;
  readonly #now: () => Date;

  constructor(options: BuildCacheOptions) {
    this.dir = options.dir;
    this.cacheableVariants = [...options.config.cacheableVariants];
    this.maxAgeMs = (options.config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * DAY_MS;
    this.maxEntries = options.config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? (() => new Date());
  }

  isCacheable(variant: string): boolean {
    return this.cacheableVariants.includes(variant);
  }

  async lookup(key: string, variant: string): Promise<LookupResult> {
    if (!this.isCacheable(variant)) return { hit: false, reason: 'not-cacheable' };
    if (!isCacheKey(key)) return { hit: false, reason: 'absent' };
    const objectDir = await this.#objectOf(key);
    if (objectDir === undefined) return { hit: false, reason: 'absent' };
    const entry = await this.#readEntry(key, objectDir);
    if (entry?.variant !== variant) return { hit: false, reason: 'broken' };
    const now = this.#now();
    await fs.utimes(objectDir, now, now).catch(() => undefined);
    return { hit: true, entry: { ...entry, lastUsed: now } };
  }

  async store(request: StoreRequest): Promise<StoreResult> {
    if (!isCacheKey(request.key)) throw new Error(`'${request.key}' is not a cache key`);
    if (!this.isCacheable(request.variant)) return { stored: false, reason: 'not-cacheable' };
    const link = path.join(this.dir, request.key);
    if (!request.replace && (await this.#objectOf(request.key)) !== undefined) return { stored: false, reason: 'exists' };

    const id = newId();
    const staging = path.join(this.dir, STAGING, id);
    const objectDir = path.join(this.dir, OBJECTS, id);
    const source = await fs.realpath(request.output);
    const name = path.basename(source);
    const storedAt = this.#now();
    await fs.mkdir(path.join(staging, OUT), { recursive: true });
    await fs.mkdir(path.join(this.dir, OBJECTS), { recursive: true });
    try {
      await fs.cp(source, path.join(staging, OUT, name), {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      const meta: EntryMeta = {
        schema: 1,
        key: request.key,
        variant: request.variant,
        worktree: request.worktree,
        storedAt: storedAt.toISOString(),
        output: name,
      };
      await fs.writeFile(path.join(staging, META), `${JSON.stringify(meta, null, 2)}\n`);
      await fs.rename(staging, objectDir);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    await fs.utimes(objectDir, storedAt, storedAt);

    const target = path.join(OBJECTS, id);
    try {
      if (request.replace) {
        const tmpLink = path.join(this.dir, STAGING, `link-${id}`);
        await fs.symlink(target, tmpLink);
        await fs.rename(tmpLink, link);
      } else {
        await fs.symlink(target, link);
      }
    } catch (error) {
      await fs.rm(objectDir, { recursive: true, force: true });
      if (!request.replace && (error as NodeJS.ErrnoException).code === 'EEXIST') return { stored: false, reason: 'exists' };
      throw error;
    }
    return {
      stored: true,
      entry: {
        key: request.key,
        variant: request.variant,
        output: path.join(objectDir, OUT, name),
        origin: { worktree: request.worktree, storedAt },
        lastUsed: storedAt,
      },
    };
  }

  async list(): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];
    for (const key of await this.#keys()) {
      const objectDir = await this.#objectOf(key);
      if (objectDir === undefined) continue;
      const entry = await this.#readEntry(key, objectDir);
      if (entry !== undefined) entries.push(entry);
    }
    return entries.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
  }

  async prune(): Promise<PruneResult> {
    const now = this.#now().getTime();
    const removed: string[] = [];
    const live = new Set<string>();
    const entries = await this.list();
    for (const [index, entry] of entries.entries()) {
      if (index >= this.maxEntries || now - entry.lastUsed.getTime() > this.maxAgeMs) {
        await fs.rm(path.join(this.dir, entry.key), { force: true });
        removed.push(entry.key);
      } else {
        live.add(objectIdOf(entry));
      }
    }
    const seen = new Set(entries.map(entry => entry.key));
    for (const key of await this.#keys()) {
      if (seen.has(key)) continue;
      const objectDir = await this.#objectOf(key);
      const entry = objectDir === undefined ? undefined : await this.#readEntry(key, objectDir);
      if (entry !== undefined) {
        live.add(objectIdOf(entry));
        continue;
      }
      const stat = await fs.lstat(path.join(this.dir, key)).catch(() => undefined);
      if (stat?.isSymbolicLink()) {
        await fs.rm(path.join(this.dir, key), { force: true });
        removed.push(key);
      }
    }
    const objectsRemoved = await this.#sweep(OBJECTS, UNREFERENCED_GRACE_MS, now, live);
    await this.#sweep(STAGING, STAGING_GRACE_MS, now, new Set());
    return { removed, objectsRemoved };
  }

  async evict(target: string): Promise<string[]> {
    if (target === 'all') return this.#evictAll();
    if (!isCacheKey(target)) {
      throw new CacheEvictError(`'${target}' is not a cache key: pass a key exactly as the cache lists it, or 'all'`);
    }
    const link = path.join(this.dir, target);
    const stat = await fs.lstat(link).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!stat?.isSymbolicLink()) throw new CacheEvictError(`there is no cache entry ${target} in ${this.dir}`);
    const objectDir = await this.#objectOf(target);
    await fs.rm(link, { force: true });
    if (objectDir !== undefined) await fs.rm(objectDir, { recursive: true, force: true });
    return [target];
  }

  async #evictAll(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    for (const name of names) await fs.rm(path.join(this.dir, name), { recursive: true, force: true });
    return names.filter(isCacheKey);
  }

  async #keys(): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir)).filter(isCacheKey);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async #objectOf(key: string): Promise<string | undefined> {
    let target: string;
    try {
      target = await fs.readlink(path.join(this.dir, key));
    } catch {
      return undefined;
    }
    const objects = path.join(this.dir, OBJECTS);
    const objectDir = path.resolve(this.dir, target);
    if (path.dirname(objectDir) !== objects) return undefined;
    return objectDir;
  }

  async #readEntry(key: string, objectDir: string): Promise<CacheEntry | undefined> {
    let meta: EntryMeta | undefined;
    let lastUsed: Date;
    try {
      meta = parseMeta(await fs.readFile(path.join(objectDir, META), 'utf8'));
      lastUsed = (await fs.stat(objectDir)).mtime;
    } catch {
      return undefined;
    }
    if (meta?.key !== key) return undefined;
    const output = path.join(objectDir, OUT, meta.output);
    if (
      !(await fs.lstat(output).then(
        () => true,
        () => false,
      ))
    )
      return undefined;
    return {
      key,
      variant: meta.variant,
      output,
      origin: { worktree: meta.worktree, storedAt: new Date(meta.storedAt) },
      lastUsed,
    };
  }

  async #sweep(sub: string, graceMs: number, now: number, keep: Set<string>): Promise<number> {
    const dir = path.join(this.dir, sub);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      if (keep.has(name)) continue;
      const stat = await fs.lstat(path.join(dir, name)).catch(() => undefined);
      if (stat === undefined || now - stat.mtime.getTime() <= graceMs) continue;
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}
