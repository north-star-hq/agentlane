import fs from 'node:fs';
import path from 'node:path';

export type EvidenceTarget = 'device' | 'browser';

export function evidenceStamp(at: Date = new Date()): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export function evidenceLabel(text: string): string {
  return (
    text
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'run'
  );
}

/** A new folder in the lane's evidence folder, named by when and what: `<stamp>-<label>`, never one that exists. */
export function newEvidenceFolder(evidence: string, label: string, at: Date = new Date()): string {
  const base = path.join(evidence, `${evidenceStamp(at)}-${evidenceLabel(label)}`);
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n += 1) dir = `${base}-${String(n)}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A new file name in the lane's evidence folder, never one that exists. */
export function newEvidenceFile(evidence: string, label: string, extension: string, at: Date = new Date()): string {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const base = path.join(evidence, `${evidenceStamp(at)}-${evidenceLabel(label)}`);
  let file = `${base}.${extension}`;
  for (let n = 2; fs.existsSync(file); n += 1) file = `${base}-${String(n)}.${extension}`;
  return file;
}

/** What a recording or a trace in progress needs at its stop: kept beside the evidence, one per target. */
export interface InProgress {
  version: 1;
  target: EvidenceTarget;
  startedAt: number;
  /** The file a recording writes. */
  file?: string;
  /** The process that records, for a device recording. */
  pid?: number;
  /** What `pid` ran, so a stop never signals a process that reused it. */
  command?: string;
  platform?: 'ios' | 'android';
  device?: string;
  /** Where an emulator's recording sits on the emulator until it is pulled. */
  remote?: string;
  /** How far the driver's log and recorded steps reached when a device trace began. */
  driverLogBytes?: number;
  stepsBytes?: number;
}

function stateFile(evidence: string, kind: 'video' | 'trace', target: EvidenceTarget): string {
  return path.join(evidence, `.${kind}-${target}.json`);
}

export function readInProgress(evidence: string, kind: 'video' | 'trace', target: EvidenceTarget): InProgress | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(evidence, kind, target), 'utf8')) as Partial<InProgress>;
    return raw.version === 1 && raw.target === target && typeof raw.startedAt === 'number' ? (raw as InProgress) : null;
  } catch {
    return null;
  }
}

export function writeInProgress(evidence: string, kind: 'video' | 'trace', state: InProgress): void {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile(evidence, kind, state.target), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function clearInProgress(evidence: string, kind: 'video' | 'trace', target: EvidenceTarget): void {
  fs.rmSync(stateFile(evidence, kind, target), { force: true });
}

/** The bytes a file grew by since `from`, or all of it when it is shorter than that (it was replaced). */
export function readFrom(file: string, from: number): string {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    return '';
  }
  return data.subarray(data.length >= from ? from : 0).toString('utf8');
}

export function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Copies the files a folder holds that changed at or after `since` into `into`; returns what it copied. */
export function copyNewer(from: string, into: string, since: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(from);
  } catch {
    return [];
  }
  const copied: string[] = [];
  for (const name of names) {
    const file = path.join(from, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.mtimeMs < since) continue;
    fs.mkdirSync(into, { recursive: true, mode: 0o700 });
    const target = path.join(into, name);
    fs.copyFileSync(file, target);
    copied.push(target);
  }
  return copied;
}
