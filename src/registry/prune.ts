import type { DatabaseSync } from 'node:sqlite';
import type { BackendDevice, DeviceBackend, Platform } from '../devices/backend.ts';
import { CLI, TOOL } from '../name.ts';
import { isPoolName } from './paths.ts';
import type { Store } from './store.ts';
import { optText, text } from './store.ts';

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

type Backends = Partial<Record<Platform, DeviceBackend>>;

const NOUN: Readonly<Record<Platform, string>> = { ios: 'simulator', android: 'emulator' };

const HAND_DELETE: Readonly<Record<Platform, string>> = {
  ios: 'xcrun simctl delete <id>',
  android: 'avdmanager delete avd -n <name>',
};

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
      if (isPoolName(platform, d.name)) listing.unrecorded.push({ name: d.name, platform, id: d.id });
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

function shownId(d: { name: string; id: string | null }): string {
  return d.id === null || d.id === d.name ? '' : `  ${d.id}`;
}

const STATE: Readonly<Record<FreePoolDevice['state'], string>> = {
  shutdown: 'shutdown',
  booted: 'booted, so it is shut down first',
  missing: 'already deleted, so only its record goes',
};

export function renderPruneListing(listing: PruneListing, deleting: boolean): string {
  const lines = [`${TOOL} registry: ${listing.stateDir}`, ''];
  const { free, kept, unrecorded } = listing;
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
  if (unrecorded.length > 0) {
    lines.push('', `named like pool devices but not in this registry, so left alone (${String(unrecorded.length)}):`);
    for (const d of unrecorded) lines.push(`  ${d.name}  ${NOUN[d.platform]}${shownId(d)}`);
    const platforms = [...new Set(unrecorded.map(d => d.platform))];
    lines.push(
      `  a registry in another state folder may hold them; if none does, ${platforms.map(p => HAND_DELETE[p]).join(' or ')} deletes one`,
    );
  }
  if (!deleting && free.length > 0) {
    lines.push(
      '',
      `${CLI} prune --yes deletes the ${String(free.length)} pool device${free.length === 1 ? '' : 's'} no lane holds`,
    );
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
