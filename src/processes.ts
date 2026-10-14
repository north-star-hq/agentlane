import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export interface ProcessIdentity {
  pid: number;
  start: string;
}

export interface ProcessInfo extends ProcessIdentity {
  ppid: number;
  command: string;
}

export interface ProcessTable {
  startTimes(pids: readonly number[]): ReadonlyMap<number, string> | undefined;
  info(pid: number): ProcessInfo | undefined;
  cwd(pid: number): string | undefined;
}

const LSTART = String.raw`[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}`;
const START_LINE = new RegExp(String.raw`^\s*(\d+)\s+(${LSTART})\s*$`);
const INFO_LINE = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(${LSTART})\s?(.*)$`);

function normalizeStart(lstart: string): string {
  return lstart.replace(/\s+/g, ' ');
}

export function describeStart(start: string): string {
  return `${start} UTC`;
}

function ps(columns: string, pids: readonly number[]): string[] | undefined {
  const result = spawnSync('ps', ['-o', columns, '-p', pids.join(',')], {
    encoding: 'utf8',
    env: { PATH: `${process.env.PATH ?? ''}:/bin:/usr/bin`, LC_ALL: 'C', TZ: 'UTC' },
    timeout: 10_000,
  });
  if (result.error) return undefined;
  const lines = result.stdout.split('\n').filter(line => line.trim() !== '');
  if (result.status === 0) return lines;
  if (result.status === 1 && lines.length === 0 && result.stderr.trim() === '') return [];
  return undefined;
}

function lsofCwd(pid: number): string | undefined {
  const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    env: { PATH: `${process.env.PATH ?? ''}:/usr/sbin:/usr/bin`, LC_ALL: 'C' },
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return undefined;
  const line = result.stdout.split('\n').find(l => l.startsWith('n'));
  return line?.slice(1);
}

export const systemProcesses: ProcessTable = {
  startTimes(pids) {
    const wanted = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
    if (wanted.length === 0) return new Map();
    const lines = ps('pid=,lstart=', wanted);
    if (!lines) return undefined;
    const table = new Map<number, string>();
    for (const line of lines) {
      const m = START_LINE.exec(line);
      if (!m?.[1] || !m[2]) return undefined;
      table.set(Number(m[1]), normalizeStart(m[2]));
    }
    return table;
  },

  info(pid) {
    const lines = ps('pid=,ppid=,lstart=,args=', [pid]);
    const m = lines?.[0] ? INFO_LINE.exec(lines[0]) : null;
    if (!m?.[1] || !m[2] || !m[3]) return undefined;
    return { pid: Number(m[1]), ppid: Number(m[2]), start: normalizeStart(m[3]), command: m[4] ?? '' };
  },

  cwd(pid) {
    if (process.platform === 'linux') {
      try {
        return fs.readlinkSync(`/proc/${String(pid)}/cwd`);
      } catch {
        return undefined;
      }
    }
    return lsofCwd(pid);
  },
};

export function identityOf(table: ProcessTable, pid: number): ProcessIdentity | undefined {
  const start = table.startTimes([pid])?.get(pid);
  return start === undefined ? undefined : { pid, start };
}
