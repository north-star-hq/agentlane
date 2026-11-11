import fs from 'node:fs';
import path from 'node:path';

const NEWLINE = 0x0a;
const STALE_ROTATION_MS = 30_000;

export interface LineLimit {
  maxBytes: number;
  keepBytes: number;
}

/**
 * Cuts a line-per-entry file its one writer appends to, once it outgrows `maxBytes`, to its newest whole lines within
 * `keepBytes` (the newest line alone when it is longer). The cut replaces the file by rename, so a reader sees the
 * old file or the new one, never half a line.
 */
export function keepNewestLines(file: string, limit: LineLimit): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= limit.maxBytes) return false;
  const data = fs.readFileSync(file);
  let start = data.indexOf(NEWLINE, Math.max(0, data.length - limit.keepBytes - 1)) + 1;
  if (start === 0 || start >= data.length) start = data.lastIndexOf(NEWLINE, data.length - 2) + 1;
  const aside = `${file}.cut-${String(process.pid)}`;
  fs.writeFileSync(aside, data.subarray(start), { mode: 0o600 });
  fs.renameSync(aside, file);
  return true;
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

/** Removes all but the `keep` newest `<stamp>-<project>` folders in `dir`; returns the ones removed. */
export function keepNewestBackups(dir: string, project: string, keep: number): string[] {
  const root = path.resolve(dir);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const ours = names
    .filter(name => BACKUP_STAMP.test(name) && name.replace(BACKUP_STAMP, '') === project)
    .sort()
    .reverse();
  const removed: string[] = [];
  for (const name of ours.slice(keep)) {
    const at = path.resolve(root, name);
    if (path.dirname(at) !== root) throw new Error(`refusing to remove ${at}: it is not in ${root}`);
    fs.rmSync(at, { recursive: true, force: true });
    removed.push(at);
  }
  return removed;
}
