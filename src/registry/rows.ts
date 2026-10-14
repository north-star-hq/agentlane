import type { DatabaseSync } from 'node:sqlite';
import type { BrowserDriverName } from '../browser/kinds.ts';
import { BROWSER_DEBUG_SERVICE, BROWSER_STREAM_SERVICE } from '../browser/kinds.ts';
import type { Platform } from '../devices/backend.ts';
import { EMULATOR_SERVICE, emulatorSerial } from './config.ts';
import type { Owner, OwnerKind } from './owner.ts';
import type { Row } from './store.ts';
import { int, optInt, optText, text } from './store.ts';
import type {
  Lane,
  ClaimedBrowser,
  ClaimedDevice,
  ClaimedPort,
  LaneInfo,
  EndedLane,
  EndReason,
  ResourceValues,
} from './types.ts';

export function ownerFromRow(row: Row): Owner {
  const pid = optInt(row, 'owner_pid');
  const start = optText(row, 'owner_start');
  return {
    kind: text(row, 'owner_kind') as OwnerKind,
    process: pid !== null && start !== null ? { pid, start } : null,
    sessionId: optText(row, 'owner_session'),
    threadId: optText(row, 'owner_thread'),
  };
}

export function deviceFromRow(row: Row, consolePort: number | null): ClaimedDevice | null {
  const id = optText(row, 'device_id');
  if (id === null) return null;
  const platform = text(row, 'platform') as Platform;
  return {
    platform,
    id,
    name: text(row, 'name'),
    deviceType: text(row, 'device_type'),
    deviceTypeName: text(row, 'device_type_name'),
    runtime: text(row, 'runtime'),
    runtimeName: text(row, 'runtime_name'),
    serial: platform === 'android' && consolePort !== null ? emulatorSerial(consolePort) : null,
  };
}

export function browserFromRow(row: Row, ports: readonly ClaimedPort[]): ClaimedBrowser | null {
  const debug = ports.find(p => p.service === BROWSER_DEBUG_SERVICE)?.port;
  if (debug === undefined) return null;
  return {
    driver: text(row, 'driver') as BrowserDriverName,
    session: text(row, 'session'),
    debugPort: debug,
    streamPort: ports.find(p => p.service === BROWSER_STREAM_SERVICE)?.port ?? null,
    createdAt: int(row, 'created_at'),
  };
}

export function endedFromHistory(row: Row): EndedLane {
  return {
    id: text(row, 'claim_id'),
    owner: text(row, 'owner_label'),
    worktree: text(row, 'worktree'),
    device: optText(row, 'device'),
    reason: text(row, 'reason') as EndReason,
    createdAt: int(row, 'created_at'),
    lastUsedAt: int(row, 'last_used_at'),
    lastAction: text(row, 'last_action'),
    endedAt: int(row, 'ended_at'),
    by: text(row, 'by_label'),
  };
}

export function loadLane(db: DatabaseSync, id: string): Lane | null {
  const info = loadLaneInfo(db, id);
  const row = db.prepare('SELECT token FROM claims WHERE id = ?').get(id);
  return info && row ? { ...info, token: text(row, 'token') } : null;
}

export function loadLaneInfo(db: DatabaseSync, id: string): LaneInfo | null {
  const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!row) return null;
  const device = db.prepare('SELECT * FROM devices WHERE claim_id = ?').get(id);
  const ports = db
    .prepare('SELECT * FROM ports WHERE claim_id = ? ORDER BY port')
    .all(id)
    .map(p => ({ service: text(p, 'service'), type: text(p, 'type'), port: int(p, 'port') }));
  const browser = db.prepare('SELECT * FROM browsers WHERE claim_id = ?').get(id);
  return {
    id,
    owner: ownerFromRow(row),
    ownerKey: text(row, 'owner_key'),
    projectRoot: text(row, 'project_root'),
    worktree: text(row, 'worktree'),
    createdAt: int(row, 'created_at'),
    lastUsedAt: int(row, 'last_used_at'),
    lastAction: text(row, 'last_action'),
    device: device ? deviceFromRow(device, ports.find(p => p.service === EMULATOR_SERVICE)?.port ?? null) : null,
    browser: browser ? browserFromRow(browser, ports) : null,
    ports,
    processes: db
      .prepare('SELECT * FROM processes WHERE claim_id = ? ORDER BY service')
      .all(id)
      .map(p => ({ service: text(p, 'service'), pid: int(p, 'pid'), start: text(p, 'start'), cwd: optText(p, 'cwd') })),
    resources: db
      .prepare('SELECT name, exports FROM resources WHERE claim_id = ? ORDER BY seq')
      .all(id)
      .map(r => ({ name: text(r, 'name'), exports: optValues(r, 'exports') })),
  };
}

export function values(row: Row, column: string): ResourceValues {
  const parsed = JSON.parse(text(row, column)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`registry column ${column} is not an object of values`);
  }
  const out: ResourceValues = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`registry column ${column} holds a value for ${key} that is not text`);
    out[key] = value;
  }
  return out;
}

export function names(row: Row, column: string): string[] {
  const parsed = JSON.parse(text(row, column)) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((n): n is string => typeof n === 'string')) {
    throw new Error(`registry column ${column} is not a list of names`);
  }
  return parsed;
}

export function optValues(row: Row, column: string): ResourceValues | null {
  return optText(row, column) === null ? null : values(row, column);
}
