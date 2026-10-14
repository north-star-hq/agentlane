import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import type { BrowserPaths } from './paths.ts';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  args: string;
}

/** The process table as the sweep reads it, and the signals it sends. */
export interface BrowserProcessSystem {
  list(): ProcessEntry[] | undefined;
  /** The process's environment, where the OS shows it to its owner; undefined when it can't be read. */
  environment(pid: number): string | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export interface BrowserMarks {
  session: string;
  paths: BrowserPaths;
}

const SEARCH_PATH = `${process.env.PATH ?? ''}:/usr/bin:/bin`;

function readEnviron(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${String(pid)}/environ`, 'utf8').replaceAll('\0', ' ');
    } catch {
      return undefined;
    }
  }
  const result = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { PATH: SEARCH_PATH, LC_ALL: 'C' },
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout : undefined;
}

export const realBrowserProcesses: BrowserProcessSystem = {
  list() {
    const result = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,args='], {
      encoding: 'utf8',
      env: { PATH: SEARCH_PATH, LC_ALL: 'C' },
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) return undefined;
    const entries: ProcessEntry[] = [];
    for (const line of result.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
      if (m) entries.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] ?? '' });
    }
    return entries;
  },
  environment: readEnviron,
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  },
};

/** Whether a command line starts a browser on this profile: the flag with exactly this folder, not one that extends it. */
export function onProfile(args: string, profile: string): boolean {
  const flag = `--user-data-dir=${profile}`;
  for (let at = args.indexOf(flag); at !== -1; at = args.indexOf(flag, at + 1)) {
    const next = args[at + flag.length];
    if (next === undefined || next === ' ') return true;
  }
  return false;
}

function words(args: string): string[] {
  return args.split(/\s+/);
}

function isPlaywrightDaemon(entry: ProcessEntry, session: string): boolean {
  const parts = words(entry.args);
  const at = parts.findIndex(p => p.endsWith(`${path.sep}cliDaemon.js`));
  return at !== -1 && parts[at + 1] === session;
}

function isAgentBrowser(entry: ProcessEntry): boolean {
  return /(^|\/)agent-browser(-[a-z0-9-]+)?(\s|$)/.test(entry.args);
}

function readPid(file: string): number {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return 0;
  }
}

function ancestorsOf(pid: number, byPid: ReadonlyMap<number, ProcessEntry>): Set<number> {
  const seen = new Set<number>();
  let at = byPid.get(pid);
  while (at && !seen.has(at.pid)) {
    seen.add(at.pid);
    at = byPid.get(at.ppid);
  }
  return seen;
}

/**
 * The processes of one lane's browser, read from the process table: the browser on the lane's profile, the driver
 * daemon of the lane's session (playwright-cli's by its arguments, agent-browser's by its pid file and environment),
 * and every process below them. The caller and its ancestors are never among them.
 */
export function browserProcesses(
  system: BrowserProcessSystem,
  marks: BrowserMarks,
  self = process.pid,
): ProcessEntry[] | undefined {
  const table = system.list();
  if (!table) return undefined;
  const byPid = new Map(table.map(e => [e.pid, e]));
  const spared = ancestorsOf(self, byPid);
  const seeds = new Set<number>();
  for (const entry of table) {
    if (onProfile(entry.args, marks.paths.profile)) {
      seeds.add(entry.pid);
      const parent = byPid.get(entry.ppid);
      if (parent && (isPlaywrightDaemon(parent, marks.session) || isAgentBrowser(parent))) seeds.add(parent.pid);
    }
    if (isPlaywrightDaemon(entry, marks.session)) seeds.add(entry.pid);
  }
  const recorded = byPid.get(readPid(path.join(marks.paths.agentBrowserSockets, `${marks.session}.pid`)));
  if (recorded && isAgentBrowser(recorded)) seeds.add(recorded.pid);
  for (const entry of table) {
    if (!isAgentBrowser(entry) || seeds.has(entry.pid)) continue;
    const environment = system.environment(entry.pid);
    if (
      environment?.includes(`AGENT_BROWSER_SESSION=${marks.session}`) &&
      environment.includes(marks.paths.agentBrowserSockets)
    ) {
      seeds.add(entry.pid);
    }
  }
  const found = new Set<number>();
  const visit = (pid: number) => {
    if (found.has(pid) || spared.has(pid)) return;
    found.add(pid);
    for (const child of table) if (child.ppid === pid) visit(child.pid);
  };
  for (const pid of seeds) visit(pid);
  return table.filter(e => found.has(e.pid));
}

export interface BrowserStop {
  stopped: ProcessEntry[];
  /** Processes still running after SIGKILL, or every one when the process table couldn't be read. */
  left: ProcessEntry[] | undefined;
}

/** Stops every process of the lane's browser: SIGTERM, a grace period, then SIGKILL, and reads the table back. */
export async function stopBrowserProcesses(
  system: BrowserProcessSystem,
  marks: BrowserMarks,
  clock: Clock,
  graceMs = 3000,
): Promise<BrowserStop> {
  const first = browserProcesses(system, marks);
  if (first === undefined) return { stopped: [], left: undefined };
  if (first.length === 0) return { stopped: [], left: [] };
  for (const entry of first) system.signal(entry.pid, 'SIGTERM');
  const deadline = clock.now() + graceMs;
  let now = browserProcesses(system, marks) ?? first;
  while (now.length > 0 && clock.now() < deadline) {
    await clock.sleep(100);
    now = browserProcesses(system, marks) ?? now;
  }
  for (const entry of now) system.signal(entry.pid, 'SIGKILL');
  if (now.length > 0) {
    const until = clock.now() + 2000;
    while (now.length > 0 && clock.now() < until) {
      await clock.sleep(100);
      now = browserProcesses(system, marks) ?? now;
    }
  }
  const left = new Set(now.map(e => e.pid));
  return { stopped: first.filter(e => !left.has(e.pid)), left: now };
}

export function describeProcesses(entries: readonly ProcessEntry[]): string {
  return entries.map(e => `pid ${String(e.pid)} (${e.args.slice(0, 80)})`).join(', ');
}
