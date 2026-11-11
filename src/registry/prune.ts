import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackendDevice, DeviceBackend, DeviceDisk, Platform } from '../devices/backend.ts';
import { dataDir } from '../driver/install.ts';
import { CLI, FORMER, TOOL } from '../name.ts';
import { formerStateDir, isPoolName, registryDirs } from './paths.ts';
import { UsageError } from './refusal.ts';
import { optText, Store, text } from './store.ts';

export interface FreePoolDevice {
  name: string;
  platform: Platform;
  id: string;
  deviceTypeName: string;
  runtimeName: string;
  state: 'booted' | 'shutdown' | 'missing';
}

export interface KeptPoolDevice {
  name: string;
  platform: Platform;
  id: string | null;
  laneId: string | null;
  reason: string;
}

export interface UnrecordedDevice {
  name: string;
  platform: Platform;
  id: string;
  booted: boolean;
  disk: DeviceDisk | null;
}

export interface PruneListing {
  stateDir: string;
  free: FreePoolDevice[];
  kept: KeptPoolDevice[];
  unrecorded: UnrecordedDevice[];
}

export type PruneOutcome = 'deleted' | 'forgotten' | 'kept' | 'failed';

export interface PruneResult {
  device: FreePoolDevice;
  outcome: PruneOutcome;
  detail: string | null;
}

export interface OrphanDevice {
  name: string;
  platform: Platform;
  id: string;
  paths: string[];
  bytes: number | null;
}

export interface Leftover {
  kind: 'downloads' | 'build-cache';
  path: string;
  repository: string | null;
  bytes: number;
}

export interface PruneReport {
  stateDir: string;
  registries: string[];
  free: FreePoolDevice[];
  kept: KeptPoolDevice[];
  orphans: OrphanDevice[];
  leftovers: Leftover[];
  leftoversKept: string | null;
}

export type SweepOutcome = 'deleted' | 'gone' | 'kept' | 'failed';

export interface OrphanResult {
  device: OrphanDevice;
  outcome: SweepOutcome;
  detail: string | null;
}

export interface LeftoverResult {
  leftover: Leftover;
  outcome: SweepOutcome;
  detail: string | null;
}

export interface PruneContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  lockWaitMs: number;
}

type Backends = Partial<Record<Platform, DeviceBackend>>;

const NOUN: Readonly<Record<Platform, string>> = { ios: 'simulator', android: 'emulator' };

const DELETING = '.deleting-';

