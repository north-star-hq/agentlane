export class TomlError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${String(line)}: ${message}`);
    this.name = 'TomlError';
    this.line = line;
  }
}

export interface TomlHeader {
  path: string[];
  array: boolean;
  line: number;
}

export interface TomlKey {
  path: string[];
  table: string[];
  line: number;
  /** The line its value ends on. */
  end: number;
  /** Its value as written. */
  value: string;
}

export interface TomlOutline {
  headers: TomlHeader[];
  keys: TomlKey[];
}

const BARE = /[A-Za-z0-9_-]/;
const SCALAR = /[A-Za-z0-9_+\-.:]/;

class Scanner {
  private pos = 0;
  private line = 1;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private peek(offset = 0): string {
    return this.text[this.pos + offset] ?? '';
  }

  private startsWith(token: string): boolean {
    return this.text.startsWith(token, this.pos);
  }

  private fail(message: string, line = this.line): never {
    throw new TomlError(line, message);
  }

  private advance(count = 1): void {
    for (let i = 0; i < count; i++) {
      if (this.text[this.pos] === '\n') this.line++;
      this.pos++;
    }
  }

  private spaces(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.advance();
  }

  private comment(): void {
    if (this.peek() !== '#') return;
    while (this.pos < this.text.length && this.peek() !== '\n') this.advance();
  }

  private newline(): boolean {
    if (this.peek() === '\n') {
      this.advance();
      return true;
    }
    if (this.startsWith('\r\n')) {
      this.advance(2);
      return true;
    }
    return false;
  }

  private gap(): void {
    for (;;) {
      this.spaces();
      this.comment();
      if (!this.newline()) return;
    }
  }

  private endOfLine(): void {
    this.spaces();
    this.comment();
    if (this.pos < this.text.length && !this.newline()) this.fail(`unexpected '${this.peek()}' after a value`);
  }

  private basic(): string {
    this.advance();
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === '' || c === '\n') this.fail('a string is not closed');
      if (c === '"') {
        this.advance();
        return out;
      }
      if (c === '\\') {
        out += this.peek(1);
        this.advance(2);
        continue;
      }
      out += c;
      this.advance();
    }
  }

  private literal(): string {
    this.advance();
    const end = this.text.indexOf("'", this.pos);
    const newline = this.text.indexOf('\n', this.pos);
    if (end === -1 || (newline !== -1 && newline < end)) this.fail('a string is not closed');
    const out = this.text.slice(this.pos, end);
    this.advance(end - this.pos + 1);
    return out;
  }

  private multiline(quote: string): void {
    const start = this.line;
    this.advance(3);
    for (;;) {
      if (this.pos >= this.text.length) this.fail('a multi-line string is not closed', start);
      if (quote === '"""' && this.peek() === '\\') {
        this.advance(2);
        continue;
      }
      if (this.startsWith(quote)) {
        this.advance(3);
        while (this.peek() === quote[0]) this.advance();
        return;
      }
      this.advance();
    }
  }

  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.spaces();
      const c = this.peek();
      if (c === '"') parts.push(this.basic());
      else if (c === "'") parts.push(this.literal());
      else if (BARE.test(c)) {
        let part = '';
        while (BARE.test(this.peek())) {
          part += this.peek();
          this.advance();
        }
        parts.push(part);
      } else this.fail(c === '' ? 'a key is missing' : `'${c}' can't start a key`);
      this.spaces();
      if (this.peek() !== '.') return parts;
      this.advance();
    }
  }

  private value(): void {
    const c = this.peek();
    if (this.startsWith('"""') || this.startsWith("'''")) this.multiline(this.text.slice(this.pos, this.pos + 3));
    else if (c === '"') this.basic();
    else if (c === "'") this.literal();
    else if (c === '[') this.array();
    else if (c === '{') this.inlineTable();
    else if (SCALAR.test(c)) {
      const start = this.pos;
      while (SCALAR.test(this.peek())) this.advance();
      if (/^\d{4}-\d{2}-\d{2}$/.test(this.text.slice(start, this.pos)) && /^ \d{2}:/.test(this.text.slice(this.pos))) {
        this.advance();
        while (SCALAR.test(this.peek())) this.advance();
      }
    } else this.fail(c === '' || c === '\n' ? 'a value is missing' : `'${c}' can't start a value`);
  }

  private array(): void {
    const start = this.line;
    this.advance();
    for (;;) {
      this.gap();
      if (this.peek() === ']') {
        this.advance();
        return;
      }
      if (this.pos >= this.text.length) this.fail('an array is not closed', start);
      this.value();
      this.gap();
      if (this.peek() === ',') this.advance();
      else if (this.peek() !== ']') this.fail('an array is not closed', start);
    }
  }

  private inlineTable(): void {
    this.advance();
    for (;;) {
      this.gap();
      if (this.peek() === '}') {
        this.advance();
        return;
      }
      this.key();
      if (this.peek() !== '=') this.fail("a key in an inline table needs '='");
      this.advance();
      this.spaces();
      this.value();
      this.gap();
      if (this.peek() === ',') this.advance();
      else if (this.peek() !== '}') this.fail('an inline table is not closed');
    }
  }

  outline(): TomlOutline {
    const headers: TomlHeader[] = [];
    const keys: TomlKey[] = [];
    let table: string[] = [];
    for (;;) {
      this.gap();
      if (this.pos >= this.text.length) return { headers, keys };
      const line = this.line;
      if (this.peek() === '[') {
        const array = this.peek(1) === '[';
        this.advance(array ? 2 : 1);
        table = this.key();
        if (!this.startsWith(array ? ']]' : ']')) this.fail('a table header is not closed');
        this.advance(array ? 2 : 1);
        headers.push({ path: table, array, line });
        this.endOfLine();
        continue;
      }
      const key = this.key();
      if (this.peek() !== '=') this.fail("a key needs '=' and a value");
      this.advance();
      this.spaces();
      const start = this.pos;
      this.value();
      keys.push({ path: [...table, ...key], table, line, end: this.line, value: this.text.slice(start, this.pos) });
      this.endOfLine();
    }
  }
}

