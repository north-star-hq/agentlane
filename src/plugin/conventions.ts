import path from 'node:path';
import type { Agent } from '../registry/owner.ts';

export interface HookReply {
  stdout: string;
  stderr: string;
  code: number;
}

export type SessionEndRelease = 'at-once' | 'by-thread' | 'once-the-owner-exits';

interface Convention {
  deny: (reason: string) => HookReply;
  allow: HookReply;
  failExit: number;
  release: SessionEndRelease | null;
  keepOn: ReadonlySet<string>;
}

const quiet: HookReply = { stdout: '', stderr: '', code: 0 };
const json = (value: object): HookReply => ({ stdout: `${JSON.stringify(value)}\n`, stderr: '', code: 0 });
const exit2 = (reason: string): HookReply => ({ stdout: '', stderr: `${reason}\n`, code: 2 });

export const CONVENTIONS: Record<Agent, Convention> = {
  claude: {
    deny: reason =>
      json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
    allow: quiet,
    failExit: 1,
    release: 'at-once',
    keepOn: new Set(['clear', 'resume']),
  },
  codex: { deny: exit2, allow: quiet, failExit: 1, release: 'by-thread', keepOn: new Set(['clear', 'resume']) },
  gemini: { deny: exit2, allow: quiet, failExit: 1, release: 'once-the-owner-exits', keepOn: new Set(['clear']) },
  copilot: {
    deny: reason => json({ permissionDecision: 'deny', permissionDecisionReason: reason }),
    allow: quiet,
    failExit: 0,
    release: 'once-the-owner-exits',
    keepOn: new Set(),
  },
  cursor: {
    deny: reason => json({ permission: 'deny', user_message: reason.split('\n', 1)[0] ?? reason, agent_message: reason }),
    allow: json({ permission: 'allow' }),
    failExit: 1,
    release: 'once-the-owner-exits',
    keepOn: new Set(),
  },
  antigravity: {
    deny: reason => json({ decision: 'deny', reason }),
    allow: quiet,
    failExit: 0,
    release: null,
    keepOn: new Set(),
  },
};

export interface HookInput {
  command: string | null;
  cwd: string | null;
  sessionId: string | null;
  reason: string | null;
}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function text(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value !== '') return value;
  return null;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : undefined;
}

function toolArgs(value: unknown): Fields {
  if (typeof value !== 'string') return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

/** Reads the hook input of every supported agent: Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor and Antigravity. */
export function readHookInput(raw: string): HookInput {
  const input = raw.trim() === '' ? {} : record(JSON.parse(raw));
  const tool = record(input.tool_input);
  const copilot = toolArgs(input.toolArgs);
  const antigravity = record(record(input.toolCall).args);
  const base = text(input.cwd, first(input.workspace_roots), first(input.workspacePaths));
  const dir = text(tool.dir_path, tool.directory, antigravity.Cwd, copilot.cwd);
  return {
    command: text(tool.command, input.command, copilot.command, antigravity.CommandLine),
    cwd: dir === null ? base : base === null ? dir : path.resolve(base, dir),
    sessionId: text(input.session_id, input.sessionId, input.conversation_id, input.conversationId),
    reason: text(input.reason),
  };
}
