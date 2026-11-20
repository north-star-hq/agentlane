import type { DatabaseSync } from 'node:sqlite';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { isProven, judgeProcess } from './owner.ts';
import type { LanePark } from './parks.ts';
import { readPark } from './parks.ts';
import { values } from './rows.ts';
import type { Row } from './store.ts';
import { int, optInt, optText, text } from './store.ts';
import type { ResourceValues } from './types.ts';

/** How long a running shared service is left up once no active lane, and no teardown, needs it. */
export const SHARED_IDLE_MS = 5 * 60_000;
/** How long after a failed stop the sweep tries that stop again. */
export const SHARED_STOP_RETRY_MS = 5 * 60_000;
/** How many times its timeout a start or stop may hold a shared service before the sweep looks at its holder. */
export const SHARED_HOLD_TIMEOUTS = 3;

export type SharedState = 'stopped' | 'starting' | 'running' | 'stopping';

/** A shared service: the repository whose lanes share it, as the lanes record it, and its name under `shared`. */
export interface SharedKey {
  repository: string;
  name: string;
}

/** What a shared service's start, stop and ready run with, as recorded at its last start. */
export interface SharedCommands {
  start: string;
  stop: string;
  ready: string;
  cwd: string;
  timeoutMs: number;
  /** Variables set on top of the environment of the process running a command, such as the PATH its start had. */
  env: ResourceValues;
}

/** Whom a start is for: an active lane, or a resource teardown this process holds. */
export type SharedNeed = { kind: 'lane'; repository: string; lane: string } | { kind: 'teardown'; repository: string };

export type SharedStartClaim =
  /** Recorded as running with no problem: the caller checks it answers. */
  | { kind: 'running'; key: SharedKey; commands: SharedCommands }
  | { kind: 'busy'; key: SharedKey; state: 'starting' | 'stopping'; holder: ProcessIdentity; since: number; timeoutMs: number }
  /** This process holds the start: it runs ready, and start unless ready passes. */
  | { kind: 'claimed'; key: SharedKey; commands: SharedCommands; took: { state: SharedState; pid: number } | null }
  /** No start of it was ever recorded in this repository, so its commands are unknown. */
  | { kind: 'unknown'; key: SharedKey };

export type SharedStopClaim =
  | {
      kind: 'claimed';
      key: SharedKey;
      commands: SharedCommands;
      unneededSince: number;
      took: { state: SharedState; pid: number } | null;
    }
  | { kind: 'left'; key: SharedKey; reason: string };

export interface SharedTeardownNeed {
  lane: string;
  resource: string;
}

export interface SharedServiceStatus {
  repository: string;
  name: string;
  state: SharedState;
  /** When it entered its state. */
  since: number;
  /** The active lanes that need it, by id. */
  lanes: string[];
  /** The resources whose create or teardown runs now and needs it. */
  holding: SharedTeardownNeed[];
  /** Since when nothing has needed it, as recorded at the transition that left none; null while something does. */
  unneededSince: number | null;
  /**
   * When the sweep stops it unless something needs it again first; null while something needs it, while it is not
   * running, and before a sweep has marked one that nothing needed when it was first seen.
   */
  stopsAt: number | null;
  /** The pid starting or stopping it; null otherwise. */
  by: number | null;
  /** What went wrong at its last failed start or stop; null once one succeeds. */
  problem: string | null;
  /** Failed stops since it last stopped or started. */
  attempts: number;
  commands: SharedCommands;
}

/**
 * Whether a lane counts as active for shared services: neither parked nor ended. A lane being parked is active until its
 * park finishes, unless it was parked before, which a park retried by the sweep is.
 */
export function laneActive(park: LanePark | null): boolean {
  if (!park) return true;
  if (park.state === 'waking') return true;
  return park.state === 'parking' && park.parkedAt === null;
}

const ACTIVE_PARK = `(p.claim_id IS NULL OR p.state = 'waking' OR (p.state = 'parking' AND p.parked_at IS NULL))`;

const ACTIVE_NEEDERS = `SELECT n.claim_id AS id FROM shared_needs n JOIN claims c ON c.id = n.claim_id
  LEFT JOIN parks p ON p.claim_id = c.id
  WHERE c.project_root = ? AND n.name = ? AND ${ACTIVE_PARK}`;

