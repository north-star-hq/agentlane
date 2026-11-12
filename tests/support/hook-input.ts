import type { Agent } from '../../src/registry/owner.ts';

export type HookInputShape = (command: string, cwd: string) => object;

export const DOCUMENTED_INPUT: Record<Agent | 'copilot-claude-format', HookInputShape> = {
  claude: (command, cwd) => ({
    session_id: 's-1',
    transcript_path: '/tmp/t.jsonl',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  }),
  codex: (command, cwd) => ({
    session_id: 'thr_123',
    transcript_path: '/tmp/rollout.jsonl',
    cwd,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    tool_use_id: 'call-1',
    tool_input: { command },
    permission_mode: 'default',
  }),
  gemini: (command, cwd) => ({
    session_id: 'g-1',
    transcript_path: '/tmp/g.json',
    cwd,
    hook_event_name: 'BeforeTool',
    timestamp: '2026-10-12T09:00:00.000Z',
    tool_name: 'run_shell_command',
    tool_input: { command, description: 'install the app' },
  }),
  copilot: (command, cwd) => ({
    sessionId: 'cp-1',
    timestamp: 1_791_795_600_000,
    cwd,
    toolName: 'bash',
    toolArgs: JSON.stringify({ command, description: 'install the app' }),
  }),
  'copilot-claude-format': (command, cwd) => ({
    hook_event_name: 'PreToolUse',
    session_id: 'cp-1',
    timestamp: '2026-10-12T09:00:00.000Z',
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  }),
  cursor: (command, cwd) => ({
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    model: 'some-model',
    hook_event_name: 'beforeShellExecution',
    cursor_version: '2.4.0',
    workspace_roots: [cwd],
    user_email: null,
    transcript_path: null,
    command,
    cwd,
    sandbox: false,
  }),
  antigravity: (command, cwd) => ({
    toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd, WaitMsBeforeAsync: 5000 } },
    stepIdx: 19,
    conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
    workspacePaths: [cwd],
    transcriptPath: '/tmp/a.json',
    artifactDirectoryPath: '/tmp/a',
    modelName: 'gemini-3.6-flash-medium',
  }),
};

export function formatsOf(agent: Agent): [string, HookInputShape][] {
  return Object.entries(DOCUMENTED_INPUT).filter(([format]) => format === agent || format.startsWith(`${agent}-`));
}
