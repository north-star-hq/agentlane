/** One element of a page's accessibility snapshot, as playwright-cli and agent-browser print it. */
export interface AriaNode {
  role: string;
  name: string;
  ref: string | null;
  /** Bracketed states and values: level=1, checked, disabled, cursor=pointer. */
  attributes: Record<string, string | true>;
  /** Inline text after the colon, and `/url:`-style properties of the node. */
  text: string | null;
  props: Record<string, string>;
  children: AriaNode[];
}

const LINE = /^(\s*)- (.*)$/;

function unquoteName(raw: string): { name: string; rest: string } {
  if (!raw.startsWith('"')) return { name: '', rest: raw };
  let i = 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\') i += 2;
    else if (ch === '"') break;
    else i += 1;
  }
  const literal = raw.slice(0, i + 1);
  let name: string;
  try {
    name = JSON.parse(literal) as string;
  } catch {
    name = literal.slice(1, -1);
  }
  return { name, rest: raw.slice(i + 1) };
}

function parseAttributes(rest: string, into: Record<string, string | true>): string {
  let text = rest.trimStart();
  for (;;) {
    const match = /^\[([^\]]*)\]\s*/.exec(text);
    if (!match) return text;
    for (const part of (match[1] ?? '').split(',')) {
      const item = part.trim();
      if (item === '') continue;
      const at = item.indexOf('=');
      if (at === -1) into[item] = true;
      else into[item.slice(0, at)] = item.slice(at + 1);
    }
    text = text.slice(match[0].length);
  }
}

function parseItem(body: string): AriaNode | { prop: string; value: string } {
  if (body.startsWith('/')) {
    const at = body.indexOf(':');
    return { prop: at === -1 ? body.slice(1) : body.slice(1, at), value: at === -1 ? '' : body.slice(at + 1).trim() };
  }
  const roleMatch = /^([A-Za-z][\w-]*)/.exec(body);
  const role = roleMatch?.[1] ?? 'text';
  let rest = roleMatch ? body.slice(role.length) : body;
  if (rest.startsWith(':') && role === 'text') {
    return { role, name: '', ref: null, attributes: {}, text: rest.slice(1).trim(), props: {}, children: [] };
  }
  const { name, rest: afterName } = unquoteName(rest.trimStart());
  const attributes: Record<string, string | true> = {};
  rest = parseAttributes(afterName, attributes);
  let text: string | null = null;
  if (rest.startsWith(':')) {
    const tail = rest.slice(1).trim();
    if (tail !== '') text = tail.startsWith('"') ? unquoteName(tail).name : tail;
  }
  const ref = typeof attributes.ref === 'string' ? attributes.ref : null;
  delete attributes.ref;
  return { role, name, ref, attributes, text, props: {}, children: [] };
}

/** Parses the YAML-like accessibility snapshot both drivers print: `- role "name" [attr] [ref=e2]: text`, nested by indentation. */
export function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const roots: AriaNode[] = [];
  const stack: { indent: number; node: AriaNode }[] = [];
  for (const raw of snapshot.split('\n')) {
    const match = LINE.exec(raw.replace(/\r$/, ''));
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const item = parseItem(match[2] ?? '');
    while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop();
    const parent = stack.at(-1)?.node;
    if ('prop' in item) {
      if (parent) parent.props[item.prop] = item.value;
      continue;
    }
    if (parent) parent.children.push(item);
    else roots.push(item);
    stack.push({ indent, node: item });
  }
  return roots;
}

export const INTERACTIVE_ARIA_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'tab',
  'treeitem',
]);

export interface BrowserLookOptions {
  interactiveOnly?: boolean;
  /** A ref or a name, matched in full ignoring case, naming the element whose subtree to show. */
  within?: string;
  depth?: number;
}

export interface BrowserLook {
  text: string;
  lines: string[];
  shown: number;
  interactive: number;
}

const LIMIT = 120;

function quote(text: string): string {
  return JSON.stringify(text.length > LIMIT ? `${text.slice(0, LIMIT)}…` : text);
}

function describe(node: AriaNode): string {
  const parts = [`[${node.role}]`];
  if (node.ref !== null) parts.push(`ref=${node.ref}`);
  if (node.name !== '') parts.push(quote(node.name));
  if (node.text !== null && node.text !== node.name) parts.push(`text=${quote(node.text)}`);
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key === 'cursor' || key === 'active') continue;
    parts.push(value === true ? key : `${key}=${value}`);
  }
  if (node.props.url !== undefined) parts.push(`url=${node.props.url}`);
  return parts.join(' ');
}

function shows(node: AriaNode): boolean {
  if (node.role === 'text') return node.text !== null && node.text !== '';
  return node.ref !== null || node.name !== '' || node.text !== null;
}

function matchesWithin(node: AriaNode, within: string): boolean {
  return node.ref === within || node.name.toLowerCase() === within.toLowerCase();
}

function findWithin(nodes: readonly AriaNode[], within: string): AriaNode | undefined {
  for (const node of nodes) {
    if (matchesWithin(node, within)) return node;
    const inside = findWithin(node.children, within);
    if (inside) return inside;
  }
  return undefined;
}

/**
 * Renders a page the way `look` renders a device screen: one line per element, indented by nesting, refs where a
 * device read has ids. Unnamed containers without a ref are skipped and their children shown in their place.
 */
export function lookAtPage(
  page: { url: string; title: string; tree: readonly AriaNode[] },
  options: BrowserLookOptions = {},
): BrowserLook {
  const notes: string[] = [];
  let roots = page.tree;
  if (options.within !== undefined) {
    const found = findWithin(page.tree, options.within);
    if (found) roots = [found];
    else notes.push(`Nothing on the page has the ref or name ${JSON.stringify(options.within)}; showing the whole page.`);
  }
  const lines: string[] = [];
  let interactive = 0;
  const walk = (nodes: readonly AriaNode[], depth: number) => {
    for (const node of nodes) {
      const isInteractive = INTERACTIVE_ARIA_ROLES.has(node.role);
      if (isInteractive) interactive += 1;
      const picked = shows(node) && (!options.interactiveOnly || isInteractive);
      if (picked && (options.depth === undefined || depth < options.depth)) lines.push(`${'  '.repeat(depth)}${describe(node)}`);
      walk(node.children, picked ? depth + 1 : depth);
    }
  };
  walk(roots, 0);
  if (lines.length === 0)
    notes.push(
      options.interactiveOnly ? 'Nothing interactive is on the page.' : 'Nothing on the page has a role, a name or text.',
    );
  const header = `Page: ${page.title === '' ? '(no title)' : quote(page.title)} at ${page.url}`;
  return { text: [header, ...notes, ...lines].join('\n'), lines, shown: lines.length, interactive };
}
