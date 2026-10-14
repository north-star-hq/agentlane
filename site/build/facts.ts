import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './paths.ts';
import { commands } from './reference.ts';

export interface PageSource {
  file: string;
  markdown: string;
}

/** Set by the session-end hook for the detached process that does the release; nobody sets them by hand. */
export const INTERNAL_VARIABLES = ['AGENTLANE_SESSION_END_OWNER', 'AGENTLANE_SESSION_END_WAIT_MS'];

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => path.join(entry.parentPath, entry.name));
}

/** Every AGENTLANE_ variable the source names through `envName`, which is how the toolkit names each one. */
export function sourceVariables(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(path.join(REPO, 'src'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/envName\('([A-Z][A-Z0-9_]*)'\)/g)) {
      names.add(`AGENTLANE_${match[1] ?? ''}`);
    }
  }
  return names;
}

const PORT_VARIABLE = /^AGENTLANE_[A-Z0-9_]+_PORT$/;

interface CodeSegment {
  text: string;
  /** Output and prose, where only a written-out path or `npx` marks a command. */
  output: boolean;
}

const CONFIG_LANGUAGES = new Set(['json', 'jsonc', 'toml', 'js', 'ts', 'yaml']);

function codeSegments(markdown: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  const withoutFences = markdown.replace(
    /^(`{3,})([^\n]*)\n([\s\S]*?)^\1\s*$/gm,
    (_, _fence: string, info: string, body: string) => {
      const lang = info.trim().split(/\s+/)[0] ?? '';
      if (!CONFIG_LANGUAGES.has(lang)) segments.push(...body.split('\n').map(text => ({ text, output: lang === 'text' })));
      return '';
    },
  );
  for (const match of withoutFences.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g))
    segments.push({ text: match[2] ?? '', output: false });
  return segments;
}

const INVOCATION = /(?:^|[\s"'(=$])(node_modules\/\.bin\/|npx )?agentlane ([a-z][a-z-]*)(?![a-z-]|:)([^\n]*)/g;

/** Names each command, flag and AGENTLANE_ variable in the pages that this branch's CLI and source don't have. */
export function checkFacts(pages: readonly PageSource[]): string[] {
  const problems: string[] = [];
  const help = new Map(commands().map(c => [c.name, c.help]));
  const variables = sourceVariables();
  for (const { file, markdown } of pages) {
    for (const segment of codeSegments(markdown)) {
      for (const match of segment.text.matchAll(INVOCATION)) {
        if (segment.output && match[1] === undefined) continue;
        const command = match[2] ?? '';
        const text = help.get(command);
        if (text === undefined) {
          problems.push(`${file}: agentlane ${command} is not a command in agentlane --help`);
          continue;
        }
        const own = (match[3] ?? '').split(/ -- |\s[|;&]+\s|\)/)[0] ?? '';
        for (const flag of own.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)) {
          const name = flag[1] ?? '';
          if (name === '--help') continue;
          if (!new RegExp(`${name}(?![a-z-])`).test(text)) problems.push(`${file}: agentlane ${command} has no ${name} flag`);
        }
      }
    }
    for (const match of markdown.matchAll(/AGENTLANE_[A-Z0-9_]*[A-Z0-9]/g)) {
      const name = match[0];
      if (!variables.has(name) && !PORT_VARIABLE.test(name))
        problems.push(`${file}: ${name} is not a variable the source sets or reads`);
    }
  }
  return [...new Set(problems)];
}

/** The source's variables that the environment page doesn't name. */
export function undocumentedVariables(environmentPage: string): string[] {
  return [...sourceVariables()].filter(name => !INTERNAL_VARIABLES.includes(name) && !environmentPage.includes(name)).sort();
}
