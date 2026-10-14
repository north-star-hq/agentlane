import type { DatabaseSync } from 'node:sqlite';
import { CLI, TOOL } from '../name.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { formatTime } from './format.ts';
import { isProven, judgeProcess } from './owner.ts';
import { Refusal } from './refusal.ts';
import { names, optValues, values } from './rows.ts';
import type { Row } from './store.ts';
import { int, optInt, optText, text } from './store.ts';
import type { PendingTeardown, ResourceSpec, ResourceStart, ResourceTeardown, ResourceValues } from './types.ts';

export const TEARDOWN_RETRY_MS = 5 * 60_000;

const ORPHANED = 'NOT EXISTS (SELECT 1 FROM claims c WHERE c.id = r.claim_id)';

/** The holders of resource rows as `ps` saw them before the write lock, so a slow `ps` never runs under the lock. */
export interface Holders {
  table: ReadonlyMap<number, string> | undefined;
  seen: ReadonlySet<string>;
}

function holderKey(seq: number, pid: number, start: string): string {
  return `${String(seq)}:${String(pid)}:${start}`;
}

export function holdersBeforeLock(db: DatabaseSync, processes: ProcessTable): Holders {
  const seen = new Set<string>();
  const pids: number[] = [];
  for (const row of db.prepare('SELECT seq, holder_pid, holder_start FROM resources WHERE holder_pid IS NOT NULL').all()) {
    const pid = int(row, 'holder_pid');
    seen.add(holderKey(int(row, 'seq'), pid, text(row, 'holder_start')));
    pids.push(pid);
  }
  return { table: pids.length === 0 ? new Map() : processes.startTimes(pids), seen };
}

type Hold = 'free' | 'stale' | 'held';

function holdOf(row: Row, holders: Holders): Hold {
  const pid = optInt(row, 'holder_pid');
  const start = optText(row, 'holder_start');
  if (pid === null || start === null) return 'free';
  if (!holders.seen.has(holderKey(int(row, 'seq'), pid, start))) return 'held';
  return isProven(judgeProcess({ pid, start }, holders.table)) ? 'stale' : 'held';
}

function hold(db: DatabaseSync, seq: number, me: ProcessIdentity, now: number): void {
  db.prepare('UPDATE resources SET holder_pid = ?, holder_start = ?, holder_since = ? WHERE seq = ?').run(
    me.pid,
    me.start,
    now,
    seq,
  );
}

const MINE = 'claim_id = ? AND name = ? AND holder_pid = ? AND holder_start = ?';

function busy(row: Row, spec: ResourceSpec): Refusal {
  const pid = String(optInt(row, 'holder_pid') ?? 0);
  return new Refusal(
    'resource-busy',
    `resource ${spec.name} of lane ${text(row, 'claim_id')} is being created or torn down by pid ${pid}`,
    [
      {
        who: `pid ${pid}, another ${TOOL} run for this lane`,
        folder: text(row, 'worktree'),
        since: formatTime(optInt(row, 'holder_since') ?? int(row, 'created_at')),
      },
    ],
    [`${CLI} up   (again, once pid ${pid} has finished)`, `kill ${pid}   (only if that process is hung)`],
  );
}