export function requireHome(env: NodeJS.ProcessEnv): void {
  if (env.HOME && path.isAbsolute(env.HOME)) return;
  throw new UsageError(
    'prune needs HOME to find every registry and download folder on this machine',
    'set HOME to your home folder',
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noTool(platform: Platform): string {
  return `this machine has no ${NOUN[platform]} tool to check it with`;
}

export function listPrunable(store: Store | null, dir: string, backends: Backends): PruneListing {
  const listing: PruneListing = { stateDir: dir, free: [], kept: [], unrecorded: [] };
  const listed = new Map<Platform, Map<string, BackendDevice> | Error>();
  for (const backend of Object.values(backends)) {
    try {
      listed.set(backend.platform, new Map(backend.list().map(d => [d.id, d])));
    } catch (error) {
      listed.set(backend.platform, error instanceof Error ? error : new Error(String(error)));
    }
  }
  const recorded = new Set<string>();
  const rows = store ? store.db.prepare('SELECT * FROM devices ORDER BY created_at, name').all() : [];
  for (const row of rows) {
    const name = text(row, 'name');
    const platform = text(row, 'platform') as Platform;
    const id = optText(row, 'device_id');
    const laneId = optText(row, 'claim_id');
    recorded.add(`${platform} ${name}`);
    if (id !== null) recorded.add(`${platform} ${id}`);
    const keep = (reason: string) => listing.kept.push({ name, platform, id, laneId, reason });
    const devices = listed.get(platform);
    if (laneId !== null) keep(`held by lane ${laneId}`);
    else if (id === null) keep('a claim is creating it');
    else if (!isPoolName(platform, name)) keep('its name is not a pool name');
    else if (devices === undefined) keep(noTool(platform));
    else if (devices instanceof Error) keep(`could not list the ${NOUN[platform]}s: ${devices.message}`);
    else {
      const device = devices.get(id);
      if (device && device.name !== name) keep(`${id} is named ${device.name} now`);
      else {
        listing.free.push({
          name,
          platform,
          id,
          deviceTypeName: text(row, 'device_type_name'),
          runtimeName: text(row, 'runtime_name'),
          state: device === undefined ? 'missing' : device.booted ? 'booted' : 'shutdown',
        });
      }
    }
  }
  for (const [platform, devices] of listed) {
    if (devices instanceof Error) continue;
    for (const d of devices.values()) {
      if (recorded.has(`${platform} ${d.id}`) || recorded.has(`${platform} ${d.name}`)) continue;
      if (isPoolName(platform, d.name)) {
        listing.unrecorded.push({ name: d.name, platform, id: d.id, booted: d.booted, disk: d.disk ?? null });
      }
    }
  }
  listing.unrecorded.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
  return listing;
}

export function deletePoolDevice(db: DatabaseSync, backend: DeviceBackend | undefined, device: FreePoolDevice): PruneResult {
  const result = (outcome: PruneOutcome, detail: string | null = null): PruneResult => ({ device, outcome, detail });
  const row = db.prepare('SELECT * FROM devices WHERE name = ?').get(device.name);
  if (!row || optText(row, 'device_id') !== device.id || text(row, 'platform') !== device.platform) {
    return result('kept', 'its registry record changed after the listing');
  }
  const laneId = optText(row, 'claim_id');
  if (laneId !== null) return result('kept', `lane ${laneId} claimed it after the listing`);
  if (!isPoolName(device.platform, device.name)) return result('kept', 'its name is not a pool name');
  if (!backend) return result('kept', noTool(device.platform));
  let present: BackendDevice | undefined;
  try {
    present = backend.list().find(d => d.id === device.id);
  } catch (error) {
    return result('failed', `could not list the ${NOUN[device.platform]}s: ${messageOf(error)}`);
  }
  if (present && present.name !== device.name) return result('kept', `${device.id} is named ${present.name} now`);
  if (present) {
    try {
      if (present.booted) backend.shutdown(device.id);
      backend.delete(device.id);
    } catch (error) {
      return result('failed', messageOf(error));
    }
  }
  db.prepare('DELETE FROM devices WHERE name = ?').run(device.name);
  return present ? result('deleted') : result('forgotten', 'it no longer exists');
}

/** The space the files take on disk, as `du` counts it. */
export function diskBytes(paths: readonly string[]): number {
  let total = 0;
  const pending = [...paths];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch {
      continue;
    }
    total += stat.blocks * 512;
    if (!stat.isDirectory()) continue;
    try {
      for (const entry of fs.readdirSync(next)) pending.push(path.join(next, entry));
    } catch {
      continue;
    }
  }
  return total;
}

function openRegistries(dirs: readonly string[], lockWaitMs: number): Store[] {
  const stores: Store[] = [];
  try {
    for (const dir of [...dirs].sort()) {
      const store = Store.openExisting(dir, lockWaitMs);
      if (store) stores.push(store);
    }
  } catch (error) {
    for (const store of stores) store.close();
    throw error;
  }
  return stores;
}

function underLocks<T>(stores: readonly Store[], body: () => T): T {
  const [first, ...rest] = stores;
  return first ? first.write(() => underLocks(rest, body)) : body();
}

function recordOf(store: Store, name: string, id: string): { laneId: string | null } | null {
  const row = store.db
    .prepare('SELECT claim_id FROM devices WHERE name IN (?, ?) OR device_id IN (?, ?)')
    .get(name, id, name, id);
  return row ? { laneId: optText(row, 'claim_id') } : null;
}

const FOLDER_COLUMNS = [
  'SELECT project_root AS folder FROM claims',
  'SELECT worktree AS folder FROM claims',
  'SELECT worktree AS folder FROM history',
  'SELECT worktree AS folder FROM queue',
  'SELECT worktree AS folder FROM resources',
  'SELECT worktree AS folder FROM browsers',
].join(' UNION ');

function foldersOf(store: Store): string[] {
  return store.db
    .prepare(FOLDER_COLUMNS)
    .all()
    .map(row => text(row, 'folder'));
}

function lanesIn(store: Store): string[] {
  const lanes = store.db.prepare('SELECT id FROM claims ORDER BY created_at').all();
  const queued = store.db.prepare('SELECT ticket FROM queue ORDER BY ticket').all();
  return [...lanes.map(row => `lane ${text(row, 'id')}`), ...queued.map(() => 'a claim waiting in the queue')];
}

function gitCommonDir(folder: string): string | null {
  if (!fs.existsSync(folder)) return null;
  const result = spawnSync('git', ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  try {
    return fs.realpathSync(result.stdout.trim());
  } catch {
    return null;
  }
}

function withAsideCopies(target: string): string[] {
  const parent = path.dirname(target);
  const base = path.basename(target);
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter(name => name === base || name.startsWith(`${base}${DELETING}`))
    .sort()
    .map(name => path.join(parent, name));
}

function repositoryOf(commonDir: string): string {
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
}

/** What 0.2.x left: its downloads, and the build cache in the git folder of each repository named. */
export function formerLeftovers(env: NodeJS.ProcessEnv, commonDirs: readonly string[]): Leftover[] {
  const found: Leftover[] = [];
  for (const target of withAsideCopies(downloadsDir(env))) {
    found.push({ kind: 'downloads', path: target, repository: null, bytes: diskBytes([target]) });
  }
  for (const common of [...new Set(commonDirs)].sort()) {
    for (const target of withAsideCopies(path.join(common, FORMER.tool, 'build-cache'))) {
      found.push({ kind: 'build-cache', path: target, repository: repositoryOf(common), bytes: diskBytes([target]) });
    }
  }
  return found;
}

function formerLanesReason(dir: string, lanes: readonly string[]): string {
  return `the registry in ${dir}, the one 0.2.x reads, has ${lanes.join(', ')}, which may be 0.2.x's; prune deletes what 0.2.x left once that registry has no lanes`;
}

/**
 * Splits the devices the registry in use has no record of by what the other registries on this Mac say: one that no
 * registry records and that is not booted is an orphan to offer. Adds the folders 0.2.x left, from the repositories
 * that `cwd` and every registry's lanes are in.
 */
export function reportPrunable(listing: PruneListing, ctx: PruneContext): PruneReport {
  requireHome(ctx.env);
  const dirs = registryDirs(ctx.env);
  const report: PruneReport = {
    stateDir: listing.stateDir,
    registries: dirs,
    free: listing.free,
    kept: [...listing.kept],
    orphans: [],
    leftovers: [],
    leftoversKept: null,
  };
  const folders = new Set<string>([ctx.cwd]);
  let stores: Store[] = [];
  let unreadable: string | null = null;
  try {
    stores = openRegistries(dirs, ctx.lockWaitMs);
  } catch (error) {
    unreadable = messageOf(error);
  }
  try {
    for (const d of listing.unrecorded) {
      const keep = (reason: string, laneId: string | null = null) =>
        report.kept.push({ name: d.name, platform: d.platform, id: d.id, laneId, reason });
      if (unreadable !== null) {
        keep(`could not read every registry on this Mac: ${unreadable}`);
        continue;
      }
      const elsewhere = stores
        .filter(s => s.dir !== listing.stateDir)
        .map(s => ({ dir: s.dir, record: recordOf(s, d.name, d.id) }))
        .find(found => found.record !== null);
      if (elsewhere?.record) {
        const { laneId } = elsewhere.record;
        keep(
          laneId === null
            ? `the registry in ${elsewhere.dir} records it`
            : `held by lane ${laneId} in the registry in ${elsewhere.dir}`,
          laneId,
        );
      } else if (d.booted) keep('no registry records it, but it is booted, so something may be using it');
      else {
        const paths = d.disk?.paths ?? [];
        report.orphans.push({
          name: d.name,
          platform: d.platform,
          id: d.id,
          paths,
          bytes: d.disk?.bytes ?? (paths.length > 0 ? diskBytes(paths) : null),
        });
      }
    }
    for (const store of stores) for (const folder of foldersOf(store)) folders.add(folder);
    const former = stores.find(s => s.dir === formerStateDir(ctx.env));
    const lanes = former ? lanesIn(former) : [];
    if (unreadable !== null) report.leftoversKept = `could not read every registry on this Mac: ${unreadable}`;
    else if (former && lanes.length > 0) report.leftoversKept = formerLanesReason(former.dir, lanes);
  } finally {
    for (const store of stores) store.close();
  }
  const commonDirs = [...folders].map(gitCommonDir).filter((dir): dir is string => dir !== null);
  report.leftovers = formerLeftovers(ctx.env, commonDirs);
  return report;
}

/**
 * Deletes a device no registry records. Every registry on this Mac stays locked from the check to the deletion, so a
 * lane of either version that records it meanwhile keeps it.
 */
export function deleteOrphan(ctx: PruneContext, backend: DeviceBackend | undefined, device: OrphanDevice): OrphanResult {
  requireHome(ctx.env);
  const result = (outcome: SweepOutcome, detail: string | null = null): OrphanResult => ({ device, outcome, detail });
  if (!backend) return result('kept', noTool(device.platform));
  let stores: Store[];
  try {
    stores = openRegistries(registryDirs(ctx.env), ctx.lockWaitMs);
  } catch (error) {
    return result('failed', messageOf(error));
  }
  try {
    return underLocks(stores, () => {
      for (const store of stores) {
        if (recordOf(store, device.name, device.id)) return result('kept', `the registry in ${store.dir} records it now`);
      }
      let present: BackendDevice | undefined;
      try {
        present = backend.list().find(d => d.id === device.id);
      } catch (error) {
        return result('failed', `could not list the ${NOUN[device.platform]}s: ${messageOf(error)}`);
      }
      if (!present) return result('gone', 'it no longer exists');
      if (present.name !== device.name) return result('kept', `${device.id} is named ${present.name} now`);
      if (present.booted) return result('kept', 'it was booted after the listing');
      try {
        backend.delete(device.id);
      } catch (error) {
        return result('failed', messageOf(error));
      }
      return result('deleted');
    });
  } catch (error) {
    return result('failed', messageOf(error));
  } finally {
    for (const store of stores) store.close();
  }
}

function downloadsDir(env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(dataDir(env)), FORMER.tool);
}

function withoutAside(name: string): string {
  const at = name.indexOf(DELETING);
  return at < 0 ? name : name.slice(0, at);
}

function isLeftoverPath(env: NodeJS.ProcessEnv, leftover: Leftover): boolean {
  const { kind, path: target } = leftover;
  if (!path.isAbsolute(target) || path.normalize(target) !== target) return false;
  const parent = path.dirname(target);
  if (kind === 'downloads')
    return parent === path.dirname(downloadsDir(env)) && withoutAside(path.basename(target)) === FORMER.tool;
  const common = path.dirname(parent);
  return (
    withoutAside(path.basename(target)) === 'build-cache' &&
    path.basename(parent) === FORMER.tool &&
    gitCommonDir(common) === common
  );
}

function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    return;
  }
}

