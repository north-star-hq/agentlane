import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import { tail } from '../hooks/run.ts';
import { CLI } from '../name.ts';
import type { ReadyCheck, ServiceConfig } from '../project/config.ts';
import type { ServiceProcess } from '../registry/types.ts';
import type { ServiceSystem } from './system.ts';
import { describeStart, startMs, type ProcessIdentity } from '../processes.ts';

export type LeaderState = 'alive' | 'gone' | 'pid-reused' | 'moved' | 'cant-tell';

type LeaderCheck = { state: Exclude<LeaderState, 'cant-tell'> } | { state: 'cant-tell'; unread: string };

export interface Listener {
  pid: number;
  ours: boolean;
  command: string;
}

export interface ServiceInspection {
  service: string;
  port: number;
  process: ServiceProcess | null;
  leader: LeaderState | 'not-started';
  leaderDetail: string;
  listeners: Listener[] | null;
  ready: boolean;
  readyDetail: string;
  healthy: boolean;
}

export interface Killed {
  group: boolean;
  pids: number[];
}

export type StopOutcome =
  | { kind: 'stopped'; signal: 'SIGTERM' }
  | { kind: 'stopped'; signal: 'SIGKILL'; killed: Killed }
  | { kind: 'already-gone' }
  | { kind: 'not-ours'; reason: string }
  | { kind: 'cant-tell'; reason: string; sent?: 'SIGTERM' }
  | { kind: 'cant-tell'; reason: string; sent: 'SIGKILL'; killed: Killed }
  | { kind: 'survived'; members: number[]; unproven?: number[] };

export class ServiceFailed extends Error {
  readonly service: string;

  constructor(service: string, problem: string, log: string | null) {
    super(`service ${service} ${problem}${log ? `\n${tail(log, 20)}\nfull log: ${log}` : ''}`);
    this.name = 'ServiceFailed';
    this.service = service;
  }
}

const PROBE_TIMEOUT_MS = 2000;

function checkLeader(system: ServiceSystem, proc: ServiceProcess): LeaderCheck {
  const starts = system.running([proc.pid]);
  if (!starts) return { state: 'cant-tell', unread: 'ps could not read when it started' };
  const start = starts.get(proc.pid);
  if (start === undefined) return { state: 'gone' };
  if (start !== proc.start) return { state: 'pid-reused' };
  if (proc.cwd === null) return { state: 'alive' };
  const cwd = system.processes.cwd(proc.pid);
  if (cwd === undefined) return { state: 'cant-tell', unread: 'its working directory could not be read' };
  return { state: cwd === proc.cwd ? 'alive' : 'moved' };
}

export function judgeLeader(system: ServiceSystem, proc: ServiceProcess): LeaderState {
  return checkLeader(system, proc).state;
}

function describeLeader(check: LeaderCheck, proc: ServiceProcess): string {
  switch (check.state) {
    case 'alive':
      return `pid ${String(proc.pid)} is running`;
    case 'gone':
      return `pid ${String(proc.pid)} has exited`;
    case 'pid-reused':
      return `pid ${String(proc.pid)} now belongs to another process (its start time is not ${describeStart(proc.start)})`;
    case 'moved':
      return `pid ${String(proc.pid)} is no longer in ${proc.cwd ?? '(unknown)'}`;
    case 'cant-tell':
      return `pid ${String(proc.pid)} could not be checked: ${check.unread}`;
  }
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

export async function probeReady(check: ReadyCheck, port: number): Promise<{ ready: boolean; detail: string }> {
  const where = `${check.host}:${String(port)}`;
  if (check.kind === 'tcp') {
    const ok = await connects(check.host, port);
    return { ready: ok, detail: ok ? `accepts TCP on ${where}` : `nothing accepts TCP on ${where}` };
  }
  const url = `http://${check.host.includes(':') ? `[${check.host}]` : check.host}:${String(port)}${check.path}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await response.text();
    if (response.status !== check.status)
      return { ready: false, detail: `GET ${url} returned ${String(response.status)}, not ${String(check.status)}` };
    if (check.body !== null && !body.includes(check.body)) {
      return { ready: false, detail: `GET ${url} returned ${String(response.status)} without '${check.body}'` };
    }
    return { ready: true, detail: `GET ${url} returned ${String(response.status)}${check.body ? ` with '${check.body}'` : ''}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
    return { ready: false, detail: `GET ${url} failed (${cause})` };
  }
}

