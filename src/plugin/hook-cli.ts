import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '../clock.ts';
import { envName, TOOL } from '../name.ts';
import type { Agent, Owner } from '../registry/owner.ts';
import { AGENTS, describeOwner, judgeProcess, ownerKey, resolveOwner } from '../registry/owner.ts';
import { stateDir } from '../registry/paths.ts';
import { readRegistryStatus } from '../registry/registry.ts';
import type { CliDeps } from '../registry-cli.ts';
import { releaseEveryLaneOf, resolveFolder } from '../registry-cli.ts';
import { commandUsage, groupUsage, type UsageGroup } from '../usage.ts';
import { aimsOf } from './aims.ts';
import type { HookInput, HookReply } from './conventions.ts';
import { CONVENTIONS, readHookInput } from './conventions.ts';
import { guard } from './guard.ts';
import { claudeSessionName } from './session-name.ts';

export const HOOK_COMMANDS = ['hook'] as const;

export const HOOK_HELP: UsageGroup<(typeof HOOK_COMMANDS)[number]> = {
  title: "Agent hooks (the plugin's hooks call these with the hook's JSON on stdin):",
  entries: {
    hook: `  hook pre-tool-use    Deny a simctl, adb, emulator or avdmanager command aimed at a device
                       another session holds, and a playwright-cli or agent-browser command
                       aimed at another session's browser, the way the agent's hooks block.
  hook session-end     Release every lane this session holds and stop their services, in a
                       detached process (the session-end budget is short).
                       Both take --agent ${AGENTS.join('|')} (default claude).
`,
  },
};

export const HOOK_USAGE = groupUsage(HOOK_HELP);

export const SESSION_END_OWNER_ENV = envName('SESSION_END_OWNER');
export const SESSION_END_WAIT_ENV = envName('SESSION_END_WAIT_MS');
const OWNER_EXIT_WAIT_MS = 30_000;
const OWNER_EXIT_POLL_MS = 250;

export interface HookDeps extends CliDeps {
  stdin: string;
  startWorker: (env: NodeJS.ProcessEnv, log: string) => void;
}

function selfOwner(deps: HookDeps): Owner | null {
  try {
    return resolveOwner(deps.env, deps.processes, deps.selfPid);
  } catch {
    return null;
  }
}

function worktreeOf(dir: string): string | null {
  try {
    return resolveFolder(dir).worktree;
  } catch {
    return null;
  }
}

