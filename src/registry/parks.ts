import type { DatabaseSync } from 'node:sqlite';
import type { BrowserDriverName } from '../browser/kinds.ts';
import type { Platform } from '../devices/backend.ts';
import { DEVICE_NOUN } from '../devices/backend.ts';
import type { ProcessIdentity } from '../processes.ts';
import { names } from './rows.ts';
import type { Row } from './store.ts';
import { int, optInt, optText, text } from './store.ts';

export type ParkState = 'parking' | 'parked' | 'waking';

export interface ParkedDevice {
  platform: Platform;
  name: string;
  id: string;
  deviceType: string;
  deviceTypeName: string;
  runtime: string;
  runtimeName: string;
  booted: boolean;
}

export interface ParkRestarts {
  device: ParkedDevice | null;
  services: string[];
  /** The shared services the lane needed when it parked. */
  shared: string[];
  browser: BrowserDriverName | null;
  app: string | null;
}

export interface LanePark {
  state: ParkState;
  since: number;
  parkedAt: number | null;
  holder: ProcessIdentity | null;
  attempt: string | null;
  restarts: ParkRestarts;
  problems: string[];
}

export const NOTHING_TO_RESTART: ParkRestarts = { device: null, services: [], shared: [], browser: null, app: null };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

function restartsOf(raw: string): ParkRestarts {
  const parsed = JSON.parse(raw) as Partial<ParkRestarts>;
  return {
    device: parsed.device ?? null,
    services: strings(parsed.services),
    shared: strings(parsed.shared),
    browser: parsed.browser ?? null,
    app: typeof parsed.app === 'string' ? parsed.app : null,
  };
}

function parkOf(row: Row): LanePark {
  const pid = optInt(row, 'holder_pid');
  const start = optText(row, 'holder_start');
  return {
    state: text(row, 'state') as ParkState,
    since: int(row, 'since'),
    parkedAt: optInt(row, 'parked_at'),
    holder: pid !== null && start !== null ? { pid, start } : null,
    attempt: optText(row, 'attempt'),
    restarts: restartsOf(text(row, 'restarts')),
    problems: names(row, 'problems'),
  };
}

export function readPark(db: DatabaseSync, laneId: string): LanePark | null {
  const row = db.prepare('SELECT * FROM parks WHERE claim_id = ?').get(laneId);
  return row ? parkOf(row) : null;
}

export interface ParkWrite {
  state: ParkState;
  since: number;
  parkedAt: number | null;
  holder: ProcessIdentity | null;
  attempt: string | null;
  restarts: ParkRestarts;
  problems: readonly string[];
}

export function writePark(db: DatabaseSync, laneId: string, park: ParkWrite): void {
  db.prepare(
    `INSERT INTO parks (claim_id, state, since, parked_at, holder_pid, holder_start, attempt, restarts, problems)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (claim_id) DO UPDATE SET state = excluded.state, since = excluded.since, parked_at = excluded.parked_at,
       holder_pid = excluded.holder_pid, holder_start = excluded.holder_start, attempt = excluded.attempt,
       restarts = excluded.restarts, problems = excluded.problems`,
  ).run(
    laneId,
    park.state,
    park.since,
    park.parkedAt,
    park.holder?.pid ?? null,
    park.holder?.start ?? null,
    park.attempt,
    JSON.stringify(park.restarts),
    JSON.stringify(park.problems),
  );
}

export function dropPark(db: DatabaseSync, laneId: string): void {
  db.prepare('DELETE FROM parks WHERE claim_id = ?').run(laneId);
}

/** The restarts of two parks of one lane, for a lane parked again before a wake brought everything back. */
export function mergeRestarts(earlier: ParkRestarts, later: ParkRestarts): ParkRestarts {
  return {
    device: later.device ?? earlier.device,
    services: [...new Set([...earlier.services, ...later.services])],
    shared: [...new Set([...earlier.shared, ...later.shared])],
    browser: later.browser ?? earlier.browser,
    app: later.app ?? earlier.app,
  };
}

/** What a parked lane's next call brings back, in words. */
export function describeRestarts(restarts: ParkRestarts): string {
  const { device } = restarts;
  const parts = [
    ...(device ? [`${DEVICE_NOUN[device.platform]} ${device.name} (${device.deviceTypeName}, ${device.runtimeName})`] : []),
    ...(restarts.shared.length > 0 ? [`shared services ${restarts.shared.join(', ')}`] : []),
    ...(restarts.services.length > 0 ? [`services ${restarts.services.join(', ')}`] : []),
    ...(restarts.app ? [`the app ${restarts.app}`] : []),
    ...(restarts.browser ? [`the ${restarts.browser} browser`] : []),
  ];
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}
