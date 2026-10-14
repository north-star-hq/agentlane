import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envName } from '../name.ts';
import type { ProcessIdentity, ProcessInfo, ProcessTable } from '../processes.ts';
import { identityOf } from '../processes.ts';
import { UsageError } from './refusal.ts';

export type OwnerKind = 'claude' | 'codex' | 'process';

export interface Owner {
  kind: OwnerKind;
  process: ProcessIdentity | null;
  sessionId: string | null;
  threadId: string | null;
}

export const AGENTS = ['claude', 'codex', 'cursor', 'copilot', 'gemini', 'antigravity'] as const;
export type Agent = (typeof AGENTS)[number];
export type ProcessAgent = Exclude<Agent, 'claude' | 'codex'>;

interface Signature {
  markers: readonly string[];
  session: string | null;
  programs: readonly string[];
  paths: readonly string[];
  apps: readonly string[];
}

const SIGNATURES: Record<ProcessAgent, Signature> = {
  cursor: {
    markers: ['CURSOR_AGENT', 'CURSOR_CONVERSATION_ID'],
    session: 'CURSOR_CONVERSATION_ID',
    programs: ['cursor-agent'],
    paths: ['/cursor-agent/'],
    apps: ['/Cursor.app/'],
  },
  copilot: {
    markers: ['COPILOT_CLI', 'COPILOT_AGENT_SESSION_ID', 'COPILOT_RUN_APP'],
    session: 'COPILOT_AGENT_SESSION_ID',
    programs: ['copilot', 'github-copilot-cli'],
    paths: ['/@github/copilot/'],
    apps: [],
  },
  gemini: {
    markers: ['GEMINI_CLI'],
    session: 'GEMINI_SESSION_ID',
    programs: ['gemini'],
    paths: ['/@google/gemini-cli/'],
    apps: [],
  },
  antigravity: {
    markers: ['ANTIGRAVITY_AGENT', 'ANTIGRAVITY_TRAJECTORY_ID'],
    session: 'ANTIGRAVITY_TRAJECTORY_ID',
    programs: ['agy'],
    paths: [],
    apps: ['/Antigravity.app/'],
  },
};

const PROCESS_AGENTS = Object.keys(SIGNATURES) as ProcessAgent[];

function isProcessAgent(value: string): value is ProcessAgent {
  return (PROCESS_AGENTS as readonly string[]).includes(value);
}

/**
 * The agent behind an owner. Toolkit 0.1.3 throws when it releases a lane whose stored kind it doesn't know, so an
 * owner from Cursor, Copilot, Gemini or Antigravity is stored as kind `process`, with `<agent>[:<session id>]` in
 * its session column.
 */
export function agentOf(owner: Owner): Agent | null {
  if (owner.kind !== 'process') return owner.kind;
  const tag = owner.sessionId?.split(':', 1)[0] ?? '';
  return isProcessAgent(tag) ? tag : null;
}

function agentSession(owner: Owner): string | null {
  const id = owner.sessionId;
  if (id === null) return null;
  const at = id.indexOf(':');
  return at === -1 ? null : id.slice(at + 1);
}

export type ProcessVerdict = 'alive' | 'dead' | 'pid-reused' | 'cant-tell';
export type ProvenState = 'dead' | 'pid-reused' | 'worktree-gone';
export type OwnerState = 'alive' | 'cant-tell' | ProvenState;
export type WorktreeState = 'present' | 'gone' | 'unknown';

export function isProven(state: OwnerState | ProcessVerdict): state is ProvenState {
  return state === 'dead' || state === 'pid-reused' || state === 'worktree-gone';
}

export const OWNER_PID_ENV = envName('OWNER_PID');

export function ownerKey(owner: Owner): string {
  if (owner.kind === 'codex' && owner.threadId) return `codex:thread:${owner.threadId}`;
  if (!owner.process) throw new Error(`a ${owner.kind} owner needs a process or a thread id`);
  const label = owner.kind === 'process' ? (agentOf(owner) ?? 'process') : owner.kind;
  return `${label}:${String(owner.process.pid)}:${owner.process.start}`;
}