export function outlineToml(text: string): TomlOutline {
  return new Scanner(text).outline();
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, i) => path[i] === part);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

export type TableEdit = { kind: 'unchanged' } | { kind: 'changed'; text: string } | { kind: 'refused'; reason: string };

function bare(part: string): string {
  return /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part);
}

export interface TomlEntry {
  key: string;
  value: string;
  /** Leaves the value the table already has when this holds for it. */
  keeps?: (current: string) => boolean;
}

/**
 * Sets each entry's key in one table, `[a.b]`, adding the table when the file lacks it, and leaves every other line of
 * the file as it was, the table's other keys and its sub-tables (`[a.b.env]`) included.
 */
export function upsertTable(text: string, table: readonly string[], entries: readonly TomlEntry[]): TableEdit {
  let outline: TomlOutline;
  try {
    outline = outlineToml(text);
  } catch (error) {
    return { kind: 'refused', reason: `it isn't valid TOML (${(error as Error).message})` };
  }
  const name = table.map(bare).join('.');
  const ours = outline.headers.filter(h => same(h.path, table));
  if (ours.length > 1 || ours.some(h => h.array)) return { kind: 'refused', reason: `it declares [${name}] more than once` };
  const own = ours[0];
  const foreign = outline.keys.find(k => (startsWith(k.path, table) || startsWith(table, k.path)) && !startsWith(k.table, table));
  if (foreign)
    return { kind: 'refused', reason: `line ${String(foreign.line)} sets ${foreign.path.join('.')} outside [${name}]` };
  const set = (entry: TomlEntry) => `${bare(entry.key)} = ${entry.value}`;
  if (!own) {
    const head = text === '' ? '' : text.endsWith('\n') ? `${text}\n` : `${text}\n\n`;
    return { kind: 'changed', text: `${head}${[`[${name}]`, ...entries.map(set)].join('\n')}\n` };
  }
  const keys = outline.keys.filter(k => same(k.table, table));
  const replaced = new Map<number, string>();
  const dropped = new Set<number>();
  const added: string[] = [];
  for (const entry of entries) {
    const found = keys.filter(k => k.path[table.length] === entry.key);
    const [first] = found;
    if (!first) {
      added.push(set(entry));
      continue;
    }
    const whole = found.length === 1 && first.path.length === table.length + 1;
    if (whole && (first.value === entry.value || entry.keeps?.(first.value) === true)) continue;
    for (const key of found) for (let line = key.line; line <= key.end; line++) dropped.add(line);
    replaced.set(first.line, set(entry));
  }
  if (replaced.size === 0 && added.length === 0) return { kind: 'unchanged' };
  const after = Math.max(own.line, ...keys.map(k => k.end));
  const next = text.split('\n').flatMap((line, i) => {
    const at = i + 1;
    const kept = replaced.get(at) ?? (dropped.has(at) ? null : line);
    return [...(kept === null ? [] : [kept]), ...(at === after ? added : [])];
  });
  return { kind: 'changed', text: next.join('\n') };
}

/** Removes one table, `[a.b]`, with its own sub-tables, and leaves every other line of the file as it was. */
export function removeTable(text: string, table: readonly string[]): TableEdit {
  let outline: TomlOutline;
  try {
    outline = outlineToml(text);
  } catch (error) {
    return { kind: 'refused', reason: `it isn't valid TOML (${(error as Error).message})` };
  }
  const name = table.map(bare).join('.');
  const ours = outline.headers.filter(h => startsWith(h.path, table));
  const foreign = outline.keys.find(k => startsWith(k.path, table) && !startsWith(k.table, table));
  if (foreign)
    return { kind: 'refused', reason: `line ${String(foreign.line)} sets ${foreign.path.join('.')} outside [${name}]` };
  if (ours.some(h => h.array)) return { kind: 'refused', reason: `it declares [[${name}]], an array of tables` };
  if (ours.length === 0) return { kind: 'unchanged' };
  const all = text.split('\n');
  const blank = (line: number) => line < 1 || line > all.length || (all[line - 1] ?? '').trim() === '';
  const dropped = new Set<number>();
  for (const own of ours) {
    const next = outline.headers.find(h => h.line > own.line);
    let end = next ? next.line - 1 : all.length;
    while (end > own.line && /^\s*(#.*)?$/.test(all[end - 1] ?? '')) end--;
    for (let line = own.line; line <= end; line++) dropped.add(line);
    if (blank(own.line - 1) && blank(end + 1) && end + 1 <= all.length) dropped.add(end + 1);
  }
  const kept = all.filter((_, i) => !dropped.has(i + 1));
  return { kind: 'changed', text: kept.join('\n').trim() === '' ? '' : kept.join('\n') };
}
