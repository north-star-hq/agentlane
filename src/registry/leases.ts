import type { DatabaseSync } from 'node:sqlite';
import type { BackendDevice, Platform } from '../devices/backend.ts';
import type { ProcessIdentity } from '../processes.ts';
import { int, text } from './store.ts';

export type DeviceWork = 'shutdown' | 'delete';

export interface DeviceLease {
  reservation: string;
  name: string;
  platform: Platform;
  id: string;
  deviceType: string;
  deviceTypeName: string;
  runtime: string;
  runtimeName: string;
  createdAt: number;
  work: DeviceWork;
  holder: ProcessIdentity;
}

export type LeaseOutcome = 'present' | 'gone';

const NOUN: Readonly<Record<Platform, string>> = { ios: 'simulator', android: 'emulator' };

/**
 * Registries from 0.4.1 and earlier read a device row with no device id and a creator as a device being
 * created: held while the creator lives, adopted by device name or dropped once it dies. A leased device's
 * row becomes such a reservation under a name no device has and no lease reuses, so those versions never
 * hand it out or adopt it, and judge its holder by the process their own snapshot saw.
 */
export function leaseDevice(
  db: DatabaseSync,
  name: string,
  reservation: string,
  work: DeviceWork,
  holder: ProcessIdentity,
  now: number,
): DeviceLease | null {
  const row = db.prepare('SELECT * FROM devices WHERE name = ?').get(name);
  if (!row || row.device_id === null || row.claim_id !== null) return null;
  const lease: DeviceLease = {
    reservation,
    name,
    platform: text(row, 'platform') as Platform,
    id: text(row, 'device_id'),
    deviceType: text(row, 'device_type'),
    deviceTypeName: text(row, 'device_type_name'),
    runtime: text(row, 'runtime'),
    runtimeName: text(row, 'runtime_name'),
    createdAt: int(row, 'created_at'),
    work,
    holder,
  };
  db.prepare('DELETE FROM devices WHERE name = ?').run(name);
  db.prepare(
    `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
       creator_pid, creator_start, claim_id, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    reservation,
    lease.platform,
    lease.deviceType,
    lease.deviceTypeName,
    lease.runtime,
    lease.runtimeName,
    holder.pid,
    holder.start,
    now,
  );
  db.prepare(
    `INSERT INTO device_leases (reservation, name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
       created_at, work, holder_pid, holder_start, since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reservation,
    name,
    lease.platform,
    lease.id,
    lease.deviceType,
    lease.deviceTypeName,
    lease.runtime,
    lease.runtimeName,
    lease.createdAt,
    work,
    holder.pid,
    holder.start,
    now,
  );
  return lease;
}

export function allLeases(db: DatabaseSync): DeviceLease[] {
  return db
    .prepare('SELECT * FROM device_leases ORDER BY since, reservation')
    .all()
    .map(row => ({
      reservation: text(row, 'reservation'),
      name: text(row, 'name'),
      platform: text(row, 'platform') as Platform,
      id: text(row, 'device_id'),
      deviceType: text(row, 'device_type'),
      deviceTypeName: text(row, 'device_type_name'),
      runtime: text(row, 'runtime'),
      runtimeName: text(row, 'runtime_name'),
      createdAt: int(row, 'created_at'),
      work: text(row, 'work') as DeviceWork,
      holder: { pid: int(row, 'holder_pid'), start: text(row, 'holder_start') },
    }));
}

export function leaseReservations(db: DatabaseSync): Map<string, DeviceWork> {
  return new Map(
    db
      .prepare('SELECT reservation, work FROM device_leases')
      .all()
      .map(r => [text(r, 'reservation'), text(r, 'work') as DeviceWork]),
  );
}

function putBack(db: DatabaseSync, lease: DeviceLease, outcome: LeaseOutcome): boolean {
  db.prepare('DELETE FROM devices WHERE name = ? AND device_id IS NULL').run(lease.reservation);
  db.prepare('DELETE FROM device_leases WHERE reservation = ?').run(lease.reservation);
  if (outcome === 'gone') return false;
  if (db.prepare('SELECT 1 FROM devices WHERE device_id = ? OR name = ?').get(lease.id, lease.name)) return false;
  db.prepare(
    `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
       creator_pid, creator_start, claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    lease.name,
    lease.platform,
    lease.id,
    lease.deviceType,
    lease.deviceTypeName,
    lease.runtime,
    lease.runtimeName,
    lease.createdAt,
  );
  return true;
}

export function endLease(db: DatabaseSync, lease: DeviceLease, outcome: LeaseOutcome, holder: ProcessIdentity): boolean {
  const held = db
    .prepare('SELECT 1 FROM device_leases WHERE reservation = ? AND holder_pid = ? AND holder_start = ?')
    .get(lease.reservation, holder.pid, holder.start);
  if (!held) return false;
  putBack(db, lease, outcome);
  return true;
}

export function recoverLease(db: DatabaseSync, lease: DeviceLease, listed: ReadonlyMap<string, BackendDevice> | null): string {
  const noun = NOUN[lease.platform];
  const gone = listed !== null && !listed.has(lease.id);
  const restored = putBack(db, lease, gone ? 'gone' : 'present');
  const doing = lease.work === 'shutdown' ? 'shutting it down' : 'deleting it';
  if (gone) return `forgot pool ${noun} ${lease.name}: it no longer exists, and the process ${doing} had stopped`;
  if (!restored) return `forgot the lease on pool ${noun} ${lease.name}: the registry holds ${lease.id} under another record`;
  return `returned pool ${noun} ${lease.name} to the pool: the process ${doing} stopped before it finished`;
}
