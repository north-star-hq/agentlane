import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CLI, FORMER, TOOL } from '../name.ts';

export const SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));

export interface Skill {
  name: string;
  description: string;
  frontmatter: string;
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

export function parseSkill(text: string, file: string): Skill {
  const match = FRONTMATTER.exec(text);
  if (!match?.[1]) throw new Error(`${file} has no frontmatter`);
  const fields = parse(match[1]) as { name?: unknown; description?: unknown } | null;
  if (typeof fields?.name !== 'string' || typeof fields.description !== 'string')
    throw new Error(`${file} needs a name and a description in its frontmatter`);
  return {
    name: fields.name,
    description: fields.description,
    frontmatter: match[1],
    body: text.slice(match[0].length).replace(/^\n+/, ''),
  };
}

export function listSkills(dir: string = SKILLS_DIR): Skill[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort()
    .map(name => {
      const file = path.join(dir, name, 'SKILL.md');
      const skill = parseSkill(fs.readFileSync(file, 'utf8'), file);
      if (skill.name !== name) throw new Error(`${file} names itself ${skill.name}, not ${name}`);
      return skill;
    });
}

export function fetchCommand(name: string, cli: string = CLI): string {
  return `${cli} skills get ${name}`;
}

export const SETUP_SKILL = 'setup';

export function setupFix(byHand: string): string {
  return `${byHand}; or let an agent do it with the ${SETUP_SKILL} skill: /${TOOL}:${SETUP_SKILL} in Claude Code with the plugin, and in any agent, ask it to run '${fetchCommand(SETUP_SKILL)}' at the project root and follow what it prints`;
}

export function stubOf(skill: Skill): string {
  return `---
${skill.frontmatter}
---

Run \`${fetchCommand(skill.name)}\` from the project root and follow what it prints. It prints this skill for the version of the toolkit installed in this project.
`;
}

export function isStubOf(text: string, name: string): boolean {
  try {
    const skill = parseSkill(text, name);
    return skill.name === name && [CLI, FORMER.cli].some(cli => skill.body.includes(fetchCommand(name, cli)));
  } catch {
    return false;
  }
}
