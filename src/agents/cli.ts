import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CLI, CONFIG_FILE, TOOL } from '../name.ts';
import { findConfigFile } from '../project/config.ts';
import type { Agent } from '../registry/owner.ts';
import { AGENTS } from '../registry/owner.ts';
import { stateDir } from '../registry/paths.ts';
import { UsageError } from '../registry/refusal.ts';
import { resolveFolder } from '../registry-cli.ts';
import { commandUsage, groupUsage, type UsageGroup } from '../usage.ts';
import type { PluginSource } from './claude-plugin.ts';
import { describePluginSource } from './claude-plugin.ts';
import type { Terminal } from './detect.ts';
import { chooseAgents, describeDetections, detectAgents } from './detect.ts';
import type { FilePlan, InitPlan } from './init.ts';
import { applyInit, planInit } from './init.ts';
import type { Installer } from './package.ts';
import {
  addCommand,
  installedVersion,
  listedRange,
  nearestPackage,
  PACKAGE_SPEC_ENV,
  packageManagerOf,
  shellLine,
  toolVersion,
} from './package.ts';
import { listSkills, SKILLS_DIR } from './skills.ts';

export const AGENT_COMMANDS = ['init', 'skills'] as const;
type AgentCommand = (typeof AGENT_COMMANDS)[number];

export const AGENT_HELP: UsageGroup<AgentCommand> = {
  title: 'Agents:',
  entries: {
    init: `  init [--agents <list> | --all] [--dir <folder>] [--check]
                       Write each agent's own project files from one source: the toolkit's skills in
                       .agents/skills (mirrored into .claude/skills for Claude Code), the MCP server,
                       and the device guard and session-end hooks. Agents: ${AGENTS.join(', ')}.
                       Without --agents or --all, init wires the agents whose files the project has
                       (CLAUDE.md, .codex/, .cursor/, ...) or whose session runs it, and in a terminal
                       asks you to confirm or change them.
                       Where the project's package.json doesn't list ${TOOL}, init adds it as a dev
                       dependency at its own version with the project's package manager, creating a
                       private package.json when there is none, because the hooks and the MCP server
                       run ${CLI}.
                       Where Claude Code loads the ${TOOL} plugin (the project's or your settings,
                       or the session running init), Claude Code is left to the plugin, and init
                       removes the copies of its skills and hooks an earlier init wrote.
                       A second run changes nothing; a changed file is backed up first, and a file
                       init can't parse is refused, with nothing written. --check writes and
                       installs nothing, and exits 1 when a file would change. The folder defaults
                       to the one with ${TOOL}.json, else the worktree.
`,
    skills: `  skills list          The toolkit's skills, each with what it is for.
  skills get <name>    Print a skill's content for this installed version; the skill files in a
                       project only point here.
`,
  },
};

export const AGENT_USAGE = groupUsage(AGENT_HELP);

export interface AgentCliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  install: Installer;
  terminal?: Terminal | null;
  skillsDir?: string;
  now?: () => number;
}

function throughPlugin(source: PluginSource): string {
  const done = `${describePluginSource(source)}, which brings the skills, the MCP server and the hooks, so init wrote none of them for Claude Code: it mirrored only the project's own skills and kept Claude Code from loading the .mcp.json server a second time`;
  if (source.kind === 'project') return done;
  const others = `Claude Code without the plugin gets none of them from this project's files; to wire it the same for everyone, enable the plugin in the project's .claude/settings.json`;
  return source.kind === 'session'
    ? `${done}. ${others}, or run ${CLI} init again outside a session that loads the plugin`
    : `${done}. ${others}`;
}

const NEXT: Record<Agent, (plugin: PluginSource | null) => string> = {
  claude: plugin => (plugin ? throughPlugin(plugin) : 'Claude Code asks once to approve the MCP server in .mcp.json'),
  codex: () =>
    'Codex reads .codex/ only in a trusted project, and runs each hook only after you review and trust it with /hooks, again whenever it changes',
  cursor: () =>
    'Cursor runs .cursor/hooks.json in the app; its CLI runs hooks unreliably. Release at session end waits for the Cursor process to exit',
  copilot: () =>
    "Copilot CLI loads the MCP server and the hooks once you trust the folder; it also runs Claude Code's hooks from .claude/settings.json",
  gemini: () => 'Gemini CLI warns when the project’s hooks change, and asks before it activates a skill',
  antigravity: () =>
    'Antigravity has no session-end hook, so its lanes are freed once Antigravity exits and the next claim reaps them',
};

