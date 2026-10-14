import fs from 'node:fs';
import path from 'node:path';
import { AGENT_HELP } from '../../src/agents/cli.ts';
import { BENCH_HELP } from '../../src/bench-cli.ts';
import { DRIVER_HELP } from '../../src/driver-cli.ts';
import { TOOLS } from '../../src/mcp/tools.ts';
import { HOOK_HELP } from '../../src/plugin/hook-cli.ts';
import { REGISTRY_HELP } from '../../src/registry-cli.ts';
import { UP_HELP } from '../../src/up-cli.ts';
import type { UsageGroup } from '../../src/usage.ts';
import { REPO } from './paths.ts';

export const HELP_GROUPS: readonly { key: string; group: UsageGroup<string> }[] = [
  { key: 'lanes', group: REGISTRY_HELP },
  { key: 'environment', group: UP_HELP },
  { key: 'driving', group: DRIVER_HELP },
  { key: 'hooks', group: HOOK_HELP },
  { key: 'agents', group: AGENT_HELP },
  { key: 'bench', group: BENCH_HELP },
];

export interface Command {
  name: string;
  help: string;
}

export function commands(): Command[] {
  return HELP_GROUPS.flatMap(({ group }) =>
    Object.entries(group.entries).map(([name, help]) => ({ name, help: help + (group.footer ?? '') })),
  );
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|');
}

function prose(text: string): string {
  return text
    .split(
      /(--[a-z][a-z-]*(?: <[^>]+>)?|\$?AGENTLANE_[A-Z0-9_]*(?:<[A-Z]+>[A-Z0-9_]*)?|[A-Z0-9_]*<[^>\s]+(?: [^>\s]+)*>[A-Z0-9_]*)/,
    )
    .map((part, i) => (i % 2 === 1 ? code(part) : part.replaceAll('*', '\\*')))
    .join('');
}

/** Applies `prose` to the parts of a description that aren't already code spans. */
function proseOutsideCode(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : prose(part)))
    .join('');
}

function code(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

interface Row {
  name: string;
  text: string;
  column: number;
}

export type HelpBlock = { kind: 'text'; text: string } | { kind: 'forms' | 'flags'; rows: Row[] };

const INDENT = /^( *)(.*)$/;

function splitColumns(rest: string, indent: number): Row {
  const gap = /\s{2,}/.exec(rest);
  if (!gap) return { name: rest.trim(), text: '', column: Number.POSITIVE_INFINITY };
  return {
    name: rest.slice(0, gap.index),
    text: rest.slice(gap.index + gap[0].length),
    column: indent + gap.index + gap[0].length,
  };
}

interface ParseState {
  row: Row | null;
  paragraph: { kind: 'text'; text: string } | null;
  textColumn: number;
}

/** Reads one command's help as `agentlane <command> --help` prints it, in order: its paragraphs, forms and flags. */
export function parseHelp(name: string, help: string): HelpBlock[] {
  const blocks: HelpBlock[] = [];
  const state: ParseState = { row: null, paragraph: null, textColumn: Number.POSITIVE_INFINITY };
  const add = (kind: 'forms' | 'flags', next: Row) => {
    const last = blocks.at(-1);
    if (last?.kind === kind) last.rows.push(next);
    else blocks.push({ kind, rows: [next] });
    state.row = next;
    state.paragraph = null;
  };
  const startParagraph = (text: string) => {
    state.paragraph = { kind: 'text', text };
    blocks.push(state.paragraph);
    state.row = null;
  };
  for (const line of help.split('\n')) {
    if (line.trim() === '') continue;
    const [, spaces = '', rest = ''] = INDENT.exec(line) ?? [];
    const indent = spaces.length;
    if (indent <= 2 && (rest === name || rest.startsWith(`${name} `))) {
      const head = splitColumns(rest, indent);
      if (head.name === name || !head.name.startsWith(`${name} `) || /^\S+ [A-Z]/.test(head.name)) {
        const text = rest.slice(name.length).trim();
        state.textColumn = indent + rest.indexOf(text);
        startParagraph(text);
      } else {
        add('forms', head);
      }
    } else if (indent <= 2) {
      startParagraph(rest);
    } else if (rest.startsWith('--')) {
      add('flags', splitColumns(rest, indent));
    } else if (rest.startsWith(`${name} `) && indent > state.textColumn) {
      add('forms', splitColumns(rest, indent));
    } else if (state.row !== null && indent >= state.row.column) {
      state.row.text = `${state.row.text} ${rest}`.trim();
    } else if (state.paragraph !== null) {
      state.paragraph.text = `${state.paragraph.text} ${rest}`.trim();
    } else {
      startParagraph(rest);
    }
  }
  return blocks.filter(b => b.kind !== 'text' || b.text !== '');
}

function commandMarkdown(command: Command): string {
  const parts = [`### agentlane ${command.name}`];
  for (const block of parseHelp(command.name, command.help)) {
    if (block.kind === 'text') {
      parts.push(prose(block.text));
    } else if (block.kind === 'forms') {
      parts.push(
        block.rows
          .map(
            r =>
              `- ${code(`agentlane ${r.name}`)}${r.text === '' ? '' : `${r.text.startsWith('(') ? ' ' : ': '}${prose(r.text)}`}`,
          )
          .join('\n'),
      );
    } else {
      parts.push(
        [
          '| Flag | What it does |',
          '| --- | --- |',
          ...block.rows.map(r => `| ${cell(code(r.name))} | ${cell(prose(r.text))} |`),
        ].join('\n'),
      );
    }
  }
  return parts.join('\n\n');
}

function cliMarkdown(key: string): string {
  const entry = HELP_GROUPS.find(g => g.key === key);
  if (!entry) throw new Error(`no CLI group '${key}'; the groups are ${HELP_GROUPS.map(g => g.key).join(', ')}`);
  const footer = entry.group.footer?.trim();
  const body = Object.entries(entry.group.entries).map(([name, help]) => commandMarkdown({ name, help }));
  return [...(footer ? [prose(footer)] : []), ...body].join('\n\n');
}

interface SchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode | false;
  prefixItems?: SchemaNode[];
  required?: string[];
  oneOf?: SchemaNode[];
  $ref?: string;
}

