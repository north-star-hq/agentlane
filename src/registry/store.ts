import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { TOOL } from '../name.ts';
import { formatTime } from './format.ts';
import { databasePath, lockHolderPath } from './paths.ts';
import { Refusal, UsageError } from './refusal.ts';

export const SCHEMA_VERSION = 1;

const FORMAT_1_ADDITIONS = `
CREATE TABLE IF NOT EXISTS resources (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL,
  name TEXT NOT NULL,
  worktree TEXT NOT NULL,
  cwd TEXT NOT NULL,
  teardown TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  env TEXT NOT NULL,
  cleared TEXT NOT NULL,
  exports TEXT,
  created_at INTEGER NOT NULL,
  holder_pid INTEGER,
  holder_start TEXT,
  holder_since INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  problem TEXT,
  UNIQUE (claim_id, name),
  CHECK ((holder_pid IS NULL) = (holder_start IS NULL) AND (holder_pid IS NULL) = (holder_since IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS browsers (
  claim_id TEXT PRIMARY KEY,
  driver TEXT NOT NULL,
  session TEXT NOT NULL UNIQUE,
  worktree TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`;
const ADDED_TABLES = ['resources', 'browsers'];

const SCHEMA = `
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_pid INTEGER,
  owner_start TEXT,
  owner_session TEXT,
  owner_thread TEXT,
  project_root TEXT NOT NULL,
  worktree TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  last_action TEXT NOT NULL,
  UNIQUE (owner_key, worktree)
) STRICT;
CREATE TABLE ports (
  port INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  service TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  UNIQUE (claim_id, service)
) STRICT;
CREATE TABLE devices (
  name TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  device_id TEXT UNIQUE,
  device_type TEXT NOT NULL,
  device_type_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  runtime_name TEXT NOT NULL,
  creator_pid INTEGER,
  creator_start TEXT,
  claim_id TEXT UNIQUE REFERENCES claims(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK ((device_id IS NULL) = (creator_pid IS NOT NULL)),
  CHECK (device_id IS NOT NULL OR claim_id IS NULL)
) STRICT;
CREATE TABLE processes (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  pid INTEGER NOT NULL,
  start TEXT NOT NULL,
  cwd TEXT,
  PRIMARY KEY (claim_id, service)
) STRICT;
CREATE TABLE queue (
  ticket INTEGER PRIMARY KEY AUTOINCREMENT,
  waiter_pid INTEGER NOT NULL,
  waiter_start TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  owner_label TEXT NOT NULL,
  worktree TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL
) STRICT;
CREATE TABLE history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  owner_label TEXT NOT NULL,
  worktree TEXT NOT NULL,
  device TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  last_action TEXT NOT NULL,
  by_owner_key TEXT NOT NULL,
  by_label TEXT NOT NULL,
  by_worktree TEXT NOT NULL,
  ended_at INTEGER NOT NULL
) STRICT;
`;

export type Row = Record<string, SQLOutputValue>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`registry column ${column} is not text`);
  return value;
}

export function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') throw new Error(`registry column ${column} is not a number`);
  return value;
}

export function optText(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

export function optInt(row: Row, column: string): number | null {
  const value = row[column];
  return typeof value === 'number' ? value : null;
}

interface LockHolder {
  pid: number;
  command: string;
  who: string;
  folder: string;
  since: number;
}

export interface Actor {
  who: string;
  folder: string;
}

function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === 5;
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4));

function pause(ms: number): void {
  Atomics.wait(pauseCell, 0, 0, ms);
}

function untilFree<T>(deadline: number, action: () => T, onTimeout: () => Error): T {
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (Date.now() >= deadline) throw onTimeout();
      pause(5 + Math.floor(Math.random() * 20));
    }
  }
}

export class Store {
  readonly db: DatabaseSync;
  readonly dir: string;
  private readonly lockWaitMs: number;
  actor: Actor = { who: 'an unidentified caller', folder: process.cwd() };