function parseAgents(raw: string, all: boolean): Agent[] {
  if (all) throw new UsageError('--agents and --all both name the agents', 'pass one of them');
  const names = raw
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '');
  const unknown = names.filter(name => !(AGENTS as readonly string[]).includes(name));
  if (unknown.length > 0 || names.length === 0)
    throw new UsageError(`'${unknown.join(',') || raw}' is not an agent`, `pass --agents with any of ${AGENTS.join(',')}`);
  return AGENTS.filter(agent => names.includes(agent));
}

async function agentsToWire(values: { agents?: string; all: boolean }, root: string, deps: AgentCliDeps): Promise<Agent[]> {
  if (values.agents !== undefined) return parseAgents(values.agents, values.all);
  if (values.all) return [...AGENTS];
  const detected = detectAgents(root, deps.env);
  const choose = `pass --agents with the ones you use (${AGENTS.join(',')}), or --all`;
  if (deps.terminal) {
    const chosen = await chooseAgents(detected, deps.terminal);
    if (chosen === null) throw new UsageError('no agents chosen, so init wrote nothing', choose);
    return chosen;
  }
  if (detected.length === 0)
    throw new UsageError(
      `found no agent's files in ${root} and no agent's variable in this shell, so init doesn't know which agents to wire`,
      choose,
    );
  deps.stdout(`${TOOL} init: found these agents (pass --agents to pick others):\n${describeDetections(detected)}`);
  return detected.map(d => d.agent);
}

interface PackageOutcome {
  notes: string[];
  failed: { command: string; dir: string; problem: string } | null;
}

function ignoredByGit(dir: string, name: string): boolean {
  return spawnSync('git', ['-C', dir, 'check-ignore', '-q', name]).status === 0;
}

function provideToolkit(root: string, env: NodeJS.ProcessEnv, install: Installer): PackageOutcome {
  const top = resolveFolder(root).worktree;
  const own = toolVersion();
  const override = env[PACKAGE_SPEC_ENV];
  const spec = override !== undefined && override !== '' ? override : `${TOOL}@${own}`;
  const notes: string[] = [];
  const found = nearestPackage(root, top);
  const dir = found ?? root;
  const manifest = path.relative(root, path.join(dir, 'package.json'));
  const choice = packageManagerOf(dir, top, env);
  const command = addCommand(choice, dir, spec);
  if (found !== null) {
    const range = listedRange(dir);
    if (range !== null) {
      const installed = installedVersion(dir);
      if (installed === null)
        notes.push(
          `${manifest} lists ${TOOL} ${range}, but it isn't installed: run ${choice.manager} install there, so ${CLI} exists.`,
        );
      else if (installed !== own)
        notes.push(
          `${manifest} lists ${TOOL} ${range}, with ${installed} installed; init left it as it is. This init is ${own}: ${shellLine(addCommand(choice, dir, `${TOOL}@${own}`))} moves the project to it.`,
        );
      return { notes, failed: null };
    }
  } else {
    fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "private": true\n}\n');
    notes.push(`Created ${manifest}, private, to hold ${TOOL} as a dev dependency.`);
    if (!ignoredByGit(dir, 'node_modules')) notes.push('node_modules/ is not in .gitignore: add it before you commit.');
  }
  const result = install(command, dir);
  if (!result.ok) return { notes, failed: { command: shellLine(command), dir, problem: result.problem } };
  notes.push(
    `Added ${spec} to ${manifest} as a dev dependency with ${choice.manager}, because ${choice.source}: ${shellLine(command)}`,
  );
  return { notes, failed: null };
}

function projectRoot(cwd: string, dir: string | undefined): string {
  if (dir !== undefined) {
    const folder = path.resolve(cwd, dir);
    if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory())
      throw new UsageError(`${folder} is not a folder`, 'pass --dir with the project folder');
    return fs.realpathSync(folder);
  }
  const config = findConfigFile(cwd);
  return config ? path.dirname(config) : resolveFolder(cwd).worktree;
}

function role(file: FilePlan): string {
  const parts = new Map<string, Set<string>>();
  for (const edit of file.edits) {
    const who = edit.agent ?? 'every agent';
    parts.set(edit.part, (parts.get(edit.part) ?? new Set()).add(who));
  }
  return [...parts].map(([part, who]) => `${part} (${[...who].join(', ')})`).join('; ');
}

const VERB: Record<FilePlan['status'], [string, string]> = {
  create: ['created', 'would create'],
  update: ['updated', 'would update'],
  remove: ['removed', 'would remove'],
  unchanged: ['unchanged', 'unchanged'],
  refused: ['REFUSED', 'REFUSED'],
};