/**
 * Deletes what 0.2.x left, unless 0.2.x's registry has a lane. Its lock is held while each folder is renamed aside, so
 * a 0.2.x lane can't start on a half-deleted folder; the renamed copies are deleted after the lock is let go.
 */
export function deleteLeftovers(ctx: PruneContext, leftovers: readonly Leftover[]): LeftoverResult[] {
  requireHome(ctx.env);
  if (leftovers.length === 0) return [];
  const dir = formerStateDir(ctx.env);
  const all = (outcome: SweepOutcome, detail: string): LeftoverResult[] =>
    leftovers.map(leftover => ({ leftover, outcome, detail }));
  let store: Store | null;
  try {
    store = Store.openExisting(dir, ctx.lockWaitMs);
  } catch (error) {
    return all('failed', messageOf(error));
  }
  const moved: { leftover: Leftover; aside: string | null; problem: string | null }[] = [];
  const moveAside = (): string | null => {
    const lanes = store ? lanesIn(store) : [];
    if (lanes.length > 0) return formerLanesReason(dir, lanes);
    for (const leftover of leftovers) {
      if (!isLeftoverPath(ctx.env, leftover)) {
        moved.push({ leftover, aside: null, problem: 'refused: it is not a folder 0.2.x leaves' });
      } else if (!fs.existsSync(leftover.path)) moved.push({ leftover, aside: null, problem: null });
      else if (path.basename(leftover.path).includes(DELETING)) moved.push({ leftover, aside: leftover.path, problem: null });
      else {
        const aside = `${leftover.path}${DELETING}${randomBytes(3).toString('hex')}`;
        try {
          fs.renameSync(leftover.path, aside);
          moved.push({ leftover, aside, problem: null });
        } catch (error) {
          moved.push({ leftover, aside: null, problem: messageOf(error) });
        }
      }
    }
    return null;
  };
  let blocked: string | null;
  try {
    blocked = store ? store.write(moveAside) : moveAside();
  } catch (error) {
    return all('failed', messageOf(error));
  } finally {
    store?.close();
  }
  if (blocked !== null) return all('kept', blocked);
  return moved.map(({ leftover, aside, problem }): LeftoverResult => {
    if (problem !== null) return { leftover, outcome: 'failed', detail: problem };
    if (aside === null) return { leftover, outcome: 'gone', detail: 'it no longer exists' };
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch (error) {
      return { leftover, outcome: 'failed', detail: `${aside}: ${messageOf(error)}` };
    }
    if (leftover.kind === 'build-cache') removeIfEmpty(path.dirname(leftover.path));
    return { leftover, outcome: 'deleted', detail: null };
  });
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${String(Math.ceil(bytes / 1e3))} kB`;
}

function totalBytes(items: readonly { bytes: number | null }[]): string {
  return formatBytes(items.reduce((sum, item) => sum + (item.bytes ?? 0), 0));
}

function shownId(d: { name: string; id: string | null }): string {
  return d.id === null || d.id === d.name ? '' : `  ${d.id}`;
}

const STATE: Readonly<Record<FreePoolDevice['state'], string>> = {
  shutdown: 'shutdown',
  booted: 'booted, so it is shut down first',
  missing: 'already deleted, so only its record goes',
};

function describeLeftover(l: Leftover): string {
  return l.kind === 'downloads' ? "0.2.x's Maestro and browser downloads" : `0.2.x's build cache for ${l.repository ?? ''}`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function renderPruneReport(report: PruneReport, deleting: boolean): string {
  const lines = [`${TOOL} registry: ${report.stateDir}`];
  const others = report.registries.filter(dir => dir !== report.stateDir);
  if (others.length > 0) lines.push(`also checked: ${others.join(', ')}`);
  lines.push('');
  const { free, kept, orphans, leftovers } = report;
  if (free.length === 0) lines.push('no pool device is free to delete');
  else {
    lines.push(`pool devices no lane holds (${String(free.length)}):`);
    for (const d of free) {
      lines.push(`  ${d.name}  ${NOUN[d.platform]}  ${d.deviceTypeName}, ${d.runtimeName}${shownId(d)}  ${STATE[d.state]}`);
    }
  }
  if (kept.length > 0) {
    lines.push('', `kept (${String(kept.length)}):`);
    for (const d of kept) lines.push(`  ${d.name}  ${NOUN[d.platform]}${shownId(d)}  ${d.reason}`);
  }
  if (orphans.length > 0) {
    lines.push('', `named like pool devices but in no registry on this Mac (${String(orphans.length)}, ${totalBytes(orphans)}):`);
    for (const d of orphans) lines.push(`  ${d.name}  ${NOUN[d.platform]}${shownId(d)}  ${formatBytes(d.bytes)}`);
  }
  if (leftovers.length > 0) {
    lines.push('', `what 0.2.x left (${String(leftovers.length)}, ${totalBytes(leftovers)}):`);
    for (const l of leftovers) lines.push(`  ${l.path}  ${describeLeftover(l)}  ${formatBytes(l.bytes)}`);
    if (report.leftoversKept !== null) lines.push(`  kept: ${report.leftoversKept}`);
  }
  const offered = [
    free.length > 0 ? `the ${plural(free.length, 'pool device')} no lane holds` : null,
    orphans.length > 0 ? `the ${plural(orphans.length, 'device')} no registry records` : null,
    leftovers.length > 0 && report.leftoversKept === null ? 'what 0.2.x left' : null,
  ].filter((part): part is string => part !== null);
  if (!deleting && offered.length > 0) {
    const last = offered.pop() ?? '';
    lines.push('', `${CLI} prune --yes deletes ${offered.length > 0 ? `${offered.join(', ')} and ${last}` : last}`);
  }
  return `${lines.join('\n')}\n`;
}

