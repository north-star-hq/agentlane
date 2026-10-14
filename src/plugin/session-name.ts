import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Owner } from '../registry/owner.ts';

interface SessionRecord {
  pid?: unknown;
  name?: unknown;
  startedAt?: unknown;
  procStart?: unknown;
}

const START_TOLERANCE_MS = 2_000;

export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? os.homedir(), '.claude');
}

function sameProcess(record: SessionRecord, start: string): boolean {
  const normalized = start.replace(/\s+/g, ' ');
  if (typeof record.procStart === 'string' && record.procStart.replace(/\s+/g, ' ') === normalized) return true;
  const started = Date.parse(`${normalized} UTC`);
  return (
    typeof record.startedAt === 'number' && Number.isFinite(started) && Math.abs(record.startedAt - started) <= START_TOLERANCE_MS
  );
}

export function claudeSessionName(owner: Owner, env: NodeJS.ProcessEnv): string | null {
  if (owner.kind !== 'claude' || !owner.process) return null;
  let record: SessionRecord;
  try {
    record = JSON.parse(
      fs.readFileSync(path.join(claudeConfigDir(env), 'sessions', `${String(owner.process.pid)}.json`), 'utf8'),
    ) as SessionRecord;
  } catch {
    return null;
  }
  if (record.pid !== owner.process.pid || !sameProcess(record, owner.process.start)) return null;
  return typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : null;
}
