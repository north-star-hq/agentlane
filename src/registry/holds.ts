import type { DatabaseSync } from 'node:sqlite';
import { MINUTE_MS } from './config.ts';
import { UsageError } from './refusal.ts';
import { int, text } from './store.ts';

export const DEFAULT_HOLD_MS = 60 * MINUTE_MS;
export const MAX_HOLD_MS = 24 * 60 * MINUTE_MS;

const HOLD_FORM = 'minutes or hours, such as 45m, 2h or 1h30m';

export interface LaneHold {
  reason: string;
  since: number;
  until: number;
}

/** A `keep --for` time in milliseconds: `<n>m`, `<n>h` or `<n>h<n>m`, from a minute up to `MAX_HOLD_MS`. */
export function parseHoldTime(raw: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(raw.trim());
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new UsageError(`--for ${raw} is not a time`, `write --for as ${HOLD_FORM}`);
  }
  const ms = (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * MINUTE_MS;
  if (ms === 0) throw new UsageError(`--for ${raw} holds the lane for no time`, `pass at least 1m, as ${HOLD_FORM}`);
  if (ms > MAX_HOLD_MS) {
    throw new UsageError(`--for ${raw} is longer than a hold can last, which is 24h`, 'pass --for 24h or less');
  }
  return ms;
}

/** The lane's hold that counts at `now`: placed by the owner the lane has now, and not yet ended. */
export function readHold(db: DatabaseSync, laneId: string, ownerKey: string, now: number): LaneHold | null {
  const row = db
    .prepare('SELECT reason, since, until FROM holds WHERE claim_id = ? AND owner_key = ? AND until > ?')
    .get(laneId, ownerKey, now);
  return row ? { reason: text(row, 'reason'), since: int(row, 'since'), until: int(row, 'until') } : null;
}

/** Records `hold` as the lane's only hold, in place of any earlier one. */
export function writeHold(db: DatabaseSync, laneId: string, ownerKey: string, hold: LaneHold): void {
  db.prepare(
    `INSERT INTO holds (claim_id, owner_key, reason, since, until) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (claim_id) DO UPDATE SET owner_key = excluded.owner_key, reason = excluded.reason,
       since = excluded.since, until = excluded.until`,
  ).run(laneId, ownerKey, hold.reason, hold.since, hold.until);
}

/** Ends the hold `ownerKey` placed on the lane; true when there was one. */
export function dropHold(db: DatabaseSync, laneId: string, ownerKey: string): boolean {
  return Number(db.prepare('DELETE FROM holds WHERE claim_id = ? AND owner_key = ?').run(laneId, ownerKey).changes) > 0;
}
