import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ONCE_WINDOW_MS = 60_000;

function claimsDir(stateDir: string): string {
  return path.join(stateDir, 'hook-once');
}

function claimedAt(file: string): number | null {
  try {
    const at = Number(fs.readFileSync(file, 'utf8'));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

function expired(file: string, now: number): boolean {
  const at = claimedAt(file);
  return at !== null && now - at > ONCE_WINDOW_MS;
}

function remove(file: string): void {
  const aside = `${file}.${String(process.pid)}.${crypto.randomBytes(4).toString('hex')}.expired`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return;
  }
  fs.rmSync(aside, { force: true });
}

function sweep(dir: string, now: number): void {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name.endsWith('.expired')) fs.rmSync(file, { force: true });
    else if (expired(file, now)) remove(file);
  }
}

export function claimOnce(stateDir: string, parts: readonly string[], now: number): boolean {
  try {
    const dir = claimsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, String(now), { flag: 'wx' });
        sweep(dir, now);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!expired(file, now)) return false;
      remove(file);
    }
    return false;
  } catch {
    return true;
  }
}