/**
 * Who listens on the port, and whether each is the service's own: in the process group the toolkit started for it, or
 * below its leader in the process tree in a group of its own, where `pnpm exec` starts the command it runs.
 */
export function listenersOn(system: ServiceSystem, port: number, leaderPid: number | null): Listener[] | null {
  const pids = system.listeners(port);
  if (pids === undefined) return null;
  const groups = system.groups(pids);
  if (groups === undefined) return null;
  const inGroup = (pid: number) => leaderPid !== null && groups.get(pid) === leaderPid;
  const below =
    leaderPid !== null && pids.some(pid => !inGroup(pid))
      ? new Set((system.descendants(leaderPid) ?? []).map(d => d.pid))
      : new Set<number>();
  return pids.map(pid => ({
    pid,
    ours: inGroup(pid) || below.has(pid),
    command: system.processes.info(pid)?.command ?? '(unknown)',
  }));
}

export interface ListenerFolder {
  pid: number;
  /** The listener's working directory; null when it can't be read. */
  cwd: string | null;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function real(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The listeners whose working directory is outside the worktree: they serve another folder's code. */
export function listenersElsewhere(system: ServiceSystem, listeners: readonly Listener[], worktree: string): ListenerFolder[] {
  const root = real(worktree);
  const elsewhere: ListenerFolder[] = [];
  for (const listener of listeners) {
    const cwd = system.processes.cwd(listener.pid);
    if (cwd === undefined) continue;
    if (!inside(real(cwd), root)) elsewhere.push({ pid: listener.pid, cwd });
  }
  return elsewhere;
}

export function describeListeners(listeners: readonly Listener[]): string {
  return listeners.map(l => `pid ${String(l.pid)} (${l.command.slice(0, 80)})`).join(', ');
}

export async function inspectService(
  system: ServiceSystem,
  service: ServiceConfig,
  port: number,
  proc: ServiceProcess | null,
): Promise<ServiceInspection> {
  const check = proc ? checkLeader(system, proc) : null;
  const leader = check?.state ?? 'not-started';
  const listeners = listenersOn(system, port, leader === 'alive' && proc ? proc.pid : null);
  const probe = await probeReady(service.ready, port);
  const ours = listeners !== null && listeners.length > 0 && listeners.every(l => l.ours);
  return {
    service: service.name,
    port,
    process: proc,
    leader,
    leaderDetail: proc && check ? describeLeader(check, proc) : 'not started by the toolkit',
    listeners,
    ready: probe.ready,
    readyDetail: probe.detail,
    healthy: leader === 'alive' && ours && probe.ready,
  };
}

export function explainInspection(inspection: ServiceInspection): string {
  const parts = [inspection.leaderDetail];
  if (inspection.listeners === null) parts.push(`the listener on ${String(inspection.port)} could not be read`);
  else if (inspection.listeners.length === 0) parts.push(`nothing listens on ${String(inspection.port)}`);
  else {
    const foreign = inspection.listeners.filter(l => !l.ours);
    if (foreign.length > 0)
      parts.push(`${String(inspection.port)} is held by a process the toolkit did not start: ${describeListeners(foreign)}`);
    else parts.push(`listening on ${String(inspection.port)}`);
  }
  parts.push(inspection.readyDetail);
  return parts.join('; ');
}

export function startService(system: ServiceSystem, service: ServiceConfig, env: NodeJS.ProcessEnv, log: string): ServiceProcess {
  const pid = system.spawnGroup(service.start, { cwd: service.cwd, env, log });
  const start = system.processes.startTimes([pid])?.get(pid);
  if (start === undefined) throw new ServiceFailed(service.name, `exited at once (pid ${String(pid)})`, log);
  return { service: service.name, pid, start, cwd: null };
}

export async function waitForService(
  system: ServiceSystem,
  service: ServiceConfig,
  port: number,
  proc: ServiceProcess,
  clock: Clock,
  log: string,
  pollMs = 250,
): Promise<ServiceProcess> {
  const deadline = clock.now() + service.timeoutMs;
  for (;;) {
    const checkedAt = clock.now();
    const leader = judgeLeader(system, proc);
    if (leader === 'gone' || leader === 'pid-reused')
      throw new ServiceFailed(service.name, `exited before it was ready (pid ${String(proc.pid)})`, log);
    const listeners = listenersOn(system, port, proc.pid);
    const foreign = listeners?.filter(l => !l.ours) ?? [];
    if (foreign.length > 0) {
      throw new ServiceFailed(
        service.name,
        `can't be checked: ${String(port)} is also held by a process the toolkit did not start: ${describeListeners(foreign)}. Stop it, or run ${CLI} release and ${CLI} up again for a fresh port`,
        log,
      );
    }
    const probe = await probeReady(service.ready, port);
    if (probe.ready && listeners !== null && listeners.length > 0) {
      const cwd = system.processes.cwd(proc.pid);
      return { ...proc, cwd: cwd ?? null, ...(leader === 'alive' ? { aliveAt: checkedAt } : {}) };
    }
    if (clock.now() >= deadline) {
      throw new ServiceFailed(service.name, `was not ready after ${String(service.timeoutMs / 1000)} s: ${probe.detail}`, log);
    }
    await clock.sleep(pollMs);
  }
}

/**
 * The moment just before a check that found the leader's pid running with its recorded start time, or undefined when
 * the check didn't find it. Store it with `Registry.recordLeaderAlive` so `stopService` can later prove the group.
 */
export function leaderAliveAt(system: ServiceSystem, proc: ServiceProcess, clock: Clock): number | undefined {
  const at = clock.now();
  return judgeLeader(system, { ...proc, cwd: null }) === 'alive' ? at : undefined;
}

export async function stopService(
  system: ServiceSystem,
  proc: ServiceProcess,
  clock: Clock,
  graceMs = 5000,
  pollMs = 100,
): Promise<StopOutcome> {
  const leader = checkLeader(system, proc);
  if (leader.state === 'pid-reused' || leader.state === 'moved')
    return { kind: 'not-ours', reason: describeLeader(leader, proc) };
  if (leader.state === 'cant-tell') return { kind: 'cant-tell', reason: describeLeader(leader, proc) };
  let group: ProcessIdentity[];
  if (leader.state === 'gone') {
    const members = system.groupMembers(proc.pid);
    if (members === undefined) return { kind: 'cant-tell', reason: 'ps could not list the process group' };
    if (members.length === 0) return { kind: 'already-gone' };
    const found = withStarts(system, members);
    if (found === undefined)
      return { kind: 'cant-tell', reason: `ps could not read when processes ${members.join(', ')} started` };
    if (!found.some(member => inOriginalGroup(proc, member.start))) {
      return {
        kind: 'cant-tell',
        reason: `its leader pid ${String(proc.pid)} exited and none of processes ${members.join(', ')} left in its group started with it or before it was last seen running, so they can't be proven ours; stop them with kill ${members.join(' ')}`,
      };
    }
    group = found;
  } else {
    const members = system.groupMembers(proc.pid);
    const found = members === undefined ? [] : (withStarts(system, members) ?? []);
    group = [{ pid: proc.pid, start: proc.start }, ...found.filter(member => member.pid !== proc.pid)];
  }
  const strays = outsideGroup(system, proc.pid, leader.state === 'gone' ? group.map(member => member.pid) : [proc.pid]);
  const proven = [...group, ...strays.proven];
  const provenPids = proven.map(p => p.pid);
  const left = (processes: readonly ProcessIdentity[]): number[] | undefined => {
    const starts = system.running(processes.map(p => p.pid));
    return starts === undefined ? undefined : processes.filter(p => starts.get(p.pid) === p.start).map(p => p.pid);
  };
  const seen = { groupEveryPoll: true, lastOurs: provenPids, lastInGroup: [] as number[] };
  const poll = (): StopPoll => {
    const provenLeft = left(proven);
    const inGroup = system.groupMembers(proc.pid);
    if (provenLeft) seen.lastOurs = provenLeft;
    if (inGroup !== undefined) seen.lastInGroup = inGroup;
    if (inGroup === undefined || inGroup.length === 0) seen.groupEveryPoll = false;
    if (provenLeft === undefined || inGroup === undefined) {
      return { kind: 'unread', starts: provenLeft === undefined, group: inGroup === undefined };
    }
    if (seen.groupEveryPoll) {
      return { kind: 'listed', inGroup, ours: [...inGroup, ...provenLeft.filter(pid => !inGroup.includes(pid))], unproven: [] };
    }
    return { kind: 'listed', inGroup, ours: provenLeft, unproven: inGroup.filter(pid => !provenLeft.includes(pid)) };
  };
  const settled = (p: StopPoll) => p.kind === 'listed' && p.ours.length === 0;
  const waitSettled = async (ms: number): Promise<StopPoll> => {
    const until = clock.now() + ms;
    for (;;) {
      const now = poll();
      if (settled(now) || clock.now() >= until) return now;
      await clock.sleep(pollMs);
    }
  };
  const killed = { group: false, pids: new Set<number>(), unread: false };
  const sigkill = (): Killed | undefined =>
    killed.group || killed.pids.size > 0 ? { group: killed.group, pids: [...killed.pids] } : undefined;
  const cantTell = (reasons: readonly string[]): StopOutcome => {
    const reason = reasons.join('; ');
    const kill = sigkill();
    return kill ? { kind: 'cant-tell', sent: 'SIGKILL', killed: kill, reason } : { kind: 'cant-tell', sent: 'SIGTERM', reason };
  };
  const outcome = (p: StopPoll): StopOutcome => {
    if (p.kind === 'unread') {
      const failed = [
        ...(p.starts ? [`read when processes ${provenPids.join(', ')} started`] : []),
        ...(p.group ? [`list process group ${String(proc.pid)}`] : []),
      ].join(', nor ');
      const pids = [...new Set([...seen.lastOurs, ...seen.lastInGroup])].join(' ');
      return cantTell([
        pids === ''
          ? `ps could not ${failed}, so it can't be proven stopped`
          : `ps could not ${failed}, so processes ${pids} can't be proven stopped; stop them with kill ${pids}`,
        ...strays.unread,
      ]);
    }
    const sentKill = (pid: number) => killed.pids.has(pid) || (killed.group && p.inGroup.includes(pid));
    const survivors = p.ours.filter(sentKill);
    const unkilled = p.ours.filter(pid => !sentKill(pid));
    if (unkilled.length === 0 && strays.unread.length === 0 && survivors.length > 0) {
      return { kind: 'survived', members: survivors, ...(p.unproven.length > 0 ? { unproven: p.unproven } : {}) };
    }
    const why = killed.unread ? ': ps could not read when they started, so they were' : ' and were';
    const reasons = [
      ...(unkilled.length > 0
        ? [`processes ${unkilled.join(', ')} remain${why} not sent SIGKILL; stop them with kill ${unkilled.join(' ')}`]
        : []),
      ...(survivors.length > 0 ? [`processes ${survivors.join(', ')} survived SIGKILL`] : []),
      ...(p.unproven.length > 0 ? [unprovenLeft(proc.pid, p.unproven)] : []),
      ...strays.unread,
    ];
    if (reasons.length > 0) return cantTell(reasons);
    const kill = sigkill();
    return kill ? { kind: 'stopped', signal: 'SIGKILL', killed: kill } : { kind: 'stopped', signal: 'SIGTERM' };
  };
  system.signalGroup(proc.pid, 'SIGTERM');
  for (const stray of strays.proven) system.signal(stray.pid, 'SIGTERM');
  const grace = await waitSettled(graceMs);
  if (settled(grace)) return outcome(grace);
  // A pid can't name a new process group while a group of that id lives (XBD 4.14), but polls only sample the group:
  // one listed with processes in it at every poll since SIGTERM may have emptied and been made anew between two polls
  // or since the last one. That window is bounded by one poll interval, not ruled out.
  if (seen.groupEveryPoll) killed.group = system.signalGroup(proc.pid, 'SIGKILL');
  const alive = left(proven);
  killed.unread = alive === undefined;
  for (const pid of alive ?? []) if (system.signal(pid, 'SIGKILL')) killed.pids.add(pid);
  return outcome(await waitSettled(2000));
}

type StopPoll =
  { kind: 'listed'; inGroup: number[]; ours: number[]; unproven: number[] } | { kind: 'unread'; starts: boolean; group: boolean };

function unprovenLeft(pgid: number, pids: readonly number[]): string {
  return `processes ${pids.join(', ')} in a process group of id ${String(pgid)} can't be proven ours; stop them with kill ${pids.join(' ')}`;
}

function withStarts(system: ServiceSystem, pids: readonly number[]): ProcessIdentity[] | undefined {
  const starts = system.running(pids);
  if (!starts) return undefined;
  return pids.flatMap(pid => {
    const start = starts.get(pid);
    return start === undefined ? [] : [{ pid, start }];
  });
}

const STARTED_WITH_LEADER_MS = 1000;
const START_RESOLUTION_MS = 1000;

/**
 * Whether a process left in the group after its leader exited proves the group is still the one the leader started.
 * POSIX keeps a pid from naming a new process while a process group of that id lives (XBD 4.14 Process ID Reuse;
 * XNU's forkproc skips such pids), so a later group of that id is made after the original group is gone, a full cycle
 * of the pid space later. A process started in the leader's second or the next is older than such a group could be,
 * and so is one started before a moment the leader was seen running, when the original group still held the id.
 */
function inOriginalGroup(proc: ServiceProcess, start: string): boolean {
  const member = startMs(start);
  const after = member - startMs(proc.start);
  if (Number.isNaN(after) || after < 0) return false;
  if (after <= STARTED_WITH_LEADER_MS) return true;
  return proc.aliveAt !== undefined && member + START_RESOLUTION_MS <= proc.aliveAt;
}

function retryOnce<T>(read: () => T | undefined): T | undefined {
  return read() ?? read();
}

/** The service's processes that left its process group, found while a process of the group still ties them to it. */
function outsideGroup(
  system: ServiceSystem,
  pgid: number,
  roots: readonly number[],
): { proven: ProcessIdentity[]; unread: string[] } {
  const below = new Map<number, number>();
  const unlisted: number[] = [];
  for (const root of roots) {
    if (below.has(root)) continue;
    const descendants = retryOnce(() => system.descendants(root));
    if (descendants === undefined) unlisted.push(root);
    for (const d of descendants ?? []) below.set(d.pid, d.pgid);
  }
  const pids = [...below].filter(([, group]) => group !== pgid).map(([pid]) => pid);
  const proven = pids.length === 0 ? [] : retryOnce(() => withStarts(system, pids));
  return {
    proven: proven ?? [],
    unread: [
      ...(unlisted.length > 0
        ? [
            `ps could not list the processes below ${unlisted.length === 1 ? 'pid' : 'pids'} ${unlisted.join(', ')}, so any of them outside process group ${String(pgid)} were not found and were sent nothing`,
          ]
        : []),
      ...(proven === undefined
        ? [
            `ps could not read when processes ${pids.join(', ')} started, so they were sent nothing; stop them with kill ${pids.join(' ')}`,
          ]
        : []),
    ],
  };
}

function describeKilled(pgid: number, killed: Killed): string {
  return [
    ...(killed.group ? [`process group ${String(pgid)}`] : []),
    ...(killed.pids.length > 0 ? [`processes ${killed.pids.join(', ')}`] : []),
  ].join(' and ');
}

export function describeStop(proc: ServiceProcess, outcome: StopOutcome): string {
  const who = `${proc.service} (pid ${String(proc.pid)}, started ${describeStart(proc.start)})`;
  switch (outcome.kind) {
    case 'stopped':
      if (outcome.signal === 'SIGTERM') return `stopped ${who}`;
      return `stopped ${who} with SIGKILL to ${describeKilled(proc.pid, outcome.killed)}, which SIGTERM did not end`;
    case 'already-gone':
      return `${who} had already exited`;
    case 'not-ours':
      return `left ${who} alone: ${outcome.reason}`;
    case 'cant-tell':
      if (outcome.sent === 'SIGKILL') {
        return `sent SIGTERM to ${who}, then SIGKILL to ${describeKilled(proc.pid, outcome.killed)}, but ${outcome.reason}`;
      }
      if (outcome.sent === 'SIGTERM') return `sent SIGTERM to ${who}, but ${outcome.reason}`;
      return `left ${who} alone: ${outcome.reason}`;
    case 'survived':
      return `${who} survived SIGKILL: processes ${outcome.members.join(', ')} remain${outcome.unproven ? `; ${unprovenLeft(proc.pid, outcome.unproven)}` : ''}`;
  }
}
