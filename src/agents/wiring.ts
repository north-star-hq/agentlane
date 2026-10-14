import { FORMER, TOOL } from '../name.ts';
import type { Agent } from '../registry/owner.ts';
import { CLAUDE_SETTINGS } from './claude-plugin.ts';
import { hookCommand, isToolkitHook, mcpLaunch } from './launcher.ts';
import type { Skill } from './skills.ts';
import { stubOf } from './skills.ts';

export type Json = Record<string, unknown>;
export type Part = 'skills' | 'MCP server' | 'guard hook' | 'release hook' | 'plugin' | 'skill the plugin brings';

interface Base {
  file: string;
  agent: Agent | null;
  part: Part;
}

export type Edit =
  | (Base & {
      kind: 'json';
      apply: (doc: Json) => string | null;
      present: (doc: Json) => boolean;
      emptied?: (doc: Json) => boolean;
      cleanup?: true;
    })
  | (Base & { kind: 'toml'; table: string[]; body: string | null })
  | (Base & { kind: 'stub'; skill: string; content: string })
  | (Base & { kind: 'link'; skill: string; target: string; source: string })
  | (Base & { kind: 'unlink'; skill: string; target: string });

export const SKILLS = '.agents/skills';
export const CLAUDE_SKILLS = '.claude/skills';

const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'SessionEnd'];

function object(doc: Json, key: string): Json | string {
  const value = doc[key] ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) return `its ${key} is not an object`;
  doc[key] = value;
  return value as Json;
}

