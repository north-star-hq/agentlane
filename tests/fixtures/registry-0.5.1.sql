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
CREATE TABLE resources (
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
CREATE TABLE browsers (
  claim_id TEXT PRIMARY KEY,
  driver TEXT NOT NULL,
  session TEXT NOT NULL UNIQUE,
  worktree TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE process_alive (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  pid INTEGER NOT NULL,
  start TEXT NOT NULL,
  alive_at INTEGER NOT NULL,
  PRIMARY KEY (claim_id, service)
) STRICT;
CREATE TABLE device_leases (
  reservation TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_type TEXT NOT NULL,
  device_type_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  runtime_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  work TEXT NOT NULL,
  holder_pid INTEGER NOT NULL,
  holder_start TEXT NOT NULL,
  since INTEGER NOT NULL,
  console_port INTEGER
) STRICT;
CREATE TABLE parks (
  claim_id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  since INTEGER NOT NULL,
  parked_at INTEGER,
  holder_pid INTEGER,
  holder_start TEXT,
  attempt TEXT,
  restarts TEXT NOT NULL,
  problems TEXT NOT NULL,
  CHECK (state IN ('parking', 'parked', 'waking')),
  CHECK ((holder_pid IS NULL) = (state = 'parked') AND (holder_pid IS NULL) = (holder_start IS NULL)
    AND (holder_pid IS NULL) = (attempt IS NULL))
) STRICT;
CREATE TABLE holds (
  claim_id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  since INTEGER NOT NULL,
  until INTEGER NOT NULL,
  CHECK (until > since)
) STRICT;
CREATE TABLE owner_checks (
  claim_id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  checked_at INTEGER,
  gone TEXT,
  gone_at INTEGER,
  reaper_pid INTEGER,
  reaper_start TEXT,
  reaping_since INTEGER,
  attempt TEXT,
  CHECK (gone IS NULL OR gone IN ('dead', 'pid-reused', 'worktree-gone')),
  CHECK ((gone IS NULL) = (gone_at IS NULL)),
  CHECK ((reaper_pid IS NULL) = (reaper_start IS NULL) AND (reaper_pid IS NULL) = (reaping_since IS NULL)
    AND (reaper_pid IS NULL) = (attempt IS NULL)),
  CHECK (reaper_pid IS NULL OR gone IS NOT NULL)
) STRICT;
