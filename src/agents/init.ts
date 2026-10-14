import fs from 'node:fs';
import path from 'node:path';
import { CLI, TOOL } from '../name.ts';
import type { Agent } from '../registry/owner.ts';
import type { PluginSource } from './claude-plugin.ts';
import { claudePluginSource, jsonObjectAt } from './claude-plugin.ts';
import type { Skill } from './skills.ts';
import { removeTable, upsertTable } from './toml.ts';
import type { Edit, Json } from './wiring.ts';
import { agentEdits, formerServerIn, mirrorEdit, SKILLS, stubEdits, unlinkEdit } from './wiring.ts';
import { isStubOf, parseSkill } from './skills.ts';

export type FileStatus = 'create' | 'update' | 'remove' | 'unchanged' | 'refused';

export type Desired = { kind: 'text'; text: string } | { kind: 'link'; target: string };

export interface FilePlan {
  file: string;
  status: FileStatus;
  reason: string | null;
  desired: Desired | null;
  edits: Edit[];
}

export interface InitPlan {
  root: string;
  agents: Agent[];
  claudePlugin: PluginSource | null;
  files: FilePlan[];
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function indentOf(text: string): string | number {
  const indented = /\n([ \t]+)\S/.exec(text);
  const unit = indented?.[1];
  if (unit === undefined) return 2;
  return unit.startsWith('\t') ? '\t' : unit.length;
}

function readJson(text: string | null): Json | string {
  if (text === null || text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `it isn't valid JSON (${(error as Error).message})`;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'it holds JSON that is not an object';
  return value as Json;
}

function refused(file: string, edits: Edit[], reason: string): FilePlan {
  return {
    file,
    status: 'refused',
    reason: `${file}: ${reason}; init leaves a file it can't merge into untouched`,
    desired: null,
    edits,
  };
}

function planJson(root: string, file: string, edits: Edit[]): FilePlan {
  const text = readText(path.join(root, file));
  const doc = readJson(text);
  if (typeof doc === 'string') return refused(file, edits, doc);
  const before = JSON.stringify(doc);
  const next = structuredClone(doc);
  for (const edit of edits) {
    if (edit.kind !== 'json') continue;
    const problem = edit.apply(next);
    if (problem !== null) return refused(file, edits, problem);
  }
  if (text !== null && JSON.stringify(next) === before) return { file, status: 'unchanged', reason: null, desired: null, edits };
  if (edits.some(edit => edit.kind === 'json' && edit.emptied?.(next) === true)) {
    return text === null
      ? { file, status: 'unchanged', reason: null, desired: null, edits }
      : { file, status: 'remove', reason: null, desired: null, edits };
  }
  return {
    file,
    status: text === null ? 'create' : 'update',
    reason: null,
    desired: { kind: 'text', text: `${JSON.stringify(next, null, text === null ? 2 : indentOf(text))}\n` },
    edits,
  };
}

function planToml(root: string, file: string, edits: Edit[]): FilePlan {
  const text = readText(path.join(root, file));
  let next = text ?? '';
  let changed = text === null;
  for (const edit of edits) {
    if (edit.kind !== 'toml') continue;
    const result = edit.body === null ? removeTable(next, edit.table) : upsertTable(next, edit.table, edit.body);
    if (result.kind === 'refused') return refused(file, edits, result.reason);
    if (result.kind === 'changed') {
      next = result.text;
      changed = true;
    }
  }
  if (!changed) return { file, status: 'unchanged', reason: null, desired: null, edits };
  return { file, status: text === null ? 'create' : 'update', reason: null, desired: { kind: 'text', text: next }, edits };
}

function planStub(root: string, edit: Edit & { kind: 'stub' }): FilePlan {
  const text = readText(path.join(root, edit.file));
  const desired: Desired = { kind: 'text', text: edit.content };
  if (text === null) return { file: edit.file, status: 'create', reason: null, desired, edits: [edit] };
  if (text === edit.content) return { file: edit.file, status: 'unchanged', reason: null, desired: null, edits: [edit] };
  if (isStubOf(text, edit.skill)) return { file: edit.file, status: 'update', reason: null, desired, edits: [edit] };
  return refused(edit.file, [edit], `it holds a different skill named ${edit.skill}; rename one of them`);
}

function onlySkillFile(dir: string): string | null {
  const entries = fs.readdirSync(dir);
  if (entries.length !== 1 || entries[0] !== 'SKILL.md') return null;
  return readText(path.join(dir, 'SKILL.md'));
}

function planLink(root: string, edit: Edit & { kind: 'link' }): FilePlan {
  const at = path.join(root, edit.file);
  const desired: Desired = { kind: 'link', target: edit.target };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(at);
  } catch {
    return { file: edit.file, status: 'create', reason: null, desired, edits: [edit] };
  }
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(at);
    if (target === edit.target) return { file: edit.file, status: 'unchanged', reason: null, desired: null, edits: [edit] };
    return refused(edit.file, [edit], `it is a link to ${target}, not to ${edit.target}`);
  }
  const copy = stat.isDirectory() ? onlySkillFile(at) : null;
  if (copy !== null && (copy === edit.source || isStubOf(copy, edit.skill)))
    return { file: edit.file, status: 'update', reason: null, desired, edits: [edit] };
  return refused(
    edit.file,
    [edit],
    `it holds its own copy of the ${edit.skill} skill; keep one copy, in ${SKILLS}/${edit.skill}/, and run ${CLI} init again`,
  );
}

