import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FORMER, TOOL } from '../name.ts';
import { claudeConfigDir } from '../plugin/session-name.ts';

export const CLAUDE_SETTINGS = '.claude/settings.json';
export const CLAUDE_LOCAL_SETTINGS = '.claude/settings.local.json';

export type PluginSource =
  | { kind: 'project'; file: string }
  | { kind: 'local'; file: string }
  | { kind: 'user'; file: string }
  | { kind: 'session'; dir: string };

export function jsonObjectAt(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolkitEntries(settings: Record<string, unknown> | null, names: readonly string[]): [string, boolean][] {
  const enabled = settings?.enabledPlugins;
  if (typeof enabled !== 'object' || enabled === null) return [];
  return Object.entries(enabled).flatMap(([key, on]): [string, boolean][] =>
    names.some(name => key.startsWith(`${name}@`)) && typeof on === 'boolean' ? [[key, on]] : [],
  );
}

/** Claude Code puts each loaded plugin's `bin/` on its Bash tool's PATH and sets CLAUDECODE there. */
function sessionPluginDir(env: NodeJS.ProcessEnv): string | null {
  if (!env.CLAUDECODE) return null;
  for (const entry of (env.PATH ?? '').split(path.delimiter)) {
    if (path.basename(entry) !== 'bin') continue;
    const dir = path.dirname(entry);
    if (jsonObjectAt(path.join(dir, '.claude-plugin', 'plugin.json'))?.name === TOOL) return dir;
  }
  return null;
}

/**
 * Where Claude Code loads the toolkit's plugin from for this project, the most lasting first. Claude Code reads
 * `enabledPlugins` from the local project settings over the shared ones over the user's, key by key. The project's
 * settings count under 0.2.x's plugin name too, because init renames it there.
 */
export function claudePluginSources(root: string, env: NodeJS.ProcessEnv): PluginSource[] {
  const enabled = enabledPlugins(root, env);
  const order: PluginSource['kind'][] = ['project', 'local', 'user'];
  const sources = [...new Set(enabled.map(e => e.source))].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const dir = sessionPluginDir(env);
  if (dir !== null) sources.push({ kind: 'session', dir });
  return sources;
}

function enabledPlugins(root: string, env: NodeJS.ProcessEnv): { source: PluginSource; key: string }[] {
  const scopes: { source: PluginSource; at: string; names: readonly string[] }[] = [
    { source: { kind: 'local', file: CLAUDE_LOCAL_SETTINGS }, at: path.join(root, CLAUDE_LOCAL_SETTINGS), names: [TOOL] },
    { source: { kind: 'project', file: CLAUDE_SETTINGS }, at: path.join(root, CLAUDE_SETTINGS), names: [TOOL, FORMER.tool] },
  ];
  const user = path.join(claudeConfigDir(env), 'settings.json');
  scopes.push({ source: { kind: 'user', file: user }, at: user, names: [TOOL] });
  const decided = new Set<string>();
  const enabled: { source: PluginSource; key: string }[] = [];
  for (const { source, at, names } of scopes) {
    for (const [key, on] of toolkitEntries(jsonObjectAt(at), names)) {
      if (decided.has(key)) continue;
      decided.add(key);
      if (on) enabled.push({ source, key });
    }
  }
  return enabled;
}

export type PluginInstall = { kind: 'loaded'; dir: string } | { kind: 'not-installed'; keys: string[] } | { kind: 'unknown' };

function sameDir(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The folder itself and, inside a git worktree, the repository's main checkout. */
function checkoutsOf(root: string, env: NodeJS.ProcessEnv): string[] {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) return [root];
  const common = result.stdout.trim();
  return path.basename(common) === '.git' ? [root, path.dirname(common)] : [root];
}

/**
 * Where Claude Code loads the enabled plugin from on this Mac. Claude Code records what it installed in
 * `plugins/installed_plugins.json` under its config folder: format 2 maps `<plugin>@<marketplace>` to a list of
 * installs, each with a `scope`, a `projectPath` for project and local scopes, and an `installPath`. A project-scope
 * install also loads in the git worktrees of the checkout it names (Claude Code 2.1.325).
 */
export function claudePluginInstall(root: string, env: NodeJS.ProcessEnv): PluginInstall | null {
  const session = sessionPluginDir(env);
  if (session !== null) return { kind: 'loaded', dir: session };
  const keys = enabledPlugins(root, env).map(e => e.key);
  if (keys.length === 0) return null;
  const file = path.join(claudeConfigDir(env), 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(file)) return { kind: 'not-installed', keys };
  const plugins = jsonObjectAt(file)?.plugins;
  if (typeof plugins !== 'object' || plugins === null) return { kind: 'unknown' };
  let checkouts: string[] | undefined;
  for (const key of keys) {
    const listed: unknown = (plugins as Record<string, unknown>)[key];
    const installs = Array.isArray(listed) ? (listed as unknown[]) : listed === undefined ? [] : [listed];
    for (const install of installs) {
      if (typeof install !== 'object' || install === null) continue;
      const { scope, projectPath, installPath } = install as Record<string, unknown>;
      checkouts ??= checkoutsOf(root, env);
      const here = scope === undefined || scope === 'user' || checkouts.some(dir => sameDir(projectPath, dir));
      if (here && typeof installPath === 'string') return { kind: 'loaded', dir: installPath };
    }
  }
  return { kind: 'not-installed', keys };
}

export function claudePluginSource(root: string, env: NodeJS.ProcessEnv): PluginSource | null {
  return claudePluginSources(root, env)[0] ?? null;
}

export function describePluginSource(source: PluginSource): string {
  switch (source.kind) {
    case 'project':
      return `the project enables the ${TOOL} plugin in ${source.file}`;
    case 'local':
      return `your local settings for this project (${source.file}) enable the ${TOOL} plugin`;
    case 'user':
      return `your user settings (${source.file}) enable the ${TOOL} plugin in every project`;
    case 'session':
      return `this Claude Code session loads the ${TOOL} plugin from ${source.dir}`;
  }
}