const HELD_ROWS = `SELECT r.seq, r.claim_id, r.name, r.holder_pid, r.holder_start FROM resources r
  WHERE r.holder_pid IS NOT NULL AND r.repository = ? AND EXISTS (SELECT 1 FROM json_each(r.needs) j WHERE j.value = ?)`;

function activeNeeders(db: DatabaseSync, key: SharedKey): string[] {
  return db
    .prepare(`${ACTIVE_NEEDERS} ORDER BY n.claim_id`)
    .all(key.repository, key.name)
    .map(r => text(r, 'id'));
}

function heldRows(db: DatabaseSync, key: SharedKey): Row[] {
  return db.prepare(`${HELD_ROWS} ORDER BY r.seq`).all(key.repository, key.name);
}

function commandsOf(row: Row): SharedCommands {
  return {
    start: text(row, 'start'),
    stop: text(row, 'stop'),
    ready: text(row, 'ready'),
    cwd: text(row, 'cwd'),
    timeoutMs: int(row, 'timeout_ms'),
    env: values(row, 'env'),
  };
}

function holderOf(row: Row): ProcessIdentity | null {
  const pid = optInt(row, 'holder_pid');
  const start = optText(row, 'holder_start');
  return pid !== null && start !== null ? { pid, start } : null;
}

function readRow(db: DatabaseSync, key: SharedKey): Row | undefined {
  return db.prepare('SELECT * FROM shared_services WHERE repository = ? AND name = ?').get(key.repository, key.name);
}

/** The holders of shared services and of resource rows as `ps` saw them before the write lock. */
export interface SharedHolders {
  table: ReadonlyMap<number, string> | undefined;
  seen: ReadonlySet<string>;
}

function seenKey(pid: number, start: string): string {
  return `${String(pid)}:${start}`;
}

export function sharedHoldersBeforeLock(db: DatabaseSync, processes: ProcessTable): SharedHolders {
  const seen = new Set<string>();
  const pids = new Set<number>();
  const rows = [
    ...db.prepare('SELECT holder_pid, holder_start FROM shared_services WHERE holder_pid IS NOT NULL').all(),
    ...db.prepare('SELECT holder_pid, holder_start FROM resources WHERE holder_pid IS NOT NULL').all(),
  ];
  for (const row of rows) {
    const pid = int(row, 'holder_pid');
    seen.add(seenKey(pid, text(row, 'holder_start')));
    pids.add(pid);
  }
  return { table: pids.size === 0 ? new Map() : processes.startTimes([...pids]), seen };
}

/** Whether `holder` was in the snapshot and the snapshot proves it gone; a holder taken on after the snapshot counts as alive. */
function provenGone(holder: ProcessIdentity, holders: SharedHolders): boolean {
  if (!holders.seen.has(seenKey(holder.pid, holder.start))) return false;
  return isProven(judgeProcess(holder, holders.table));
}

function sameHolder(row: Row, me: ProcessIdentity): boolean {
  const holder = holderOf(row);
  return holder !== null && holder.pid === me.pid && holder.start === me.start;
}

/**
 * Records what a lane needs: exactly `names`. A name it no longer needs is marked as unneeded from `now` when the lane
 * is active and was the last active lane needing it; one it needs again is no longer marked while the lane is active.
 */
export function recordLaneNeeds(
  db: DatabaseSync,
  laneId: string,
  repository: string,
  names: readonly string[],
  now: number,
): void {
  const before = new Set(
    db
      .prepare('SELECT name FROM shared_needs WHERE claim_id = ?')
      .all(laneId)
      .map(r => text(r, 'name')),
  );
  const wanted = new Set(names);
  const insert = db.prepare('INSERT OR IGNORE INTO shared_needs (claim_id, name) VALUES (?, ?)');
  for (const name of wanted) insert.run(laneId, name);
  const dropped = [...before].filter(n => !wanted.has(n));
  const remove = db.prepare('DELETE FROM shared_needs WHERE claim_id = ? AND name = ?');
  for (const name of dropped) remove.run(laneId, name);
  if (!laneActive(readPark(db, laneId))) return;
  markUnneeded(db, repository, dropped, now);
  const clear = db.prepare('UPDATE shared_services SET unneeded_since = NULL WHERE repository = ? AND name = ?');
  for (const name of wanted) clear.run(repository, name);
}