interface Schema extends SchemaNode {
  $defs: Record<string, SchemaNode>;
}

function loadSchema(): Schema {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'schema', 'agentlane.schema.json'), 'utf8')) as Schema;
}

function resolve(schema: Schema, node: SchemaNode): SchemaNode {
  if (!node.$ref) return node;
  const name = node.$ref.replace('#/$defs/', '');
  const target = schema.$defs[name];
  if (!target) throw new Error(`the schema has no $defs/${name}`);
  return target;
}

function typeOf(schema: Schema, raw: SchemaNode): string {
  const node = resolve(schema, raw);
  if (node.enum) return node.enum.map(v => JSON.stringify(v)).join(' or ');
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.oneOf) return node.oneOf.map(n => (n.$ref ? n.$ref.replace('#/$defs/', '') : typeOf(schema, n))).join(' or ');
  if (node.prefixItems) return `[${node.prefixItems.map(n => typeOf(schema, n)).join(', ')}]`;
  if (node.type === 'array' && node.items) return `array of ${typeOf(schema, node.items)}`;
  if (node.type === 'object' && typeof node.additionalProperties === 'object') return 'object by name';
  if (Array.isArray(node.type)) return node.type.join(' or ');
  return node.type ?? 'object';
}

function fieldRows(schema: Schema, node: SchemaNode, prefix: string, depth: number): string[] {
  const rows: string[] = [];
  const required = new Set(node.required ?? []);
  for (const [key, raw] of Object.entries(node.properties ?? {})) {
    const field = resolve(schema, raw);
    const name = `${prefix}${key}`;
    const described = field.description ?? raw.description;
    const nested = Object.keys(field.properties ?? {});
    const fallback =
      nested.length === 0 ? '' : depth > 0 && !raw.$ref ? 'Its fields follow.' : `Fields: ${nested.map(code).join(', ')}.`;
    const notes = [described === undefined ? fallback : proseOutsideCode(described)];
    if (field.default !== undefined) notes.push(`Default: ${code(JSON.stringify(field.default))}.`);
    rows.push(
      `| ${code(name)} | ${cell(code(typeOf(schema, raw)))} | ${required.has(key) ? 'Yes' : 'No'} | ${cell(notes.filter(Boolean).join(' '))} |`,
    );
    if (depth > 0 && field.properties && !raw.$ref) rows.push(...fieldRows(schema, field, `${name}.`, depth - 1));
  }
  return rows;
}