export function startResource(
  db: DatabaseSync,
  lane: { id: string; worktree: string },
  spec: ResourceSpec,
  me: ProcessIdentity,
  holders: Holders,
  now: number,
): ResourceStart {
  const row = db.prepare('SELECT * FROM resources WHERE claim_id = ? AND name = ?').get(lane.id, spec.name);
  if (row) {
    const held = holdOf(row, holders);
    if (held === 'held') throw busy(row, spec);
    const exports = optValues(row, 'exports');
    if (exports !== null && held === 'free') return { kind: 'kept', exports, createdAt: int(row, 'created_at') };
    db.prepare(
      'UPDATE resources SET cwd = ?, teardown = ?, timeout_ms = ?, env = ?, cleared = ?, exports = NULL, problem = NULL WHERE seq = ?',
    ).run(spec.cwd, spec.teardown, spec.timeoutMs, JSON.stringify(spec.env), JSON.stringify(spec.cleared), int(row, 'seq'));
    hold(db, int(row, 'seq'), me, now);
    return { kind: 'create', retry: optText(row, 'problem') ?? 'its last create did not finish' };
  }
  db.prepare(
    `INSERT INTO resources (claim_id, name, worktree, cwd, teardown, timeout_ms, env, cleared, created_at,
       holder_pid, holder_start, holder_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    lane.id,
    spec.name,
    lane.worktree,
    spec.cwd,
    spec.teardown,
    spec.timeoutMs,
    JSON.stringify(spec.env),
    JSON.stringify(spec.cleared),
    now,
    me.pid,
    me.start,
    now,
  );
  return { kind: 'create', retry: null };
}

export function finishResource(db: DatabaseSync, lane: string, name: string, exports: ResourceValues, me: ProcessIdentity): void {
  db.prepare(
    `UPDATE resources SET exports = ?, problem = NULL, holder_pid = NULL, holder_start = NULL, holder_since = NULL WHERE ${MINE}`,
  ).run(JSON.stringify(exports), lane, name, me.pid, me.start);
}

export function failResource(db: DatabaseSync, lane: string, name: string, problem: string, me: ProcessIdentity): void {
  db.prepare(`UPDATE resources SET problem = ?, holder_pid = NULL, holder_start = NULL, holder_since = NULL WHERE ${MINE}`).run(
    problem,
    lane,
    name,
    me.pid,
    me.start,
  );
}

export interface TeardownChoice {
  /** Only this ended lane's resources, retried at once rather than after TEARDOWN_RETRY_MS. */
  lane?: string;
}

export function takeTeardowns(
  db: DatabaseSync,
  me: ProcessIdentity,
  holders: Holders,
  now: number,
  choice: TeardownChoice,
): ResourceTeardown[] {
  const rows =
    choice.lane === undefined
      ? db.prepare(`SELECT * FROM resources r WHERE ${ORPHANED} ORDER BY claim_id, seq DESC`).all()
      : db.prepare(`SELECT * FROM resources r WHERE ${ORPHANED} AND claim_id = ? ORDER BY seq DESC`).all(choice.lane);
  const taken: ResourceTeardown[] = [];
  for (const row of rows) {
    if (holdOf(row, holders) === 'held') continue;
    const last = optInt(row, 'last_attempt_at');
    if (choice.lane === undefined && last !== null && now - last < TEARDOWN_RETRY_MS) continue;
    hold(db, int(row, 'seq'), me, now);
    taken.push({
      lane: text(row, 'claim_id'),
      name: text(row, 'name'),
      worktree: text(row, 'worktree'),
      cwd: text(row, 'cwd'),
      teardown: text(row, 'teardown'),
      timeoutMs: int(row, 'timeout_ms'),
      env: values(row, 'env'),
      cleared: names(row, 'cleared'),
      exports: optValues(row, 'exports'),
      createdAt: int(row, 'created_at'),
      attempts: int(row, 'attempts'),
    });
  }
  return taken;
}

export function endTeardown(db: DatabaseSync, lane: string, name: string, me: ProcessIdentity): void {
  db.prepare(`DELETE FROM resources WHERE ${MINE}`).run(lane, name, me.pid, me.start);
}

export function failTeardown(
  db: DatabaseSync,
  lane: string,
  name: string,
  problem: string,
  me: ProcessIdentity,
  now: number,
): void {
  db.prepare(
    `UPDATE resources SET attempts = attempts + 1, last_attempt_at = ?, problem = ?,
       holder_pid = NULL, holder_start = NULL, holder_since = NULL WHERE ${MINE}`,
  ).run(now, problem, lane, name, me.pid, me.start);
}

export function pendingTeardowns(db: DatabaseSync): PendingTeardown[] {
  return db
    .prepare(`SELECT * FROM resources r WHERE ${ORPHANED} ORDER BY created_at, seq`)
    .all()
    .map(row => ({
      lane: text(row, 'claim_id'),
      name: text(row, 'name'),
      worktree: text(row, 'worktree'),
      createdAt: int(row, 'created_at'),
      attempts: int(row, 'attempts'),
      lastAttemptAt: optInt(row, 'last_attempt_at'),
      problem: optText(row, 'problem'),
    }));
}