function list(doc: Json, key: string): unknown[] | string {
  const value = doc[key] ?? [];
  if (!Array.isArray(value)) return `${key} is not a list`;
  doc[key] = value;
  return value as unknown[];
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formerServerIn(servers: unknown): boolean {
  return isObject(servers) && JSON.stringify(servers[FORMER.tool] ?? null).includes(FORMER.cli);
}

function mcpEdit(file: string, agent: Agent): Edit {
  const ours = mcpLaunch();
  return {
    kind: 'json',
    file,
    agent,
    part: 'MCP server',
    apply: doc => {
      const servers = object(doc, 'mcpServers');
      if (typeof servers === 'string') return servers;
      const former = formerServerIn(servers) ? servers[FORMER.tool] : undefined;
      const current = servers[TOOL] ?? former;
      const kept = isObject(current) ? current : {};
      if (former !== undefined) Reflect.deleteProperty(servers, FORMER.tool);
      servers[TOOL] = { ...kept, ...ours };
      return null;
    },
    present: doc => {
      const servers = doc.mcpServers;
      return (isObject(servers) && TOOL in servers) || formerServerIn(servers);
    },
  };
}

function hasToolkitHook(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const fields = entry as Json;
  if (isToolkitHook(fields.command) || isToolkitHook(fields.bash)) return true;
  return Array.isArray(fields.hooks) && fields.hooks.some(hasToolkitHook);
}

function eventEntries(doc: Json, event: string): unknown[] | string {
  const hooks = object(doc, 'hooks');
  if (typeof hooks === 'string') return hooks;
  return list(hooks, event);
}

function hookEdit(file: string, agent: Agent, part: Part, event: string, entry: Json, fields: Json = {}): Edit {
  return {
    kind: 'json',
    file,
    agent,
    part,
    apply: doc => {
      for (const [key, value] of Object.entries(fields)) doc[key] ??= value;
      const entries = eventEntries(doc, event);
      if (typeof entries === 'string') return entries;
      const ours = entries.filter(hasToolkitHook);
      if (ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(entry)) return null;
      const rest = entries.filter(e => !hasToolkitHook(e));
      entries.splice(0, entries.length, ...rest, entry);
      return null;
    },
    present: doc => {
      const hooks = doc.hooks;
      if (typeof hooks !== 'object' || hooks === null) return false;
      const entries = (hooks as Json)[event];
      return Array.isArray(entries) && entries.some(hasToolkitHook);
    },
  };
}

function command(agent: Agent, event: 'pre-tool-use' | 'session-end', extra: Json = {}): Json {
  return { type: 'command', command: hookCommand(agent, event), ...extra };
}

export function disablesOurServer(doc: Json): boolean {
  const disabled = doc.disabledMcpjsonServers;
  return Array.isArray(disabled) && (disabled.includes(TOOL) || disabled.includes(FORMER.tool));
}

function claudeEdits(): Edit[] {
  return [
    mcpEdit('.mcp.json', 'claude'),
    {
      kind: 'json',
      file: CLAUDE_SETTINGS,
      agent: 'claude',
      part: 'MCP server',
      apply: doc => {
        if (!disablesOurServer(doc)) return null;
        const rest = (doc.disabledMcpjsonServers as unknown[]).filter(name => name !== TOOL && name !== FORMER.tool);
        if (rest.length > 0) doc.disabledMcpjsonServers = rest;
        else delete doc.disabledMcpjsonServers;
        return null;
      },
      present: () => false,
    },
    hookEdit(CLAUDE_SETTINGS, 'claude', 'guard hook', 'PreToolUse', {
      matcher: 'Bash|Monitor',
      hooks: [command('claude', 'pre-tool-use', { timeout: 30 })],
    }),
    hookEdit(CLAUDE_SETTINGS, 'claude', 'release hook', 'SessionEnd', {
      matcher: 'prompt_input_exit|logout|other',
      hooks: [command('claude', 'session-end', { timeout: 10 })],
    }),
  ];
}

export function hasClaudeHooks(doc: Json): boolean {
  const hooks = doc.hooks;
  if (typeof hooks !== 'object' || hooks === null) return false;
  return CLAUDE_HOOK_EVENTS.some(event => {
    const entries = (hooks as Json)[event];
    return Array.isArray(entries) && entries.some(hasToolkitHook);
  });
}

function claudePluginEdits(disableServer: boolean): Edit[] {
  const disable: Edit = {
    kind: 'json',
    file: CLAUDE_SETTINGS,
    agent: 'claude',
    part: 'plugin',
    apply: doc => {
      const disabled = list(doc, 'disabledMcpjsonServers');
      if (typeof disabled === 'string') return disabled;
      const former = disabled.indexOf(FORMER.tool);
      if (former !== -1) disabled.splice(former, 1);
      if (!disabled.includes(TOOL)) disabled.push(TOOL);
      return null;
    },
    present: doc => pluginEnabled(doc) || disablesOurServer(doc),
  };
  const removeHooks: Edit = {
    kind: 'json',
    file: CLAUDE_SETTINGS,
    agent: 'claude',
    part: 'plugin',
    apply: doc => {
      if (!hasClaudeHooks(doc)) return null;
      const kept = Object.entries(doc.hooks as Json).flatMap(([event, entries]): [string, unknown][] => {
        if (!CLAUDE_HOOK_EVENTS.includes(event) || !Array.isArray(entries)) return [[event, entries]];
        const rest = entries.filter(entry => !hasToolkitHook(entry));
        return rest.length > 0 ? [[event, rest]] : [];
      });
      if (kept.length > 0) doc.hooks = Object.fromEntries(kept);
      else delete doc.hooks;
      return null;
    },
    present: hasClaudeHooks,
  };
  const rename: Edit = {
    kind: 'json',
    file: CLAUDE_SETTINGS,
    agent: 'claude',
    part: 'plugin',
    apply: doc => {
      renameFormerPlugin(doc);
      return null;
    },
    present: doc => formerPluginKeys(doc).length > 0,
  };
  return disableServer ? [rename, disable, removeHooks] : [rename, removeHooks];
}

export function pluginEnabled(settings: Json): boolean {
  const enabled = settings.enabledPlugins;
  if (!isObject(enabled)) return false;
  return Object.entries(enabled).some(([key, on]) => key.startsWith(`${TOOL}@`) && on === true);
}

export function formerPluginKeys(settings: Json | null): string[] {
  const enabled = settings?.enabledPlugins;
  return isObject(enabled) ? Object.keys(enabled).filter(key => key.startsWith(`${FORMER.tool}@`)) : [];
}

/** Enables the plugin under this version's name where settings enabled 0.2.x's, and renames its marketplace with it. */
function renameFormerPlugin(doc: Json): void {
  const enabled = doc.enabledPlugins;
  if (!isObject(enabled)) return;
  const marketplaces = doc.extraKnownMarketplaces;
  for (const key of formerPluginKeys(doc)) {
    const marketplace = key.slice(FORMER.tool.length + 1);
    const renamed = marketplace === FORMER.tool ? TOOL : marketplace;
    enabled[`${TOOL}@${renamed}`] ??= enabled[key];
    Reflect.deleteProperty(enabled, key);
    if (renamed !== marketplace && isObject(marketplaces) && marketplace in marketplaces) {
      marketplaces[renamed] ??= marketplaces[marketplace];
      Reflect.deleteProperty(marketplaces, marketplace);
    }
  }
}

function codexEdits(): Edit[] {
  const { command: launcher, args } = mcpLaunch();
  return [
    {
      kind: 'toml',
      file: '.codex/config.toml',
      agent: 'codex',
      part: 'MCP server',
      table: ['mcp_servers', FORMER.tool],
      body: null,
    },
    {
      kind: 'toml',
      file: '.codex/config.toml',
      agent: 'codex',
      part: 'MCP server',
      table: ['mcp_servers', TOOL],
      body: `command = ${JSON.stringify(launcher)}\nargs = [${args.map(a => JSON.stringify(a)).join(', ')}]`,
    },
    hookEdit('.codex/hooks.json', 'codex', 'guard hook', 'PreToolUse', {
      matcher: 'Bash',
      hooks: [command('codex', 'pre-tool-use', { timeout: 30 })],
    }),
    hookEdit('.codex/hooks.json', 'codex', 'release hook', 'SessionEnd', {
      hooks: [command('codex', 'session-end', { timeout: 3 })],
    }),
  ];
}

function cursorEdits(): Edit[] {
  const version = { version: 1 };
  return [
    mcpEdit('.cursor/mcp.json', 'cursor'),
    hookEdit(
      '.cursor/hooks.json',
      'cursor',
      'guard hook',
      'beforeShellExecution',
      { command: hookCommand('cursor', 'pre-tool-use'), timeout: 30 },
      version,
    ),
    hookEdit(
      '.cursor/hooks.json',
      'cursor',
      'release hook',
      'sessionEnd',
      { command: hookCommand('cursor', 'session-end'), timeout: 10 },
      version,
    ),
  ];
}

function removeToolkitHooks(doc: Json): void {
  const hooks = doc.hooks;
  if (!isObject(hooks)) return;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const rest = entries.filter(entry => !hasToolkitHook(entry));
    if (rest.length > 0) hooks[event] = rest;
    else Reflect.deleteProperty(hooks, event);
  }
}

