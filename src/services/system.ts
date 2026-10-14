import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessTable } from '../processes.ts';
import { systemProcesses } from '../processes.ts';

export interface Descendant {
  pid: number;
  pgid: number;
}

export interface ServiceSystem {
  readonly processes: ProcessTable;
  spawnGroup(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; log: string }): number;
  listeners(port: number): number[] | undefined;
  groups(pids: readonly number[]): ReadonlyMap<number, number> | undefined;
  groupMembers(pgid: number): number[] | undefined;
  /** The live processes below `pid` in the process tree, in any process group. */
  descendants(pid: number): Descendant[] | undefined;
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean;
  signal(pid: number, signal: NodeJS.Signals): boolean;
}

const SEARCH_PATH = `${process.env.PATH ?? ''}:/usr/sbin:/usr/bin:/bin:/sbin`;

function run(command: string, args: string[]): { status: number | null; stdout: string; missing: boolean } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: SEARCH_PATH, LC_ALL: 'C' },
    timeout: 10_000,
  });
  const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { status: result.error ? null : result.status, stdout: result.stdout, missing };
}

function lsofListeners(port: number): number[] | undefined | 'missing' {
  const result = run('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fp']);
  if (result.missing) return 'missing';
  if (result.status === 1 && result.stdout.trim() === '') return [];
  if (result.status !== 0) return undefined;
  return [
    ...new Set(
      result.stdout
        .split('\n')
        .filter(line => /^p\d+$/.test(line))
        .map(line => Number(line.slice(1))),
    ),
  ];
}

const TCP_LISTEN = '0A';

/**
 * The pids listening on a TCP port, read from procfs: the port's listening sockets in net/tcp and net/tcp6, then the
 * processes holding them open. Undefined when a socket listens and no readable process holds it.
 */
export function procListeners(port: number, proc = '/proc'): number[] | undefined {
  const inodes = new Set<string>();
  for (const table of ['tcp', 'tcp6']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(proc, 'net', table), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const local = fields[1]?.split(':').at(-1);
      if (local === undefined || fields[3] !== TCP_LISTEN || fields[9] === undefined) continue;
      if (Number.parseInt(local, 16) === port && fields[9] !== '0') inodes.add(fields[9]);
    }
  }
  if (inodes.size === 0) return [];
  const sockets = new Set([...inodes].map(inode => `socket:[${inode}]`));
  const pids = new Set<number>();
  for (const entry of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(path.join(proc, entry, 'fd'));
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (sockets.has(fs.readlinkSync(path.join(proc, entry, 'fd', fd)))) pids.add(Number(entry));
      } catch {
        continue;
      }
    }
  }
  return pids.size > 0 ? [...pids] : undefined;
}

function ssListeners(port: number): number[] | undefined {
  const result = run('ss', ['-Hltnp', `sport = :${String(port)}`]);
  if (result.status !== 0) return undefined;
  return [...new Set([...result.stdout.matchAll(/pid=(\d+)/g)].map(m => Number(m[1])))];
}

function deliver(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

export const realServiceSystem: ServiceSystem = {
  processes: systemProcesses,

  spawnGroup(command, options) {
    fs.mkdirSync(path.dirname(options.log), { recursive: true });
    fs.appendFileSync(options.log, `--- ${new Date().toISOString()} start: ${command}\n`);
    const fd = fs.openSync(options.log, 'a');
    try {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.on('error', () => undefined);
      child.unref();
      if (child.pid === undefined) throw new Error(`could not start '${command}' in ${options.cwd}`);
      return child.pid;
    } finally {
      fs.closeSync(fd);
    }
  },

  listeners(port) {
    const found = lsofListeners(port);
    if (found !== 'missing') return found;
    return process.platform === 'linux' ? (ssListeners(port) ?? procListeners(port)) : undefined;
  },

  groups(pids) {
    const wanted = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
    if (wanted.length === 0) return new Map();
    const result = run('ps', ['-o', 'pid=,pgid=', '-p', wanted.join(',')]);
    if (result.status !== 0 && !(result.status === 1 && result.stdout.trim() === '')) return undefined;
    const table = new Map<number, number>();
    for (const line of result.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) table.set(Number(m[1]), Number(m[2]));
    }
    return table;
  },

  groupMembers(pgid) {
    const result = run('ps', ['-A', '-o', 'pid=,pgid=,stat=']);
    if (result.status !== 0) return undefined;
    const members: number[] = [];
    for (const line of result.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (m && Number(m[2]) === pgid && !m[3]?.startsWith('Z')) members.push(Number(m[1]));
    }
    return members;
  },

  descendants(pid) {
    const result = run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=']);
    if (result.status !== 0) return undefined;
    const children = new Map<number, Descendant[]>();
    for (const line of result.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (!m || m[4]?.startsWith('Z')) continue;
      const parent = Number(m[2]);
      children.set(parent, [...(children.get(parent) ?? []), { pid: Number(m[1]), pgid: Number(m[3]) }]);
    }
    const found: Descendant[] = [];
    const seen = new Set([pid]);
    for (let queue = [pid]; queue.length > 0;) {
      const next: number[] = [];
      for (const parent of queue) {
        for (const child of children.get(parent) ?? []) {
          if (seen.has(child.pid)) continue;
          seen.add(child.pid);
          found.push(child);
          next.push(child.pid);
        }
      }
      queue = next;
    }
    return found;
  },

  signalGroup(pgid, signal) {
    return deliver(-pgid, signal);
  },

  signal(pid, signal) {
    return deliver(pid, signal);
  },
};
