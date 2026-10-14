import fs from 'node:fs';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';

export type LockAttempt = { acquired: true } | { acquired: false; holder: ProcessIdentity | undefined };

function readHolder(file: string): ProcessIdentity | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProcessIdentity>;
    return typeof parsed.pid === 'number' && typeof parsed.start === 'string'
      ? { pid: parsed.pid, start: parsed.start }
      : undefined;
  } catch {
    return undefined;
  }
}

export function bestEffort(action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

function sameHolder(a: ProcessIdentity | undefined, b: ProcessIdentity | undefined): boolean {
  if (!a || !b) return false;
  return a.pid === b.pid && a.start === b.start;
}

function create(file: string, me: ProcessIdentity): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify(me));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Takes a lock file holding the taker's pid and start time. A lock whose holder is proven gone (no such pid, or the
 * pid now belongs to a process with another start time) is broken; a live holder, or one ps can't judge, keeps it.
 */
export function tryLock(file: string, me: ProcessIdentity, table: ProcessTable): LockAttempt {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (create(file, me)) return { acquired: true };
    const holder = readHolder(file);
    if (!holder) {
      if (!fs.existsSync(file)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      if (attempt < 20) continue;
      return { acquired: false, holder: undefined };
    }
    if (sameHolder(holder, me)) return { acquired: true };
    const starts = table.startTimes([holder.pid]);
    if (!starts) return { acquired: false, holder };
    if (starts.get(holder.pid) === holder.start) return { acquired: false, holder };
    const aside = `${file}.stale.${String(me.pid)}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      continue;
    }
    if (!sameHolder(readHolder(aside), holder)) {
      bestEffort(() => {
        fs.linkSync(aside, file);
      });
    }
    fs.rmSync(aside, { force: true });
  }
  return { acquired: false, holder: readHolder(file) };
}

export function unlock(file: string, me: ProcessIdentity): void {
  if (sameHolder(readHolder(file), me)) fs.rmSync(file, { force: true });
}

export function lockHolder(file: string): ProcessIdentity | undefined {
  return readHolder(file);
}

/** The lock's holder while it lives; a holder ps can't judge counts as living. */
export function liveHolder(file: string, table: ProcessTable): ProcessIdentity | undefined {
  const holder = readHolder(file);
  if (!holder) return undefined;
  const starts = table.startTimes([holder.pid]);
  if (starts && starts.get(holder.pid) !== holder.start) return undefined;
  return holder;
}