function copilotEdits(): Edit[] {
  const file = `.github/hooks/${TOOL}.json`;
  const version = { version: 1 };
  const former: Edit = {
    kind: 'json',
    file: `.github/hooks/${FORMER.tool}.json`,
    agent: 'copilot',
    part: 'guard hook',
    cleanup: true,
    apply: doc => {
      removeToolkitHooks(doc);
      return null;
    },
    present: doc => isObject(doc.hooks) && Object.values(doc.hooks).some(e => Array.isArray(e) && e.some(hasToolkitHook)),
    emptied: doc =>
      Object.keys(doc).every(
        key => key === 'version' || (key === 'hooks' && isObject(doc.hooks) && Object.keys(doc.hooks).length === 0),
      ),
  };
  return [
    former,
    mcpEdit('.mcp.json', 'copilot'),
    hookEdit(
      file,
      'copilot',
      'guard hook',
      'preToolUse',
      { type: 'command', bash: hookCommand('copilot', 'pre-tool-use'), timeoutSec: 30 },
      version,
    ),
    hookEdit(
      file,
      'copilot',
      'release hook',
      'sessionEnd',
      { type: 'command', bash: hookCommand('copilot', 'session-end'), timeoutSec: 10 },
      version,
    ),
  ];
}

function geminiEdits(): Edit[] {
  const file = '.gemini/settings.json';
  return [
    mcpEdit(file, 'gemini'),
    hookEdit(file, 'gemini', 'guard hook', 'BeforeTool', {
      matcher: 'run_shell_command',
      hooks: [command('gemini', 'pre-tool-use', { name: `${TOOL}-guard`, timeout: 30_000 })],
    }),
    hookEdit(file, 'gemini', 'release hook', 'SessionEnd', {
      hooks: [command('gemini', 'session-end', { name: `${TOOL}-release`, timeout: 10_000 })],
    }),
  ];
}

function antigravityEdits(): Edit[] {
  const ours = {
    PreToolUse: [{ matcher: 'run_command', hooks: [command('antigravity', 'pre-tool-use', { timeout: 30 })] }],
  };
  return [
    mcpEdit('.agents/mcp_config.json', 'antigravity'),
    {
      kind: 'json',
      file: '.agents/hooks.json',
      agent: 'antigravity',
      part: 'guard hook',
      apply: doc => {
        Reflect.deleteProperty(doc, FORMER.tool);
        doc[TOOL] = ours;
        return null;
      },
      present: doc => TOOL in doc || FORMER.tool in doc,
    },
  ];
}

export function agentEdits(agent: Agent, claudePlugin: boolean, disableServer = true): Edit[] {
  switch (agent) {
    case 'claude':
      return claudePlugin ? claudePluginEdits(disableServer) : claudeEdits();
    case 'codex':
      return codexEdits();
    case 'cursor':
      return cursorEdits();
    case 'copilot':
      return copilotEdits();
    case 'gemini':
      return geminiEdits();
    case 'antigravity':
      return antigravityEdits();
  }
}

export function stubEdits(skills: readonly Skill[]): Edit[] {
  return skills.map(skill => ({
    kind: 'stub',
    file: `${SKILLS}/${skill.name}/SKILL.md`,
    agent: null,
    part: 'skills',
    skill: skill.name,
    content: stubOf(skill),
  }));
}

export function unlinkEdit(name: string): Edit {
  return {
    kind: 'unlink',
    file: `${CLAUDE_SKILLS}/${name}`,
    agent: 'claude',
    part: 'skill the plugin brings',
    skill: name,
    target: `../../${SKILLS}/${name}`,
  };
}

export function mirrorEdit(name: string, source: string): Edit {
  return {
    kind: 'link',
    file: `${CLAUDE_SKILLS}/${name}`,
    agent: 'claude',
    part: 'skills',
    skill: name,
    target: `../../${SKILLS}/${name}`,
    source,
  };
}