function table(rows: string[]): string {
  return ['| Field | Type | Required | What it is |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

const CONFIG_NODES: Record<string, (schema: Schema) => { node: SchemaNode; prefix: string }> = {
  top: schema => ({ node: schema, prefix: '' }),
  app: schema => ({ node: resolve(schema, { $ref: '#/$defs/app' }), prefix: 'app.' }),
  web: schema => ({ node: resolve(schema, { $ref: '#/$defs/web' }), prefix: 'web.' }),
  browser: schema => ({ node: resolve(schema, { $ref: '#/$defs/browser' }), prefix: 'web.browser.' }),
  service: schema => ({ node: resolve(schema, { $ref: '#/$defs/service' }), prefix: 'services.<name>.' }),
  'ready-http': schema => ({ node: resolve(schema, { $ref: '#/$defs/httpReady' }), prefix: 'ready.' }),
  'ready-tcp': schema => ({ node: resolve(schema, { $ref: '#/$defs/tcpReady' }), prefix: 'ready.' }),
  resource: schema => ({ node: resolve(schema, { $ref: '#/$defs/resource' }), prefix: 'resources.<name>.' }),
  hooks: schema => ({ node: resolve(schema, { $ref: '#/$defs/hooks' }), prefix: 'hooks.' }),
  precondition: schema => ({ node: resolve(schema, { $ref: '#/$defs/precondition' }), prefix: 'preconditions[].' }),
  hygiene: schema => ({ node: resolve(schema, { $ref: '#/$defs/hygiene' }), prefix: 'hygiene.' }),
  buildCache: schema => ({ node: resolve(schema, schema.properties?.buildCache ?? {}), prefix: 'buildCache.' }),
  'cache-files': schema => ({ node: cacheInput(schema, 'files'), prefix: 'buildCache.inputs[].' }),
  'cache-command': schema => ({ node: cacheInput(schema, 'command'), prefix: 'buildCache.inputs[].' }),
  driver: schema => ({ node: resolve(schema, { $ref: '#/$defs/driver' }), prefix: 'driver.' }),
};

function cacheInput(schema: Schema, kind: string): SchemaNode {
  const items = schema.properties?.buildCache?.properties?.inputs?.items;
  const found = items ? items.oneOf?.find(n => n.properties?.kind?.const === kind) : undefined;
  if (!found) throw new Error(`the schema's buildCache.inputs has no '${kind}' input`);
  return found;
}

export const CONFIG_TABLES = Object.keys(CONFIG_NODES);

function configMarkdown(key: string): string {
  const pick = CONFIG_NODES[key];
  if (!pick) throw new Error(`no config table '${key}'; the tables are ${CONFIG_TABLES.join(', ')}`);
  const schema = loadSchema();
  const { node, prefix } = pick(schema);
  const depth = key === 'top' ? 0 : 1;
  return table(fieldRows(schema, node, prefix, depth));
}

function mcpMarkdown(name: string): string {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`no MCP tool '${name}'; the tools are ${TOOLS.map(t => t.name).join(', ')}`);
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, SchemaNode>;
  const rows = Object.entries(properties).map(([key, p]) => {
    const type = p.type === 'object' && p.properties ? `{ ${Object.keys(p.properties).join(', ')} }` : String(p.type);
    return `| ${code(key)} | ${code(type)} | ${cell(p.description ?? '')} |`;
  });
  const title = typeof tool.annotations.title === 'string' ? tool.annotations.title : tool.name;
  const readOnly = tool.annotations.readOnlyHint === true ? 'It only reads.' : 'It acts on the app.';
  return [
    `### ${tool.name}`,
    prose(tool.description),
    `Its title is "${title}". ${readOnly}`,
    ['| Argument | Type | What it is |', '| --- | --- | --- |', ...rows].join('\n'),
  ].join('\n\n');
}

export const MCP_TOOLS = TOOLS.map(t => t.name);

const DIRECTIVE = /^<!-- generated: ([a-z]+) ([A-Za-z-]+) -->$/gm;

/** Replaces each `<!-- generated: <kind> <name> -->` line with Markdown made from the source it names. */
export function expandGenerated(markdown: string): string {
  return markdown.replace(DIRECTIVE, (_, kind: string, name: string) => {
    if (kind === 'cli') return cliMarkdown(name);
    if (kind === 'config') return configMarkdown(name);
    if (kind === 'mcp') return mcpMarkdown(name);
    throw new Error(`unknown generated block '${kind}'`);
  });
}

export function generatedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(DIRECTIVE)].map(m => `${m[1] ?? ''} ${m[2] ?? ''}`);
}

/** What a reference page leaves out of the source it documents: a CLI group, command or flag, an MCP tool, a config section. */
export function referenceGaps(page: 'cli' | 'mcp' | 'config', markdown: string): string[] {
  const blocks = new Set(generatedBlocks(markdown));
  if (page === 'mcp') return MCP_TOOLS.filter(tool => !blocks.has(`mcp ${tool}`)).map(tool => `the MCP tool ${tool}`);
  if (page === 'config') {
    const schema = loadSchema();
    const sections = Object.keys(schema.properties ?? {})
      .filter(key => key !== '$schema' && !new RegExp(`^## ${key.replace('$', '\\$')}$`, 'm').test(markdown))
      .map(key => `the config section ${key}`);
    const tables = CONFIG_TABLES.filter(key => !blocks.has(`config ${key}`)).map(key => `the config table ${key}`);
    return [...sections, ...tables];
  }
  const gaps = HELP_GROUPS.filter(g => !blocks.has(`cli ${g.key}`)).map(g => `the CLI group ${g.key}`);
  const expanded = expandGenerated(markdown);
  for (const command of commands()) {
    if (!expanded.includes(`### agentlane ${command.name}\n`)) {
      gaps.push(`the command ${command.name}`);
      continue;
    }
    for (const flag of new Set(command.help.match(/--[a-z][a-z-]*/g) ?? [])) {
      if (!new RegExp(`${flag}(?![a-z-])`).test(expanded)) gaps.push(`${command.name} ${flag}`);
    }
  }
  return gaps;
}
