import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import { UsageError } from '../registry/refusal.ts';

export const DEFAULT_IDLE_MS = 30 * 60_000;
export const SETTINGS_FILE = 'driver.json';

export interface DriverSettings {
  /** How long an engine waits without a tool call before it stops Maestro and exits; 0 keeps it running. */
  idleMs: number;
}

/**
 * The driver's per-Mac settings, `<state dir>/driver.json`: `{"idleMinutes": 30}`. `idleMinutes: 0` keeps an
 * engine running for as long as its lane lasts.
 */
export function readDriverSettings(stateDir: string): DriverSettings {
  const file = path.join(stateDir, SETTINGS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { idleMs: DEFAULT_IDLE_MS };
    throw error;
  }
  const fix = 'write {"idleMinutes": 30} (the default), or {"idleMinutes": 0} to keep engines running';
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file} is not JSON: ${(error as Error).message}`, fix);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UsageError(`${file} is not a JSON object`, fix);
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'idleMinutes') throw new UsageError(`${file}: unknown setting '${key}'`, `use only idleMinutes; ${fix}`);
  }
  const minutes = record.idleMinutes;
  if (minutes === undefined) return { idleMs: DEFAULT_IDLE_MS };
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    throw new UsageError(`${file}: idleMinutes must be a number of minutes, 0 or more`, fix);
  }
  return { idleMs: Math.round(minutes * 60_000) };
}

/** Tracks an engine's tool calls, to tell when it has gone a whole idle period without one. */
export class IdleWatch {
  private readonly idleMs: number;
  private readonly clock: Pick<Clock, 'now'>;
  private last: number;
  private busy = 0;

  constructor(idleMs: number, clock: Pick<Clock, 'now'>) {
    this.idleMs = idleMs;
    this.clock = clock;
    this.last = clock.now();
  }

  begin(): void {
    this.busy += 1;
    this.last = this.clock.now();
  }

  end(): void {
    this.busy = Math.max(0, this.busy - 1);
    this.last = this.clock.now();
  }

  /** How long until the engine counts as idle; 0 when it already does, undefined when it never will. */
  remainingMs(): number | undefined {
    if (this.idleMs <= 0) return undefined;
    if (this.busy > 0) return this.idleMs;
    return Math.max(0, this.idleMs - (this.clock.now() - this.last));
  }
}

export interface IdleStop {
  version: 1;
  stoppedAt: number;
  idleMs: number;
}

export function writeIdleStop(file: string, stop: IdleStop): void {
  fs.writeFileSync(file, `${JSON.stringify(stop)}\n`, { mode: 0o600 });
}

/** Reads and removes the note an engine left when it stopped for lack of calls. */
export function takeIdleStop(file: string): IdleStop | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  fs.rmSync(file, { force: true });
  try {
    const parsed = JSON.parse(text) as Partial<IdleStop>;
    return parsed.version === 1 && typeof parsed.stoppedAt === 'number' && typeof parsed.idleMs === 'number'
      ? (parsed as IdleStop)
      : undefined;
  } catch {
    return undefined;
  }
}

export function describeIdle(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = ms / 60_000;
  return `${Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)} min`;
}
