import type { DatabaseSync } from 'node:sqlite';
import type { ProcessIdentity } from '../processes.ts';
import type { ProvenState } from './owner.ts';
import type { Row } from './store.ts';
import { int, optInt, optText, text } from './store.ts';

/** How long a lane stays parked, after its owner is found gone, for that owner's session to come back before it ends. */
export const RETURN_WINDOW_MS = 30 * 60_000;
/** How long a sighting of a lane's owner, by a check or by a call on the lane, spares the owner a check of its process. */
export const OWNER_CHECK_MS = 4 * 60_000;
/** How long an end of a lane may stand unfinished before the sweep asks whether the process ending it still runs. */
export const REAP_RETRY_MS = 5 * 60_000;

/** A lane's owner as the sweep or a claim found it gone, and the process ending the lane once its window has passed. */
export interface OwnerGone {
  state: ProvenState;
  foundAt: number;
  reaper: ProcessIdentity | null;
  reapingSince: number | null;
  attempt: string | null;
}

/** What the checks of a lane's owner found: when one last found it alive or could not tell, and when one found it gone. */
export interface OwnerCheck {
  checkedAt: number | null;
  gone: OwnerGone | null;
}

function goneOf(row: Row): OwnerGone | null {
  const state = optText(row, 'gone');
  if (state === null) return null;
  const pid = optInt(row, 'reaper_pid');
  const start = optText(row, 'reaper_start');
  return {
    state: state as ProvenState,
    foundAt: int(row, 'gone_at'),
    reaper: pid !== null && start !== null ? { pid, start } : null,
    reapingSince: optInt(row, 'reaping_since'),
    attempt: optText(row, 'attempt'),
  };
}

/** The checks of the lane's owner keyed `ownerKey`; null when none was recorded, or it was about another owner. */
export function readCheck(db: DatabaseSync, laneId: string, ownerKey: string): OwnerCheck | null {
  const row = db.prepare('SELECT * FROM owner_checks WHERE claim_id = ?').get(laneId);
  if (!row || text(row, 'owner_key') !== ownerKey) return null;
  return { checkedAt: optInt(row, 'checked_at'), gone: goneOf(row) };
}

/** Records `at` as when a check last found the owner keyed `ownerKey` alive, or could not tell, unless it is found gone. */
export function noteChecked(db: DatabaseSync, laneId: string, ownerKey: string, at: number): void {
  db.prepare(
    `INSERT INTO owner_checks (claim_id, owner_key, checked_at) VALUES (?, ?, ?)
     ON CONFLICT (claim_id) DO UPDATE SET owner_key = excluded.owner_key, checked_at = excluded.checked_at,
       gone = NULL, gone_at = NULL, reaper_pid = NULL, reaper_start = NULL, reaping_since = NULL, attempt = NULL
     WHERE owner_checks.owner_key != excluded.owner_key
       OR (owner_checks.gone IS NULL AND (owner_checks.checked_at IS NULL OR owner_checks.checked_at < excluded.checked_at))`,
  ).run(laneId, ownerKey, at);
}

/** Records the owner keyed `ownerKey` as found gone at `at`, unless it was found gone before; true when this is the first. */
export function noteGone(db: DatabaseSync, laneId: string, ownerKey: string, state: ProvenState, at: number): boolean {
  if (readCheck(db, laneId, ownerKey)?.gone) return false;
  db.prepare(
    `INSERT INTO owner_checks (claim_id, owner_key, gone, gone_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (claim_id) DO UPDATE SET owner_key = excluded.owner_key, gone = excluded.gone, gone_at = excluded.gone_at,
       reaper_pid = NULL, reaper_start = NULL, reaping_since = NULL, attempt = NULL`,
  ).run(laneId, ownerKey, state, at);
  return true;
}

/** Forgets what the checks found, as when the lane's owner comes back. */
export function dropCheck(db: DatabaseSync, laneId: string): void {
  db.prepare('DELETE FROM owner_checks WHERE claim_id = ?').run(laneId);
}

export function startReap(db: DatabaseSync, laneId: string, reaper: ProcessIdentity, attempt: string, at: number): void {
  db.prepare('UPDATE owner_checks SET reaper_pid = ?, reaper_start = ?, reaping_since = ?, attempt = ? WHERE claim_id = ?').run(
    reaper.pid,
    reaper.start,
    at,
    attempt,
    laneId,
  );
}

export function stopReap(db: DatabaseSync, laneId: string, attempt: string): void {
  db.prepare(
    'UPDATE owner_checks SET reaper_pid = NULL, reaper_start = NULL, reaping_since = NULL, attempt = NULL WHERE claim_id = ? AND attempt = ?',
  ).run(laneId, attempt);
}
