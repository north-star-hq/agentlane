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
