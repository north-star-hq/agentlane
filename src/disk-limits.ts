import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NEWLINE = 0x0a;
const STALE_ROTATION_MS = 30_000;

export interface LineLimit {
  maxBytes: number;
  keepBytes: number;
}

/**
 * Cuts a line-per-entry file, once it outgrows `maxBytes`, to its newest whole lines within `keepBytes` (the newest
 * line alone when it is longer). The cut replaces the file by rename, so a reader sees the old file or the new one,
 * never half a line. A failed cut leaves the file as it was and returns false.
 */
export function keepNewestLinesAsSoleWriter(file: string, limit: LineLimit): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= limit.maxBytes) return false;
  const aside = `${file}.cut.${String(process.pid)}`;
  try {
    const data = fs.readFileSync(file);
    let start = data.indexOf(NEWLINE, Math.max(0, data.length - limit.keepBytes - 1)) + 1;
    if (start === 0 || start >= data.length) start = data.lastIndexOf(NEWLINE, data.length - 2) + 1;
    fs.writeFileSync(aside, data.subarray(start), { mode: 0o600 });
    fs.renameSync(aside, file);
    return true;
  } catch {
    fs.rmSync(aside, { force: true });
    return false;
  }
}

function takeRotation(lock: string): boolean {
  try {
    fs.closeSync(fs.openSync(lock, 'wx', 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > STALE_ROTATION_MS) fs.rmSync(lock, { force: true });
  } catch {
    return false;
  }
  return false;
}

/**
 * Moves a log that outgrew `maxBytes` to `<file>.1`, replacing the one before, so the log and its previous
 * generation hold at most about twice that. Writers that opened the log before the move keep writing into `.1`, so
 * a rotation loses only the generation it replaces; one process at a time rotates, under `<file>.rotating`.
 */
export function rotateLog(file: string, maxBytes: number): boolean {
  const over = (): boolean => {
    try {
      return fs.statSync(file).size > maxBytes;
    } catch {
      return false;
    }
  };
  if (!over()) return false;
  const lock = `${file}.rotating`;
  if (!takeRotation(lock)) return false;
  try {
    if (!over()) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

const BACKUP_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/;

/** The part of an init backup's name that says whose it is: the project folder's name and a hash of its real path. */
export function backupProject(root: string): string {
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    real = path.resolve(root);
  }
  return `${path.basename(real)}-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 8)}`;
}

/**
 * Removes all but the `keep` most recently written `<stamp>-<project>` folders in `dir`, never `written` (the one
 * just made); returns the ones removed.
 */
export function keepNewestBackups(dir: string, project: string, keep: number, written?: string): string[] {
  const root = path.resolve(dir);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const writtenAt = (name: string): number => {
    try {
      return fs.statSync(path.join(root, name)).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const ours = names
    .filter(name => BACKUP_STAMP.test(name) && name.replace(BACKUP_STAMP, '') === project)
    .map(name => ({ name, at: name === written ? Number.POSITIVE_INFINITY : writtenAt(name) }))
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const removed: string[] = [];
  for (const { name } of ours.slice(keep)) {
    if (name === written) continue;
    const at = path.resolve(root, name);
    if (path.dirname(at) !== root) throw new Error(`refusing to remove ${at}: it is not in ${root}`);
    fs.rmSync(at, { recursive: true, force: true });
    removed.push(at);
  }
  return removed;
}
