import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ONCE_WINDOW_MS = 60_000;
const KEEP_MS = 24 * 60 * 60 * 1000;
const ATTEMPTS = 5;

function claimsDir(stateDir: string): string {
  return path.join(stateDir, 'hook-once');
}

function keyOf(parts: readonly string[]): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

interface Claim {
  key: string;
  n: number;
  file: string;
}

function claims(dir: string): Claim[] {
  return fs.readdirSync(dir).flatMap(name => {
    const match = /^([0-9a-f]{32})\.(\d{1,15})$/.exec(name);
    return match?.[1] && match[2] ? [{ key: match[1], n: Number(match[2]), file: path.join(dir, name) }] : [];
  });
}

function top(all: readonly Claim[], key: string): Claim | null {
  return all.reduce<Claim | null>((best, c) => (c.key === key && (best === null || c.n > best.n) ? c : best), null);
}

function dated(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function sweep(all: readonly Claim[], mine: Claim, now: number): void {
  for (const c of all) {
    const latest = top(all, c.key);
    const old = c.key !== mine.key && latest !== null && (dated(latest.file) ?? 0) < now - KEEP_MS;
    if ((c.key === mine.key && c.n < mine.n) || old) fs.rmSync(c.file, { force: true });
  }
}

/**
 * Whether this caller wins the work named by `parts`: one caller per window wins, however many race, and a claim
 * left by a caller that died counts only until the window passes. A claim that can't be written counts as won.
 */
export function claimOnce(stateDir: string, parts: readonly string[], now: number): boolean {
  try {
    const dir = claimsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const key = keyOf(parts);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const last = top(claims(dir), key);
      if (last !== null) {
        const at = dated(last.file);
        if (at === null) continue;
        if (now - at <= ONCE_WINDOW_MS) return false;
      }
      const n = (last?.n ?? -1) + 1;
      const mine = { key, n, file: path.join(dir, `${key}.${String(n)}`) };
      try {
        fs.writeFileSync(mine.file, '', { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      fs.utimesSync(mine.file, now / 1000, now / 1000);
      const all = claims(dir);
      if ((top(all, key)?.n ?? n) > n) return false;
      sweep(all, mine, now);
      return true;
    }
    return false;
  } catch {
    return true;
  }
}