function report(plan: InitPlan, check: boolean): string {
  const width = Math.max(...plan.files.map(f => f.file.length));
  const lines = [`${TOOL} init in ${plan.root} for ${plan.agents.join(', ')}:`];
  for (const file of plan.files)
    lines.push(`  ${VERB[file.status][check ? 1 : 0].padEnd(12)} ${file.file.padEnd(width)}  ${role(file)}`);
  return `${lines.join('\n')}\n`;
}

async function init(args: string[], deps: AgentCliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      agents: { type: 'string' },
      all: { type: 'boolean', default: false },
      dir: { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  const root = projectRoot(deps.cwd, values.dir);
  const agents = await agentsToWire(values, root, deps);
  const plan = planInit(root, agents, listSkills(deps.skillsDir ?? SKILLS_DIR), deps.env);
  deps.stdout(report(plan, values.check));
  const refusals = plan.files.filter(f => f.status === 'refused');
  if (refusals.length > 0) {
    for (const file of refusals) deps.stderr(`${TOOL} init: ${file.reason ?? file.file}\n`);
    deps.stderr(
      `${TOOL} init: wrote nothing; fix ${refusals.length === 1 ? 'that file' : 'those files'} and run ${CLI} init again\n`,
    );
    return 1;
  }
  const changes = plan.files.filter(f => f.status === 'create' || f.status === 'update' || f.status === 'remove');
  if (values.check) {
    if (changes.length > 0) deps.stderr(`${TOOL} init --check: ${String(changes.length)} file(s) would change\n`);
    return changes.length > 0 ? 1 : 0;
  }
  const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const { backups } = applyInit(plan, path.join(stateDir(deps.env), 'init-backups', `${stamp}-${path.basename(root)}`));
  const toolkit = provideToolkit(root, deps.env, deps.install);
  const out: string[] = [...toolkit.notes];
  if (backups) out.push(`Backed up the files it changed in ${backups}.`);
  if (changes.length > 0)
    out.push(
      'Commit the files above: each agent reads them from the repository, and they hold no path or secret of this machine.',
    );
  else out.push('Nothing to change.');
  out.push('Next:');
  for (const agent of agents) out.push(`  ${agent}: ${NEXT[agent](plan.claudePlugin)}.`);
  if (findConfigFile(root) === null)
    out.push(`Then ask your agent: "Set this project up with ${TOOL}." Its setup skill writes ${CONFIG_FILE}.`);
  deps.stdout(`${out.join('\n')}\n`);
  if (toolkit.failed === null) return 0;
  const { command, dir, problem } = toolkit.failed;
  deps.stderr(
    `${TOOL} init: wrote the files above, but ${command} failed (${problem}), so ${CLI} is missing and the hooks and the MCP server can't start\nto fix: run ${command} in ${dir}\n`,
  );
  return 1;
}

function summary(description: string): string {
  const end = description.search(/\. |\s-\s/);
  return end === -1 ? description : description.slice(0, end);
}

function skills(args: string[], deps: AgentCliDeps): number {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
  const [verb, name, ...extra] = positionals;
  const all = listSkills(deps.skillsDir ?? SKILLS_DIR);
  if (verb === 'list' && name === undefined) {
    const width = Math.max(...all.map(s => s.name.length));
    for (const skill of all) deps.stdout(`${skill.name.padEnd(width)}  ${summary(skill.description)}\n`);
    return 0;
  }
  if (verb === 'get' && name !== undefined && extra.length === 0) {
    const skill = all.find(s => s.name === name);
    if (!skill) throw new UsageError(`there is no skill '${name}'`, `pass one of: ${all.map(s => s.name).join(', ')}`);
    deps.stdout(skill.body);
    return 0;
  }
  throw new UsageError(
    `'skills ${positionals.join(' ')}' is not a skills command`,
    `${CLI} skills list, or ${CLI} skills get <name>`,
  );
}

export async function runAgentCommand(command: string, args: string[], deps: AgentCliDeps): Promise<number> {
  try {
    switch (command) {
      case 'init':
        return await init(args, deps);
      case 'skills':
        return skills(args, deps);
    }
    deps.stderr(`${TOOL}: '${command}' is not an agent command\n\n${AGENT_USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${TOOL} ${command}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      deps.stderr(`${TOOL} ${command}: ${error.message}\n\n${commandUsage(AGENT_HELP, command as AgentCommand)}`);
      return 2;
    }
    throw error;
  }
}