/** The shared services a lane needs and its repository, read before a transition that may end its need. */
export function laneNeeds(db: DatabaseSync, laneId: string): SharedKey[] {
  return db
    .prepare(
      'SELECT c.project_root AS repository, n.name FROM shared_needs n JOIN claims c ON c.id = n.claim_id WHERE n.claim_id = ?',
    )
    .all(laneId)
    .map(r => ({ repository: text(r, 'repository'), name: text(r, 'name') }));
}

/**
 * Marks each of `names` in `repository` as unneeded from `now` when no active lane needs it and no resource row that
 * needs it is held: the moment the last of them parked, ended or let go.
 */
export function markUnneeded(db: DatabaseSync, repository: string, names: readonly string[], now: number): void {
  const mark = db.prepare('UPDATE shared_services SET unneeded_since = ? WHERE repository = ? AND name = ?');
  for (const name of new Set(names)) {
    const key = { repository, name };
    if (activeNeeders(db, key).length > 0 || heldRows(db, key).length > 0) continue;
    mark.run(now, repository, name);
  }
}

/** `markUnneeded` for what `needs` held, once a lane has stopped being active. */
export function markNeedsUnneeded(db: DatabaseSync, needs: readonly SharedKey[], now: number): void {
  for (const need of needs) markUnneeded(db, need.repository, [need.name], now);
}

/**
 * Takes the start of a shared service for `need`, or says why not: `running` when it is recorded as running with no
 * problem (unless `foundDown`, when the caller found it not answering), `busy` while a live process starts or stops it.
 * A start or stop whose holder the snapshot proves gone is taken over. The commands recorded are `spec`, or for a
 * teardown, those of its last start. Either way it no longer counts as unneeded.
 */
