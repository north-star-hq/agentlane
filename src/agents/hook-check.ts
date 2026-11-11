import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLI, TOOL } from '../name.ts';
import type { HookMark } from '../plugin/hook-mark.ts';
import { HOOK_PROBE_ENV, readHookMark } from '../plugin/hook-mark.ts';
import type { Agent } from '../registry/owner.ts';
import { stateDir } from '../registry/paths.ts';
import { claudePluginInstall } from './claude-plugin.ts';
import { isToolkitHook } from './launcher.ts';
import { listedRange, nearestPackage } from './package.ts';
import type { Json } from './wiring.ts';
import { agentEdits } from './wiring.ts';

export interface HookCheck {
  name: string;
  ok: boolean;
  warning?: boolean;
  detail: string;
  fix: string;
}

export const PROBE_COMMAND = `echo ${TOOL} doctor checks that the simctl guard runs`;
const PROBE_TIMEOUT_MS = 10_000;
export const MARK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Route {
  where: string;
  file: string;
  command: string;
  env: NodeJS.ProcessEnv;
}

function guardFile(agent: Agent): string {
  const edit = agentEdits(agent, false).find(e => e.part === 'guard hook' && e.kind === 'json' && e.cleanup !== true);
  if (!edit) throw new Error(`${agent} has no guard hook file`);
  return edit.file;
}

function guardCommands(value: unknown): string[] {
  if (typeof value === 'string') return isToolkitHook(value) && value.includes(' hook pre-tool-use') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(guardCommands);
  if (typeof value === 'object' && value !== null) return Object.values(value as Json).flatMap(guardCommands);
  return [];
}

function settingsCommand(root: string, file: string): string | null {
  try {
    return guardCommands(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')))[0] ?? null;
  } catch {
    return null;
  }
}

function modified(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function manifestAt(file: string): { file: string; version: string } | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
    return manifest.name === TOOL && typeof manifest.version === 'string'
      ? { file: fs.realpathSync(file), version: manifest.version }
      : null;
  } catch {
    return null;
  }
}

function toolkitManifest(bin: string): { file: string; version: string } | null {
  const beside = manifestAt(path.join(path.dirname(path.dirname(bin)), TOOL, 'package.json'));
  if (beside) return beside;
  let target: string;
  try {
    target = fs.realpathSync(bin);
  } catch {
    return null;
  }
  if (target === bin) return null;
  for (let dir = path.dirname(target); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const found = manifestAt(path.join(dir, 'package.json'));
    if (found) return found;
  }
  return null;
}

function markHolds(mark: HookMark, bin: string, hookFile: string, now: number): boolean {
  const manifest = toolkitManifest(bin);
  return (
    manifest !== null &&
    mark.version === manifest.version &&
    mark.at >= modified(hookFile) &&
    mark.at > modified(bin) &&
    mark.at > modified(manifest.file) &&
    now - mark.at <= MARK_MAX_AGE_MS
  );
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function worktrees(root: string): string[] {
  const listed = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  return listed.stdout.split('\n').flatMap(line => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []));
}

/** The toolkit the hooks `init` writes would run: the first above the project, else in another of its worktrees. */
function toolkitFor(root: string): string | null {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (executable(path.join(dir, CLI))) return path.join(dir, CLI);
    if (path.dirname(dir) === dir) break;
  }
  return (
    worktrees(root)
      .map(dir => path.join(dir, CLI))
      .find(executable) ?? null
  );
}

function installFix(root: string, agent: Agent): string {
  const listed = nearestPackage(root, root);
  const range = listed ? listedRange(listed) : null;
  return range !== null
    ? `install the project's dependencies, so ${CLI} exists (package.json lists ${TOOL}${range ? ` ${range}` : ''}), then ${CLI} doctor`
    : `run npx ${TOOL} init --agents ${agent}, which adds ${TOOL} as a dev dependency, then ${CLI} doctor`;
}

function ran(mark: HookMark, how: string): string {
  return `${how} reached ${mark.toolkit} (${mark.version}) at ${new Date(mark.at).toISOString()}`;
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? '';
}