function guardReply(raw: string, agent: Agent, deps: HookDeps): HookReply {
  const convention = CONVENTIONS[agent];
  const input = readHookInput(raw);
  const { command } = input;
  const cwd = input.cwd ?? deps.cwd;
  if (command === null || aimsOf(command, deps.env, cwd).length === 0) return convention.allow;
  const owner = selfOwner(deps);
  const report = readRegistryStatus({
    dir: stateDir(deps.env),
    processes: deps.processes,
    devices: deps.devices,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  const verdict = guard(command, deps.env, {
    self: owner ? ownerKey(owner) : null,
    cwd,
    lanes: report.lanes,
    now: report.now,
    worktreeOf,
    sessionName: lane => claudeSessionName(lane.owner, deps.env),
  });
  return verdict.allow ? convention.allow : convention.deny(verdict.reason);
}

function preToolUse(raw: string, agent: Agent, deps: HookDeps): number {
  let reply: HookReply;
  try {
    reply = guardReply(raw, agent, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply = {
      stdout: '',
      stderr: `${TOOL}: the device guard failed, so this command runs unguarded: ${message}\n`,
      code: CONVENTIONS[agent].failExit,
    };
  }
  if (reply.stdout) deps.stdout(reply.stdout);
  if (reply.stderr) deps.stderr(reply.stderr);
  return reply.code;
}

function parseOwner(raw: string): Owner {
  const value = JSON.parse(raw) as Partial<Owner>;
  const kinds = ['claude', 'codex', 'process'];
  if (typeof value.kind !== 'string' || !kinds.includes(value.kind))
    throw new Error(`${SESSION_END_OWNER_ENV} has no owner kind`);
  return {
    kind: value.kind,
    process:
      value.process && typeof value.process.pid === 'number' && typeof value.process.start === 'string'
        ? { pid: value.process.pid, start: value.process.start }
        : null,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    threadId: typeof value.threadId === 'string' ? value.threadId : null,
  };
}

function sessionEnd(input: HookInput, agent: Agent, deps: HookDeps): number {
  const convention = CONVENTIONS[agent];
  if (input.reason !== null && convention.keepOn.has(input.reason)) return 0;
  const threadId = input.sessionId;
  const owner: Owner | null =
    convention.release === 'by-thread' && !deps.env.CODEX_THREAD_ID && threadId
      ? { kind: 'codex', process: null, sessionId: null, threadId }
      : selfOwner(deps);
  if (!owner) {
    deps.stderr(`${TOOL}: session end: could not tell which session ended; its lanes stay until their owner is proven gone\n`);
    return 1;
  }
  const dir = stateDir(deps.env);
  const key = ownerKey(owner);
  const held = readRegistryStatus({ dir, processes: deps.processes, devices: {} }).lanes.filter(c => c.ownerKey === key);
  if (held.length === 0) return 0;
  const log = path.join(dir, 'session-end.log');
  const waits = convention.release !== 'at-once' && convention.release !== 'by-thread' && owner.process !== null;
  deps.startWorker(
    {
      ...deps.env,
      [SESSION_END_OWNER_ENV]: JSON.stringify(owner),
      ...(waits ? { [SESSION_END_WAIT_ENV]: String(OWNER_EXIT_WAIT_MS) } : {}),
    },
    log,
  );
  const when = waits ? ' once that process exits' : '';
  deps.stderr(
    `${TOOL}: releasing ${String(held.length)} lane(s) of ${describeOwner(owner)} in the background${when}: ${held.map(c => c.id).join(', ')} (log: ${log})\n`,
  );
  return 0;
}

export function detachedWorker(cli: string): (env: NodeJS.ProcessEnv, log: string) => void {
  return (env, log) => {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, 'a');
    try {
      const child = spawn(process.execPath, [cli, 'hook', 'session-end'], {
        env,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.unref();
    } finally {
      fs.closeSync(fd);
    }
  };
}

async function ownerExited(owner: Owner, waitMs: number, deps: HookDeps): Promise<boolean> {
  const identity = owner.process;
  if (identity === null) return true;
  const clock = deps.clock ?? systemClock;
  const deadline = clock.now() + waitMs;
  for (;;) {
    const verdict = judgeProcess(identity, deps.processes.startTimes([identity.pid]));
    if (verdict === 'dead' || verdict === 'pid-reused') return true;
    if (clock.now() >= deadline) return false;
    await clock.sleep(deps.pollMs ?? OWNER_EXIT_POLL_MS);
  }
}

async function releaseWorker(raw: string, deps: HookDeps): Promise<number> {
  const owner = parseOwner(raw);
  const clock = deps.clock ?? systemClock;
  const stamp = () => new Date(clock.now()).toISOString();
  const waitMs = Number(deps.env[SESSION_END_WAIT_ENV] ?? 0);
  if (waitMs > 0 && !(await ownerExited(owner, waitMs, deps))) {
    deps.stderr(
      `${stamp()} session end: ${describeOwner(owner)} is still running after ${String(waitMs / 1000)} s (a cleared session, or another conversation in the same app), so its lanes stay; they are freed once it exits\n`,
    );
    return 0;
  }
  deps.stderr(`${stamp()} session end: releasing every lane of ${describeOwner(owner)}\n`);
  return releaseEveryLaneOf(deps, owner);
}

function parseHookArgs(args: string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { codex: { type: 'boolean', default: false }, agent: { type: 'string' } },
  });
}

export async function runHookCommand(args: string[], deps: HookDeps): Promise<number> {
  let parsed: ReturnType<typeof parseHookArgs>;
  try {
    parsed = parseHookArgs(args);
  } catch (error) {
    if (!(error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS'))) throw error;
    deps.stderr(`${TOOL} hook: ${error.message}\n\n${commandUsage(HOOK_HELP, 'hook')}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [event] = positionals;
  const named = values.agent ?? (values.codex ? 'codex' : 'claude');
  if (!(AGENTS as readonly string[]).includes(named)) {
    deps.stderr(`${TOOL} hook: '${named}' is not an agent; pass --agent ${AGENTS.join('|')}\n`);
    return 2;
  }
  const agent = named as Agent;
  if (event === 'session-end') {
    const owner = deps.env[SESSION_END_OWNER_ENV];
    if (owner) return releaseWorker(owner, deps);
    return sessionEnd(readHookInput(deps.stdin), agent, deps);
  }
  if (event === 'pre-tool-use') return preToolUse(deps.stdin, agent, deps);
  deps.stderr(`${TOOL} hook: '${event ?? ''}' is not a hook\n\n${HOOK_USAGE}`);
  return 2;
}