export function describePruneResult(r: PruneResult): string {
  const { name, platform } = r.device;
  switch (r.outcome) {
    case 'deleted':
      return `deleted ${name} (${NOUN[platform]}${r.device.id === name ? '' : ` ${r.device.id}`})`;
    case 'forgotten':
      return `forgot ${name}: ${r.detail ?? ''}`;
    case 'kept':
      return `kept ${name}: ${r.detail ?? ''}`;
    case 'failed':
      return `could not delete ${name}: ${r.detail ?? ''}`;
  }
}

function describeSweep(what: string, size: number | null, outcome: SweepOutcome, detail: string | null): string {
  switch (outcome) {
    case 'deleted':
      return `deleted ${what} (${formatBytes(size)})`;
    case 'gone':
      return `skipped ${what}: ${detail ?? ''}`;
    case 'kept':
      return `kept ${what}: ${detail ?? ''}`;
    case 'failed':
      return `could not delete ${what}: ${detail ?? ''}`;
  }
}

export function describeOrphanResult(r: OrphanResult): string {
  const { name, platform, id } = r.device;
  return describeSweep(`${name} (${NOUN[platform]}${id === name ? '' : ` ${id}`})`, r.device.bytes, r.outcome, r.detail);
}

export function describeLeftoverResult(r: LeftoverResult): string {
  return describeSweep(r.leftover.path, r.leftover.bytes, r.outcome, r.detail);
}
