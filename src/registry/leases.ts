import type { DatabaseSync } from 'node:sqlite';
import type { Platform } from '../devices/backend.ts';
import type { ProcessIdentity } from '../processes.ts';
import type { Row } from './store.ts';
import { int, optInt, text } from './store.ts';

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
  consolePort: number | null;
}

export type LeaseOutcome = 'present' | 'gone' | 'undeletable';

export type LeaseEnd = 'restored' | 'gone' | 'recorded-elsewhere' | 'no-room';

export const KEEPER_PID = 1;

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.start === b.start;
}

/**
 * Registries from 0.4.1 and earlier read a device row with no device id and a creator as a device being
 * created: it counts against the pool size and the memory budget while the creator lives, and once their
 * pre-lock snapshot proves the creator dead they adopt the listed device of the same name or drop the row.
 * A leased device's row becomes such a reservation under a name no device has, created by `keeper`, pid 1
 * with its start time, which those versions can't prove dead while the machine stays up. So they hold the
 * device's place until this version ends the lease, judging the lease by its holder.
 */
function insertLease(db: DatabaseSync, lease: DeviceLease, keeper: ProcessIdentity, now: number): DeviceLease {
  db.prepare(
    `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
       creator_pid, creator_start, claim_id, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    lease.reservation,
    lease.platform,
    lease.deviceType,
    lease.deviceTypeName,
    lease.runtime,
    lease.runtimeName,
    keeper.pid,
    keeper.start,
    now,
  );
  db.prepare(
    `INSERT INTO device_leases (reservation, name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
       created_at, work, holder_pid, holder_start, since, console_port)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    lease.reservation,
    lease.name,
    lease.platform,
    lease.id,
    lease.deviceType,
    lease.deviceTypeName,
    lease.runtime,
    lease.runtimeName,
    lease.createdAt,
    lease.work,
    lease.holder.pid,
    lease.holder.start,
    now,
    lease.consolePort,
  );
  return lease;
}

export interface LeaseTerms {
  reservation: string;
  work: DeviceWork;
  holder: ProcessIdentity;
  keeper: ProcessIdentity;
  consolePort: number | null;
  now: number;
}

export function leaseDevice(db: DatabaseSync, name: string, terms: LeaseTerms): DeviceLease | null {
  const row = db.prepare('SELECT * FROM devices WHERE name = ?').get(name);
  if (!row || row.device_id === null || row.claim_id !== null) return null;
  db.prepare('DELETE FROM devices WHERE name = ?').run(name);
  return insertLease(
    db,
    {
      reservation: terms.reservation,
      name,
      platform: text(row, 'platform') as Platform,
      id: text(row, 'device_id'),
      deviceType: text(row, 'device_type'),
      deviceTypeName: text(row, 'device_type_name'),
      runtime: text(row, 'runtime'),
      runtimeName: text(row, 'runtime_name'),
      createdAt: int(row, 'created_at'),
      work: terms.work,
      holder: terms.holder,
      consolePort: terms.consolePort,
    },
    terms.keeper,
    terms.now,
  );
}

function removeLease(db: DatabaseSync, lease: DeviceLease): void {
  db.prepare('DELETE FROM devices WHERE name = ? AND device_id IS NULL').run(lease.reservation);
  db.prepare('DELETE FROM device_leases WHERE reservation = ?').run(lease.reservation);
}

export function handOver(db: DatabaseSync, lease: DeviceLease, terms: LeaseTerms): DeviceLease {
  removeLease(db, lease);
  return insertLease(
    db,
    { ...lease, reservation: terms.reservation, work: terms.work, holder: terms.holder, consolePort: terms.consolePort },
    terms.keeper,
    terms.now,
  );
}

function leaseOf(row: Row): DeviceLease {
  return {
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
    consolePort: optInt(row, 'console_port'),
  };
}

export function allLeases(db: DatabaseSync): DeviceLease[] {
  return db.prepare('SELECT * FROM device_leases ORDER BY since, reservation').all().map(leaseOf);
}

export function leaseReservations(db: DatabaseSync): Map<string, DeviceWork> {
  return new Map(
    db
      .prepare('SELECT reservation, work FROM device_leases')
      .all()
      .map(r => [text(r, 'reservation'), text(r, 'work') as DeviceWork]),
  );
}

export function leasedConsolePorts(db: DatabaseSync): number[] {
  return db
    .prepare('SELECT console_port FROM device_leases WHERE console_port IS NOT NULL')
    .all()
    .map(r => int(r, 'console_port'));
}

export function heldBy(db: DatabaseSync, lease: DeviceLease, holder: ProcessIdentity): boolean {
  return (
    db
      .prepare('SELECT 1 FROM device_leases WHERE reservation = ? AND holder_pid = ? AND holder_start = ?')
      .get(lease.reservation, holder.pid, holder.start) !== undefined
  );
}

export function endLease(db: DatabaseSync, lease: DeviceLease, outcome: LeaseOutcome, poolCap: number): LeaseEnd {
  if (outcome === 'gone') {
    removeLease(db, lease);
    return 'gone';
  }
  if (db.prepare('SELECT 1 FROM devices WHERE device_id = ? OR name = ?').get(lease.id, lease.name)) {
    removeLease(db, lease);
    return 'recorded-elsewhere';
  }
  const others = db
    .prepare('SELECT COUNT(*) AS n FROM devices WHERE platform = ? AND name != ?')
    .get(lease.platform, lease.reservation);
  if (outcome === 'present' && others && int(others, 'n') >= poolCap) return 'no-room';
  removeLease(db, lease);
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
  return 'restored';
}