  private constructor(dir: string, db: DatabaseSync, lockWaitMs: number) {
    this.dir = dir;
    this.db = db;
    this.lockWaitMs = lockWaitMs;
  }

  static open(dir: string, lockWaitMs: number): Store {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath(dir), { timeout: Math.min(1000, lockWaitMs) });
    const store = new Store(dir, db, lockWaitMs);
    const deadline = Date.now() + lockWaitMs;
    untilFree(
      deadline,
      () => {
        db.exec('PRAGMA journal_mode = WAL');
      },
      () => store.busyRefusal(),
    );
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    if (
      untilFree(
        deadline,
        () => store.version(),
        () => store.busyRefusal(),
      ) !== SCHEMA_VERSION
    )
      store.migrate();
    const added = untilFree(
      deadline,
      () => store.hasAdditions(),
      () => store.busyRefusal(),
    );
    if (!added) {
      store.write(() => {
        store.db.exec(FORMAT_1_ADDITIONS);
      });
    }
    return store;
  }

  static openExisting(dir: string, lockWaitMs: number): Store | null {
    if (!fs.existsSync(databasePath(dir))) return null;
    return Store.open(dir, lockWaitMs);
  }

  close(): void {
    this.db.close();
  }

  private hasAdditions(): boolean {
    const found = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${ADDED_TABLES.map(() => '?').join(', ')})`,
      )
      .get(...ADDED_TABLES);
    return found !== undefined && int(found, 'n') === ADDED_TABLES.length;
  }

  private version(): number {
    const row = this.db.prepare('PRAGMA user_version').get();
    return row ? int(row, 'user_version') : 0;
  }

  private migrate(): void {
    this.write(() => {
      const version = this.version();
      if (version === SCHEMA_VERSION) return;
      if (version > SCHEMA_VERSION) {
        throw new UsageError(
          `${databasePath(this.dir)} is registry format ${String(version)}, newer than this ${TOOL} understands (${String(SCHEMA_VERSION)})`,
          `upgrade ${TOOL} to the version every project on this Mac uses`,
        );
      }
      this.db.exec(SCHEMA);
      this.db.exec(FORMAT_1_ADDITIONS);
      this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
    });
  }

  write<T>(body: () => T): T {
    untilFree(
      Date.now() + this.lockWaitMs,
      () => {
        this.db.exec('BEGIN IMMEDIATE');
      },
      () => this.busyRefusal(),
    );
    try {
      this.recordHolder();
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private recordHolder(): void {
    const holder: LockHolder = {
      pid: process.pid,
      command: [TOOL, ...process.argv.slice(2)].join(' '),
      who: this.actor.who,
      folder: this.actor.folder,
      since: Date.now(),
    };
    const file = lockHolderPath(this.dir);
    const tmp = `${file}.${String(process.pid)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(holder));
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }

  private readHolder(): LockHolder | null {
    try {
      return JSON.parse(fs.readFileSync(lockHolderPath(this.dir), 'utf8')) as LockHolder;
    } catch {
      return null;
    }
  }

  private busyRefusal(): Refusal {
    const holder = this.readHolder();
    const waited = `${String(Math.round(this.lockWaitMs / 1000))}s`;
    if (!holder) {
      return new Refusal(
        'registry-busy',
        `the registry in ${this.dir} stayed locked for ${waited}`,
        [{ who: 'a process that left no holder record', folder: this.dir, since: 'unknown' }],
        [`retry the same ${TOOL} command`, `lsof ${databasePath(this.dir)}  (shows which process has the registry open)`],
      );
    }
    return new Refusal(
      'registry-busy',
      `the registry in ${this.dir} stayed locked for ${waited}`,
      [
        {
          who: `${holder.who}, pid ${String(holder.pid)} running '${holder.command}'`,
          folder: holder.folder,
          since: formatTime(holder.since),
        },
      ],
      [
        `retry the same ${TOOL} command once pid ${String(holder.pid)} finishes`,
        `kill ${String(holder.pid)}  (only if that process is hung)`,
      ],
    );
  }
}
