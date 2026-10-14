import { runCommand } from './exec.ts';

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  rssKb: number;
  command: string;
}

export function parseProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssKb: Number(match[4]),
      command: match[5] ?? '',
    });
  }
  return rows;
}

export async function processRows(): Promise<ProcessRow[]> {
  const ran = await runCommand('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,rss=,command='], {
    env: { PATH: `${process.env.PATH ?? ''}:/bin:/usr/bin`, LC_ALL: 'C' },
    timeoutMs: 10_000,
  });
  return parseProcessRows(ran.stdout);
}

export const RUNNER_EXECUTABLE = 'maestro-driver-iosUITests-Runner';

/** The XCTest runner Maestro installs on this simulator: its executable lives in the simulator's data folder. */
export function runnersOn(rows: readonly ProcessRow[], udid: string): ProcessRow[] {
  return rows.filter(row => row.command.includes(`/CoreSimulator/Devices/${udid}/`) && row.command.includes(RUNNER_EXECUTABLE));
}

export async function listeningPorts(pid: number): Promise<number[]> {
  const ran = await runCommand('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
    env: { PATH: `${process.env.PATH ?? ''}:/usr/sbin:/usr/bin`, LC_ALL: 'C' },
    timeoutMs: 10_000,
  });
  const ports = new Set<number>();
  for (const line of ran.stdout.split('\n')) {
    const port = /^n.*:(\d+)$/.exec(line)?.[1];
    if (port !== undefined) ports.add(Number(port));
  }
  return [...ports];
}