export function describeOwner(owner: Owner): string {
  const pid = owner.process ? `pid ${String(owner.process.pid)}` : null;
  const agent = agentOf(owner);
  if (owner.kind === 'process' && agent !== null) {
    const session = agentSession(owner);
    return session ? `${agent} session ${session.slice(0, 8)} (${pid ?? 'no pid'})` : `${agent} ${pid ?? 'session'}`;
  }
  switch (owner.kind) {
    case 'claude':
      return owner.sessionId
        ? `claude session ${owner.sessionId.slice(0, 8)} (${pid ?? 'no pid'})`
        : `claude ${pid ?? 'session'}`;
    case 'codex':
      if (owner.threadId) return `codex thread ${owner.threadId}${pid ? ` (${pid})` : ' (no process recorded)'}`;
      return `codex ${pid ?? 'session'}`;
    case 'process':
      return owner.process ? `process ${String(owner.process.pid)}` : 'process (unknown pid)';
  }
}

export function judgeProcess(identity: ProcessIdentity | null, table: ReadonlyMap<number, string> | undefined): ProcessVerdict {
  if (!identity || !table) return 'cant-tell';
  const start = table.get(identity.pid);
  if (start === undefined) return 'dead';
  return start === identity.start ? 'alive' : 'pid-reused';
}

export function worktreeState(dir: string): WorktreeState {
  try {
    return fs.statSync(dir).isDirectory() ? 'present' : 'gone';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown';
  }
}

export function ownerState(verdict: ProcessVerdict, worktree: WorktreeState): OwnerState {
  if (verdict === 'dead' || verdict === 'pid-reused') return verdict;
  if (worktree === 'gone') return 'worktree-gone';
  return verdict;
}

export function describeState(state: OwnerState): string {
  switch (state) {
    case 'alive':
      return 'alive';
    case 'dead':
      return 'owner dead';
    case 'pid-reused':
      return 'owner pid reused by another process';
    case 'worktree-gone':
      return 'worktree gone';
    case 'cant-tell':
      return "can't tell";
  }
}