function probe(root: string, agent: Agent, route: Route, bin: string, env: NodeJS.ProcessEnv): HookCheck {
  const name = `hooks ${agent}`;
  const token = crypto.randomBytes(8).toString('hex');
  const result = spawnSync('/bin/sh', ['-c', route.command], {
    cwd: root,
    env: { ...env, CLAUDE_PROJECT_DIR: root, CURSOR_PROJECT_DIR: root, ...route.env, [HOOK_PROBE_ENV]: token },
    input: JSON.stringify({ cwd: root, tool_input: { command: PROBE_COMMAND } }),
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  const last = readHookMark(stateDir(env), agent, root);
  const mark = last?.probe === token ? last : null;
  const how = `doctor ran the guard hook in ${route.where} on a command it allows, and it`;
  const exit = result.error
    ? `failed to run: ${result.error.message}`
    : result.status === null
      ? `was stopped by ${String(result.signal)}`
      : `exited ${String(result.status)}${result.stderr.trim() ? `: ${firstLine(result.stderr)}` : ''}`;
  if (mark && result.status === 0) return { name, ok: true, detail: ran(mark, how), fix: '' };
  const fix = `${CLI} init --agents ${agent}, then ${CLI} doctor`;
  if (mark) return { name, ok: false, detail: `${ran(mark, how)}, then ${exit}`, fix };
  if (result.status === 0)
    return {
      name,
      ok: false,
      detail: `${how} exited 0 without reaching the toolkit at ${bin}: its command found no toolkit to run, or predates the one init writes`,
      fix,
    };
  return { name, ok: false, detail: `${how} never reached the toolkit: it ${exit}`, fix };
}

function hookCheck(root: string, agent: Agent, env: NodeJS.ProcessEnv, now: number): HookCheck {
  const name = `hooks ${agent}`;
  const file = guardFile(agent);
  const command = settingsCommand(root, file);
  let route: Route | null = command ? { where: file, file: path.join(root, file), command, env: {} } : null;
  if (route === null && agent === 'claude') {
    const install = claudePluginInstall(root, env);
    if (install?.kind === 'loaded') {
      const script = path.join(install.dir, 'scripts', 'hook.sh');
      route = {
        where: `the plugin in ${install.dir}`,
        file: script,
        command: `"${script}" pre-tool-use`,
        env: { CLAUDE_PLUGIN_ROOT: install.dir },
      };
    } else if (install?.kind === 'not-installed')
      return {
        name,
        ok: false,
        detail: `no ${TOOL} hook runs in Claude Code here: ${file} has none, and the plugin it leaves them to (${install.keys.join(', ')}) is enabled but not installed on this Mac`,
        fix: `${CLI} init --agents claude writes the hooks into ${file}`,
      };
    else if (install?.kind === 'unknown')
      return {
        name,
        ok: true,
        warning: true,
        detail: `${file} has no ${TOOL} hooks, and doctor can't read which plugins Claude Code installed, so it can't tell whether the plugin's hooks run`,
        fix: `${CLI} init --agents claude writes the hooks into ${file}`,
      };
  }
  if (route === null)
    return {
      name,
      ok: false,
      detail: `${file} has no ${TOOL} guard hook, so no ${TOOL} hook runs in ${agent}`,
      fix: `${CLI} init --agents ${agent}`,
    };
  const bin = toolkitFor(root);
  if (bin === null)
    return {
      name,
      ok: false,
      detail: `the hooks in ${route.where} find no ${CLI} in ${root}, the folders above it or this repository's other worktrees, so they never run ${TOOL}`,
      fix: installFix(root, agent),
    };
  const mark = readHookMark(stateDir(env), agent, root);
  if (mark && markHolds(mark, bin, route.file, now))
    return { name, ok: true, detail: ran(mark, `the ${mark.event} hook in ${route.where}`), fix: '' };
  return probe(root, agent, route, bin, env);
}

/**
 * One line per agent: whether its hooks run. The mark the hook left for this project folder answers while it is newer
 * than the hook and the toolkit, names the toolkit's version and is under a day old; otherwise doctor runs the guard
 * hook on a command it allows.
 */
export function agentHookChecks(
  root: string,
  agents: readonly Agent[],
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): HookCheck[] {
  return agents.map(agent => {
    try {
      return hookCheck(root, agent, env, now);
    } catch (error) {
      return {
        name: `hooks ${agent}`,
        ok: true,
        warning: true,
        detail: `could not check the hooks: ${(error as Error).message}`,
        fix: `${CLI} init --check`,
      };
    }
  });
}
