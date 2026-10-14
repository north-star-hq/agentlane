import { CLI, FORMER, TOOL } from '../name.ts';
import type { Agent } from '../registry/owner.ts';

export type HookEvent = 'pre-tool-use' | 'session-end';

/**
 * Gemini CLI replaces the literal text `$GEMINI_PROJECT_DIR` and `$CLAUDE_PROJECT_DIR` in a hook command with a quoted
 * path before it runs, so a launcher meant for Gemini starts from `$PWD`, which Gemini sets to the project.
 */
const START: Record<Agent, string> = {
  claude: '${CLAUDE_PROJECT_DIR:-$PWD}',
  codex: '$PWD',
  cursor: '${CURSOR_PROJECT_DIR:-$PWD}',
  copilot: '$PWD',
  gemini: '$PWD',
  antigravity: '$PWD',
};

function launch(start: string, args: string, missing: string): string {
  return `d="${start}"; while [ ! -x "$d/${CLI}" ] && [ "$d" != / ]; do d=$(dirname "$d"); done; if [ -x "$d/${CLI}" ]; then exec "$d/${CLI}" ${args}; fi; ${missing}`;
}

/**
 * The command an agent's hook runs: the project's own toolkit, found from the folder the hook runs in upwards. Without
 * a toolkit it allows and exits 0, because Copilot denies the tool call on any other exit and Gemini on exit 2 or
 * more, and Cursor needs a JSON answer.
 */
export function hookCommand(agent: Agent, event: HookEvent): string {
  const allow = agent === 'cursor' && event === 'pre-tool-use' ? `echo '{"permission":"allow"}'` : 'exit 0';
  return launch(START[agent], `hook ${event} --agent ${agent}`, allow);
}

export function mcpLaunch(): { command: string; args: string[] } {
  const missing = `echo "${TOOL}: no ${CLI} in $PWD or the folders above it; add the toolkit to this project" >&2; exit 1`;
  return { command: 'sh', args: ['-c', launch('$PWD', 'mcp', missing)] };
}

export function isToolkitHook(command: unknown): boolean {
  return typeof command === 'string' && [CLI, FORMER.cli].some(cli => command.includes(`/${cli}" hook `));
}