export function beginStart(
  db: DatabaseSync,
  need: SharedNeed,
  name: string,
  spec: SharedCommands | null,
  foundDown: boolean,
  me: ProcessIdentity,
  holders: SharedHolders,
  now: number,
): SharedStartClaim {
  const key = { repository: need.repository, name };
  const row = readRow(db, key);
  if (need.kind === 'lane') db.prepare('INSERT OR IGNORE INTO shared_needs (claim_id, name) VALUES (?, ?)').run(need.lane, name);
  if (!row) {
    if (!spec) return { kind: 'unknown', key };
    db.prepare(
      `INSERT INTO shared_services (repository, name, state, since, start, stop, ready, cwd, timeout_ms, env, holder_pid, holder_start)
       VALUES (?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      key.repository,
      name,
      now,
      spec.start,
      spec.stop,
      spec.ready,
      spec.cwd,
      spec.timeoutMs,
      JSON.stringify(spec.env),
      me.pid,
      me.start,
    );
    return { kind: 'claimed', key, commands: spec, took: null };
  }
  db.prepare('UPDATE shared_services SET unneeded_since = NULL WHERE repository = ? AND name = ?').run(key.repository, name);
  const state = text(row, 'state') as SharedState;
  const holder = holderOf(row);
  let took: { state: SharedState; pid: number } | null = null;
  if (state === 'running' && optText(row, 'problem') === null && !foundDown) {
    return { kind: 'running', key, commands: commandsOf(row) };
  }
  if ((state === 'starting' || state === 'stopping') && holder) {
    if (!provenGone(holder, holders)) {
      return { kind: 'busy', key, state, holder, since: int(row, 'since'), timeoutMs: int(row, 'timeout_ms') };
    }
    took = { state, pid: holder.pid };
  }
  const commands = spec ?? commandsOf(row);
  db.prepare(
    `UPDATE shared_services SET state = 'starting', since = ?, start = ?, stop = ?, ready = ?, cwd = ?, timeout_ms = ?, env = ?,
       holder_pid = ?, holder_start = ? WHERE repository = ? AND name = ?`,
  ).run(
    now,
    commands.start,
    commands.stop,
    commands.ready,
    commands.cwd,
    commands.timeoutMs,
    JSON.stringify(commands.env),
    me.pid,
    me.start,
    key.repository,
    name,
  );
  return { kind: 'claimed', key, commands, took };
}

/** Records the start `me` holds as done: the shared service runs. False when `me` no longer holds it. */
export function finishStart(db: DatabaseSync, key: SharedKey, me: ProcessIdentity, now: number): boolean {
  const row = readRow(db, key);
  if (!row || text(row, 'state') !== 'starting' || !sameHolder(row, me)) return false;
  db.prepare(
    `UPDATE shared_services SET state = 'running', since = ?, holder_pid = NULL, holder_start = NULL, problem = NULL,
       attempts = 0, last_attempt_at = NULL WHERE repository = ? AND name = ?`,
  ).run(now, key.repository, key.name);
  return true;
}

/** Records the start `me` holds as failed: the shared service is stopped, with the problem. */
export function failStart(db: DatabaseSync, key: SharedKey, problem: string, me: ProcessIdentity, now: number): void {
  const row = readRow(db, key);
  if (!row || text(row, 'state') !== 'starting' || !sameHolder(row, me)) return;
  db.prepare(
    `UPDATE shared_services SET state = 'stopped', since = ?, holder_pid = NULL, holder_start = NULL, problem = ?,
       unneeded_since = NULL WHERE repository = ? AND name = ?`,
  ).run(now, problem, key.repository, key.name);
}

export interface StopWindows {
  /** A shared service unneeded at or before this moment is due to stop. */
  idleSince: number;
  /** A failed stop at or before this moment is due to be tried again. */
  retrySince: number;
}

/**
 * Takes the stop of a shared service once nothing needs it: no active lane, and no resource row held by a process the
 * snapshot doesn't prove gone. It must have been unneeded since `windows.idleSince`; one nothing needs that was never
 * marked is marked now. A start or stop whose holder the snapshot proves gone is taken over.
 */
export function beginStop(
  db: DatabaseSync,
  key: SharedKey,
  me: ProcessIdentity,
  holders: SharedHolders,
  now: number,
  windows: StopWindows,
): SharedStopClaim {
  const row = readRow(db, key);
  if (!row) return { kind: 'left', key, reason: 'it is not recorded' };
  const state = text(row, 'state') as SharedState;
  if (state === 'stopped') return { kind: 'left', key, reason: 'it is stopped' };
  const holder = holderOf(row);
  let took: { state: SharedState; pid: number } | null = null;
  if (holder) {
    if (!provenGone(holder, holders)) return { kind: 'left', key, reason: `pid ${String(holder.pid)} is ${state} it` };
    took = { state, pid: holder.pid };
  }
  const lanes = activeNeeders(db, key);
  if (lanes.length > 0) return { kind: 'left', key, reason: `lanes ${lanes.join(', ')} need it` };
  const held = heldRows(db, key).find(r => {
    const h = holderOf(r);
    return h !== null && !provenGone(h, holders);
  });
  if (held) {
    return {
      kind: 'left',
      key,
      reason: `resource ${text(held, 'name')} of lane ${text(held, 'claim_id')}, which needs it, is being created or torn down`,
    };
  }
  const lastAttempt = optInt(row, 'last_attempt_at');
  if (state === 'running' && lastAttempt !== null && lastAttempt > windows.retrySince) {
    return { kind: 'left', key, reason: 'its last stop failed lately' };
  }
  const unneededSince = optInt(row, 'unneeded_since');
  if (unneededSince === null) {
    db.prepare('UPDATE shared_services SET unneeded_since = ? WHERE repository = ? AND name = ?').run(
      now,
      key.repository,
      key.name,
    );
    return { kind: 'left', key, reason: 'nothing needs it from now' };
  }
  if (unneededSince > windows.idleSince) return { kind: 'left', key, reason: 'it was needed lately' };
  db.prepare(
    `UPDATE shared_services SET state = 'stopping', since = ?, holder_pid = ?, holder_start = ? WHERE repository = ? AND name = ?`,
  ).run(now, me.pid, me.start, key.repository, key.name);
  return { kind: 'claimed', key, commands: commandsOf(row), unneededSince, took };
}

/** Records the stop `me` holds as done. */
export function finishStop(db: DatabaseSync, key: SharedKey, me: ProcessIdentity, now: number): void {
  const row = readRow(db, key);
  if (!row || text(row, 'state') !== 'stopping' || !sameHolder(row, me)) return;
  db.prepare(
    `UPDATE shared_services SET state = 'stopped', since = ?, holder_pid = NULL, holder_start = NULL, problem = NULL,
       attempts = 0, last_attempt_at = NULL, unneeded_since = NULL WHERE repository = ? AND name = ?`,
  ).run(now, key.repository, key.name);
}

/** Records the stop `me` holds as failed: the shared service is still running, with the problem, until a later sweep's stop. */
export function failStop(db: DatabaseSync, key: SharedKey, problem: string, me: ProcessIdentity, now: number): void {
  const row = readRow(db, key);
  if (!row || text(row, 'state') !== 'stopping' || !sameHolder(row, me)) return;
  db.prepare(
    `UPDATE shared_services SET state = 'running', since = ?, holder_pid = NULL, holder_start = NULL, problem = ?,
       attempts = attempts + 1, last_attempt_at = ? WHERE repository = ? AND name = ?`,
  ).run(now, problem, now, key.repository, key.name);
}

const UNNEEDED = `NOT EXISTS (SELECT 1 FROM shared_needs n JOIN claims c ON c.id = n.claim_id
    LEFT JOIN parks p ON p.claim_id = c.id
    WHERE c.project_root = s.repository AND n.name = s.name AND ${ACTIVE_PARK})
  AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.holder_pid IS NOT NULL AND r.repository = s.repository
    AND EXISTS (SELECT 1 FROM json_each(r.needs) j WHERE j.value = s.name))`;

/**
 * The shared services the sweep may have to stop or mark, by one read: those nothing needs, unmarked or unneeded since
 * `windows.idleSince`, that are running with no stop failed after `windows.retrySince`, or that a start or stop has
 * held for longer than SHARED_HOLD_TIMEOUTS times their timeout. A held resource row counts as needing its services
 * here, since only `ps` can tell whether its holder lives.
 */
export function stopCandidates(db: DatabaseSync, now: number, windows: StopWindows): SharedKey[] {
  return db
    .prepare(
      `SELECT s.repository, s.name FROM shared_services s
       WHERE (s.unneeded_since IS NULL OR s.unneeded_since <= ?)
         AND ((s.state = 'running' AND (s.last_attempt_at IS NULL OR s.last_attempt_at <= ?))
           OR (s.state IN ('starting', 'stopping') AND s.since <= ? - ? * s.timeout_ms))
         AND ${UNNEEDED}
       ORDER BY s.repository, s.name`,
    )
    .all(windows.idleSince, windows.retrySince, now, SHARED_HOLD_TIMEOUTS)
    .map(r => ({ repository: text(r, 'repository'), name: text(r, 'name') }));
}

/** Every shared service with what needs it and when the sweep stops it. */
export function readShared(db: DatabaseSync): SharedServiceStatus[] {
  return db
    .prepare('SELECT * FROM shared_services ORDER BY repository, name')
    .all()
    .map(row => {
      const key = { repository: text(row, 'repository'), name: text(row, 'name') };
      const state = text(row, 'state') as SharedState;
      const lanes = activeNeeders(db, key);
      const holding = heldRows(db, key).map(r => ({ lane: text(r, 'claim_id'), resource: text(r, 'name') }));
      const unneededSince = optInt(row, 'unneeded_since');
      const lastAttempt = optInt(row, 'last_attempt_at');
      const idle = state === 'running' && lanes.length === 0 && holding.length === 0;
      const stopsAt =
        idle && unneededSince !== null
          ? Math.max(unneededSince + SHARED_IDLE_MS, lastAttempt === null ? 0 : lastAttempt + SHARED_STOP_RETRY_MS)
          : null;
      return {
        ...key,
        state,
        since: int(row, 'since'),
        lanes,
        holding,
        unneededSince,
        stopsAt,
        by: optInt(row, 'holder_pid'),
        problem: optText(row, 'problem'),
        attempts: int(row, 'attempts'),
        commands: commandsOf(row),
      };
    });
}