const WRAPPERS = new Set(['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'env', 'bun', 'tsx']);

function argv(info: ProcessInfo): string[] {
  return info.command.trim().split(/\s+/);
}

function commandNames(info: ProcessInfo): string[] {
  return argv(info)
    .slice(0, 2)
    .map(token => path.basename(token).replace(/^-/, ''));
}

export function codexHome(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_HOME;
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  return path.join(env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir(), '.codex');
}

export function isCodexDaemon(info: ProcessInfo, home: string): boolean {
  const args = argv(info);
  const executable = args[0] ?? '';
  if (path.basename(executable) !== 'codex') return false;
  if (executable.startsWith(path.join(home, 'packages', 'app-server-daemon') + path.sep)) return true;
  if (!args.includes('app-server')) return false;
  const listensOnSocket = args.some(
    (arg, i) => arg.startsWith('--listen=unix://') || (arg === '--listen' && (args[i + 1] ?? '').startsWith('unix://')),
  );
  return listensOnSocket || args.includes('--managed-daemon');
}

interface SessionChain {
  ancestors: ProcessInfo[];
  underCodexDaemon: boolean;
}

function sessionAncestors(table: ProcessTable, selfPid: number, home: string): SessionChain {
  const ancestors: ProcessInfo[] = [];
  let pid = table.info(selfPid)?.ppid ?? 0;
  while (pid > 1 && ancestors.length < 32) {
    const info = table.info(pid);
    if (!info) break;
    if (isCodexDaemon(info, home)) return { ancestors, underCodexDaemon: true };
    ancestors.push(info);
    pid = info.ppid;
  }
  return { ancestors, underCodexDaemon: false };
}

const INTERPRETERS = new Set(['node', 'bun', 'deno']);

function programPaths(info: ProcessInfo): string[] {
  const args = argv(info);
  const executable = args[0] ?? '';
  if (!INTERPRETERS.has(path.basename(executable))) return [executable];
  const script = args.slice(1).find(arg => !arg.startsWith('-'));
  return script === undefined ? [executable] : [executable, script];
}

function runsProgram(info: ProcessInfo, agent: Agent): boolean {
  if (agent === 'claude' || agent === 'codex') return commandNames(info).includes(agent);
  const signature = SIGNATURES[agent];
  return programPaths(info).some(
    program =>
      signature.programs.includes(path.basename(program).replace(/^-/, '')) ||
      signature.paths.some(fragment => program.includes(fragment)),
  );
}

function insideApp(info: ProcessInfo, agent: Agent): boolean {
  return agent !== 'claude' && agent !== 'codex' && SIGNATURES[agent].apps.some(app => info.command.includes(app));
}

function present(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
}

export function agentMarker(env: NodeJS.ProcessEnv, agent: Agent): string | null {
  const names = agent === 'claude' ? ['CLAUDE_PID'] : agent === 'codex' ? ['CODEX_THREAD_ID'] : SIGNATURES[agent].markers;
  return names.find(name => present(env, name) !== null) ?? null;
}

function markedAgents(env: NodeJS.ProcessEnv): Agent[] {
  return AGENTS.filter(agent => agentMarker(env, agent) !== null);
}

interface Found {
  agent: Agent;
  info: ProcessInfo;
}

function nearestAgent(chain: readonly ProcessInfo[], env: NodeJS.ProcessEnv): Found | null {
  // Claude Code sets CLAUDE_PID for its Bash commands only. Its MCP servers inherit the value from whatever started
  // Claude Code, which names another session when one Claude Code runs inside another. Codex sets CODEX_THREAD_ID the
  // same way, and Cursor, Copilot, Gemini and Antigravity mark the shell commands they run with their own variables,
  // so with more than one agent's variable set, all but one were inherited from an outer session.
  const marked = markedAgents(env);
  const candidates = marked.length === 1 ? marked : AGENTS;
  for (const [i, info] of chain.entries()) {
    const agent = candidates.find(a => runsProgram(info, a) || (marked.includes(a) && insideApp(info, a)));
    if (agent === undefined) continue;
    if (!insideApp(info, agent)) return { agent, info };
    let app = info;
    for (const above of chain.slice(i + 1)) {
      if (!insideApp(above, agent)) break;
      app = above;
    }
    return { agent, info: app };
  }
  return null;
}

function agentOwner(agent: ProcessAgent, process: ProcessIdentity, env: NodeJS.ProcessEnv): Owner {
  const variable = SIGNATURES[agent].session;
  const session = variable === null ? null : present(env, variable);
  return { kind: 'process', process, sessionId: session === null ? agent : `${agent}:${session}`, threadId: null };
}

function liveIdentity(table: ProcessTable, raw: string, variable: string, fix: string): ProcessIdentity {
  const pid = Number(raw);
  const identity = Number.isInteger(pid) && pid > 1 ? identityOf(table, pid) : undefined;
  if (!identity) throw new UsageError(`${variable}=${raw} is not a running process`, fix);
  return identity;
}

export function resolveOwner(env: NodeJS.ProcessEnv, table: ProcessTable, selfPid: number = process.pid): Owner {
  const pinned = env[OWNER_PID_ENV];
  if (pinned) {
    const identity = liveIdentity(
      table,
      pinned,
      OWNER_PID_ENV,
      `set ${OWNER_PID_ENV} to the pid of a process that lives as long as the lane should`,
    );
    return { kind: 'process', process: identity, sessionId: null, threadId: null };
  }
  const sessionId = present(env, 'CLAUDE_CODE_SESSION_ID');
  const { ancestors: chain, underCodexDaemon } = sessionAncestors(table, selfPid, codexHome(env));
  const identity = (info: ProcessInfo): ProcessIdentity => ({ pid: info.pid, start: info.start });
  const threadId = present(env, 'CODEX_THREAD_ID');
  const claudePid = present(env, 'CLAUDE_PID');
  const nearest = nearestAgent(chain, env);
  if (nearest?.agent === 'claude') return { kind: 'claude', process: identity(nearest.info), sessionId, threadId: null };
  if (nearest?.agent === 'codex') return { kind: 'codex', process: identity(nearest.info), sessionId: null, threadId };
  if (nearest) return agentOwner(nearest.agent, identity(nearest.info), env);
  if (threadId && (underCodexDaemon || claudePid === null)) return { kind: 'codex', process: null, sessionId: null, threadId };
  if (claudePid !== null) {
    const fromEnv = liveIdentity(
      table,
      claudePid,
      'CLAUDE_PID',
      `run this from a live Claude Code session, or set ${OWNER_PID_ENV}`,
    );
    return { kind: 'claude', process: fromEnv, sessionId, threadId: null };
  }
  const shell = chain.find(info => !WRAPPERS.has(commandNames(info)[0] ?? ''));
  if (!shell) {
    throw new UsageError(
      'could not find the session or shell that owns this lane',
      `set ${OWNER_PID_ENV} to the pid of a process that lives as long as the lane should`,
    );
  }
  return { kind: 'process', process: identity(shell), sessionId: null, threadId: null };
}
