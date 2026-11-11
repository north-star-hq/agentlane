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

export const GUARDED_WORDS = [
  'simctl',
  'adb',
  'emulator',
  'avdmanager',
  'playwright-cli',
  '@playwright/cli',
  'agent-browser',
] as const;

/**
 * The hook's input arrives as JSON, which writes a backslash as `\\` and a newline as `\n`, and Copilot's `toolArgs` is
 * JSON inside that JSON, which doubles each of those backslashes again. Bash and zsh run `a{d,}b` as `adb ab` and
 * `a{d..d}b` as `adb`.
 */
export const UNSPLIT_SED = String.raw`sed -e h -e 's/\\\\//g' -e 's/\\n//g' -e x -e 's/\\\\\\\\//g' -e 's/\\\\n//g' -e G -e 's/\\//g' -e "s/[\$'\"]//g" -e p -e :x -e h -e 's/{\([-+0-9A-Za-z]*\)\.\.[-+0-9A-Za-z.]*}/\1/g' -e 's/{\([^{},]*\)\(,[^{},]*\)\{0,8\}}/\1/g' -e p -e g -e ty -e :y -e 's/{[^{},]*,\([^{},]*\(,[^{},]*\)\{0,7\}\)}/{\1}/g' -e tx -e d`;

const UNSPLIT_INPUT = `$(printf %s "$i" | ${UNSPLIT_SED})`;

function walkUp(start: string): string {
  return `d="${start}"; while [ ! -x "$d/${CLI}" ] && [ "$d" != / ]; do d=$(dirname "$d"); done`;
}

function launch(start: string, args: string, missing: string): string {
  return `${walkUp(start)}; if [ -x "$d/${CLI}" ]; then exec "$d/${CLI}" ${args}; fi; ${missing}`;
}

function worktreeFallback(): string {
  return `if [ ! -x "$d/${CLI}" ]; then d=$(git -C "$s" worktree list --porcelain 2>/dev/null | while IFS= read -r l; do w=\${l#worktree }; if [ "$w" != "$l" ] && [ -x "$w/${CLI}" ]; then printf %s "$w"; break; fi; done); fi`;
}

/**
 * The command an agent's hook runs: the project's own toolkit, found from the folder the hook runs in upwards, else in
 * the first worktree of the same repository that has one. The guard starts the toolkit only for a command that names
 * a device or browser tool. Without a toolkit it allows and exits 0, because Copilot denies the tool call on any other
 * exit and Gemini on exit 2 or more, and Cursor needs a JSON answer.
 */
export function hookCommand(agent: Agent, event: HookEvent): string {
  const allow = agent === 'cursor' && event === 'pre-tool-use' ? `echo '{"permission":"allow"}'; exit 0` : 'exit 0';
  const find = `s="${START[agent]}"; ${walkUp('$s')}; ${worktreeFallback()}`;
  const args = `hook ${event} --agent ${agent}`;
  if (event === 'session-end') return `${find}; if [ -x "$d/${CLI}" ]; then exec "$d/${CLI}" ${args}; fi; ${allow}`;
  const words = GUARDED_WORDS.map(word => `*${word}*`).join('|');
  return `i=$(cat); case ${UNSPLIT_INPUT} in ${words}) ;; *) ${allow};; esac; ${find}; if [ -x "$d/${CLI}" ]; then printf '%s' "$i" | "$d/${CLI}" ${args}; exit; fi; ${allow}`;
}

export function mcpLaunch(): { command: string; args: string[] } {
  const missing = `echo "${TOOL}: no ${CLI} in $PWD or the folders above it; add the toolkit to this project" >&2; exit 1`;
  return { command: 'sh', args: ['-c', launch('$PWD', 'mcp', missing)] };
}

export function isToolkitHook(command: unknown): boolean {
  return typeof command === 'string' && [CLI, FORMER.cli].some(cli => command.includes(`/${cli}" hook `));
}