function planUnlink(root: string, edit: Edit & { kind: 'unlink' }): FilePlan | null {
  const at = path.join(root, edit.file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(at);
  } catch {
    return null;
  }
  const ours = stat.isSymbolicLink()
    ? fs.readlinkSync(at) === edit.target
    : stat.isDirectory() && isStubOf(onlySkillFile(at) ?? '', edit.skill);
  return ours ? { file: edit.file, status: 'remove', reason: null, desired: null, edits: [edit] } : null;
}

function projectSkills(root: string, toolkit: ReadonlySet<string>): { name: string; source: string }[] {
  const dir = path.join(root, SKILLS);
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap(name => {
    if (toolkit.has(name)) return [];
    const source = readText(path.join(dir, name, 'SKILL.md'));
    if (source === null) return [];
    try {
      parseSkill(source, name);
    } catch {
      return [];
    }
    return [{ name, source }];
  });
}

function mcpServerIn(root: string): boolean {
  const servers = jsonObjectAt(path.join(root, '.mcp.json'))?.mcpServers;
  return (typeof servers === 'object' && servers !== null && TOOL in servers) || formerServerIn(servers);
}

export function planInit(root: string, agents: readonly Agent[], skills: readonly Skill[], env: NodeJS.ProcessEnv): InitPlan {
  const claudePlugin = agents.includes('claude') ? claudePluginSource(root, env) : null;
  const stubs = agents.some(agent => agent !== 'claude') || claudePlugin === null ? stubEdits(skills) : [];
  const disableServer =
    claudePlugin !== null && (claudePlugin.kind !== 'project' || agents.includes('copilot') || mcpServerIn(root));
  const edits: Edit[] = [...stubs, ...agents.flatMap(agent => agentEdits(agent, claudePlugin !== null, disableServer))];
  if (agents.includes('claude')) {
    if (claudePlugin) for (const skill of skills) edits.push(unlinkEdit(skill.name));
    else for (const stub of stubs) if (stub.kind === 'stub') edits.push(mirrorEdit(stub.skill, stub.content));
    for (const own of projectSkills(root, new Set(skills.map(s => s.name)))) edits.push(mirrorEdit(own.name, own.source));
  }
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  const files = [...byFile].flatMap(([file, group]): FilePlan[] => {
    const [first] = group;
    if (first?.kind === 'stub') return [planStub(root, first)];
    if (first?.kind === 'link') return [planLink(root, first)];
    if (first?.kind === 'unlink') {
      const removal = planUnlink(root, first);
      return removal ? [removal] : [];
    }
    if (first?.kind === 'toml') return [planToml(root, file, group)];
    const plan = planJson(root, file, group);
    const cleanupOnly = group.every(edit => edit.kind === 'json' && edit.cleanup === true);
    return cleanupOnly && plan.status === 'unchanged' ? [] : [plan];
  });
  return { root, agents: [...agents], claudePlugin, files };
}

function backup(root: string, file: string, into: string): void {
  const from = path.join(root, file);
  try {
    fs.lstatSync(from);
  } catch {
    return;
  }
  const to = path.join(into, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

export function applyInit(plan: InitPlan, backupDir: string): { written: FilePlan[]; backups: string | null } {
  if (plan.files.some(f => f.status === 'refused')) throw new Error('a refused plan is never applied');
  const written = plan.files.filter(f => f.status === 'create' || f.status === 'update' || f.status === 'remove');
  let backed = false;
  for (const file of written) {
    if (file.status !== 'create') {
      backup(plan.root, file.file, backupDir);
      backed = true;
    }
    const at = path.join(plan.root, file.file);
    if (file.status === 'remove') {
      fs.rmSync(at, { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(at), { recursive: true });
    const desired = file.desired;
    if (desired?.kind === 'link') {
      fs.rmSync(at, { recursive: true, force: true });
      fs.symlinkSync(desired.target, at);
    } else if (desired?.kind === 'text') {
      fs.writeFileSync(at, desired.text);
    }
  }
  return { written, backups: backed ? backupDir : null };
}
