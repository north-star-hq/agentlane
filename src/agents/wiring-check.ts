import fs from 'node:fs';
import path from 'node:path';
import { CLI, TOOL } from '../name.ts';
import type { Agent } from '../registry/owner.ts';
import { AGENTS } from '../registry/owner.ts';
import type { PluginSource } from './claude-plugin.ts';
import { CLAUDE_SETTINGS, describePluginSource, jsonObjectAt } from './claude-plugin.ts';
import type { FilePlan } from './init.ts';
import { planInit } from './init.ts';
import type { Skill } from './skills.ts';
import { listSkills, SKILLS_DIR } from './skills.ts';
import type { Edit, Json } from './wiring.ts';
import { agentEdits, disablesOurServer, hasClaudeHooks, pluginEnabled } from './wiring.ts';

export interface WiringCheck {
  name: string;
  ok: true;
  warning: boolean;
  detail: string;
  fix: string;
}

const SHARED = new Set(['.mcp.json']);

function holds(root: string, edit: Edit): boolean {
  if (edit.part === 'skills' || SHARED.has(edit.file)) return false;
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, edit.file), 'utf8');
  } catch {
    return false;
  }
  if (edit.kind === 'toml') return text.includes(`[${edit.table.join('.')}]`);
  if (edit.kind !== 'json') return false;
  try {
    return edit.present(JSON.parse(text) as Json);
  } catch {
    return true;
  }
}

export function agentsSetUp(root: string): Agent[] {
  return AGENTS.filter(agent =>
    [...agentEdits(agent, false), ...(agent === 'claude' ? agentEdits(agent, true) : [])].some(edit => holds(root, edit)),
  );
}

function problem(file: FilePlan): string {
  const parts = [...new Set(file.edits.map(e => e.part))].join(', ');
  switch (file.status) {
    case 'create':
      return `missing ${file.file} (${parts})`;
    case 'update':
      return `stale ${file.file} (${parts})`;
    case 'remove':
      return `duplicate ${file.file} (${parts})`;
    case 'refused':
      return file.reason ?? file.file;
    case 'unchanged':
      return '';
  }
}

function check(name: string, problems: readonly FilePlan[], fine: string, fix: string): WiringCheck {
  return problems.length === 0
    ? { name, ok: true, warning: false, detail: fine, fix: '' }
    : { name, ok: true, warning: true, detail: problems.map(problem).join('; '), fix };
}

function claudeCopies(root: string, claude: readonly FilePlan[]): string[] {
  const copies: string[] = [];
  const settings = jsonObjectAt(path.join(root, CLAUDE_SETTINGS));
  const servers = jsonObjectAt(path.join(root, '.mcp.json'))?.mcpServers;
  if (typeof servers === 'object' && servers !== null && TOOL in servers && !(settings && disablesOurServer(settings)))
    copies.push('MCP server in .mcp.json');
  if (settings !== null && hasClaudeHooks(settings)) copies.push(`hooks in ${CLAUDE_SETTINGS}`);
  const links = claude.filter(f => f.status === 'remove').length;
  if (links > 0) copies.push(`${String(links)} toolkit skill${links === 1 ? '' : 's'} in .claude/skills`);
  return copies;
}

function leftToAbsentPlugin(root: string): boolean {
  const settings = jsonObjectAt(path.join(root, CLAUDE_SETTINGS));
  return settings !== null && disablesOurServer(settings) && !pluginEnabled(settings);
}

function bothWired(source: PluginSource, copies: readonly string[]): string {
  const listed = copies.length === 1 ? copies.join('') : `${copies.slice(0, -1).join(', ')} and ${copies.at(-1) ?? ''}`;
  return `${describePluginSource(source)}, and the project's own ${listed} wire Claude Code a second time, so a session gets each of them twice`;
}

/** One line per agent the project has set up with `init`, plus one for the skill stubs. Nothing when none is set up. */
export function agentWiringChecks(
  root: string,
  env: NodeJS.ProcessEnv,
  skills: readonly Skill[] = listSkills(SKILLS_DIR),
): WiringCheck[] {
  try {
    const agents = agentsSetUp(root);
    if (agents.length === 0) return [];
    const plan = planInit(root, agents, skills, env);
    const off = plan.files.filter(f => f.status !== 'unchanged');
    const fix = `${CLI} init --agents ${agents.join(',')}`;
    const checks: WiringCheck[] = [];
    if (plan.files.some(f => f.edits.some(e => e.kind === 'stub')))
      checks.push(
        check(
          'wiring skills',
          off.filter(f => f.edits.every(e => e.agent === null)),
          `${String(skills.length)} skill stubs in .agents/skills`,
          fix,
        ),
      );
    for (const agent of agents) {
      const mine = off.filter(f => f.edits.some(e => e.agent === agent));
      const plugin = agent === 'claude' ? plan.claudePlugin : null;
      const fine = plugin ? `through the plugin: ${describePluginSource(plugin)}` : 'MCP server and hooks in place';
      const line = check(`wiring ${agent}`, mine, fine, `${CLI} init --agents ${agent}`);
      const copies = plugin ? claudeCopies(root, mine) : [];
      if (plugin && copies.length > 0) checks.push({ ...line, detail: bothWired(plugin, copies) });
      else if (agent === 'claude' && !plugin && line.warning && leftToAbsentPlugin(root))
        checks.push({
          ...line,
          detail: `the project leaves Claude Code to the ${TOOL} plugin, and here no settings file enables it and no session loads it: ${line.detail}`,
          fix: `load the plugin, or run ${CLI} init --agents claude to wire Claude Code without it`,
        });
      else checks.push(line);
    }
    return checks;
  } catch (error) {
    return [
      {
        name: 'wiring',
        ok: true,
        warning: true,
        detail: `could not read the agents' files: ${(error as Error).message}`,
        fix: `${CLI} init --check`,
      },
    ];
  }
}
