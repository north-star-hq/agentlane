export interface Word {
  text: string;
  literal: boolean;
}

export interface SimpleCommand {
  words: Word[];
}

const SEPARATORS = new Set([';', '&', '|', '(', ')', '\n']);
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time']);
const HEADERS = new Set(['for', 'case', 'select', 'function']);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_EXPANSIONS = 1000;

const OPEN = Symbol('{');
const COMMA = Symbol(',');
const CLOSE = Symbol('}');
type Piece = string | typeof OPEN | typeof COMMA | typeof CLOSE;

interface Lexed {
  word: Word;
  braces: number[];
}

function piecesOf(text: string, braces: readonly number[]): Piece[] {
  const unquoted = new Set(braces);
  return text.split('').map((c, i) => {
    if (!unquoted.has(i)) return c;
    return c === '{' ? OPEN : c === ',' ? COMMA : CLOSE;
  });
}

function textOf(pieces: readonly Piece[]): string {
  return pieces.map(p => (p === OPEN ? '{' : p === COMMA ? ',' : p === CLOSE ? '}' : p)).join('');
}

function groupAt(pieces: readonly Piece[], open: number): { close: number; commas: number[] } | null {
  let depth = 0;
  const commas: number[] = [];
  for (let i = open + 1; i < pieces.length; i++) {
    const p = pieces[i];
    if (p === OPEN) depth++;
    else if (p === CLOSE) {
      if (depth === 0) return { close: i, commas };
      depth--;
    } else if (p === COMMA && depth === 0) commas.push(i);
  }
  return null;
}

function sequence(body: readonly Piece[], limit: number): Piece[][] | null {
  if (!body.every(p => typeof p === 'string')) return null;
  const text = body.join('');
  const numbers = /^([-+]?\d+)\.\.([-+]?\d+)(?:\.\.([-+]?\d+))?$/.exec(text);
  const letters = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.([-+]?\d+))?$/.exec(text);
  const [, from = '', to = '', by = '1'] = numbers ?? letters ?? [];
  if (from === '') return null;
  const start = numbers ? Number(from) : from.charCodeAt(0);
  const end = numbers ? Number(to) : to.charCodeAt(0);
  const step = (Math.abs(Number(by)) || 1) * (end < start ? -1 : 1);
  const width = /^[-+]?0\d/.test(from) || /^[-+]?0\d/.test(to) ? Math.max(from.length, to.length) : 0;
  const term = (n: number) =>
    !numbers ? String.fromCharCode(n) : n < 0 ? `-${String(-n).padStart(width - 1, '0')}` : String(n).padStart(width, '0');
  const terms: Piece[][] = [];
  for (let n = start; (step > 0 ? n <= end : n >= end) && terms.length <= limit; n += step) terms.push([term(n)]);
  return terms;
}

function alternativesOf(pieces: readonly Piece[], open: number, close: number, commas: readonly number[], limit: number) {
  if (commas.length === 0) return sequence(pieces.slice(open + 1, close), limit);
  const cuts = [open, ...commas, close];
  return cuts.slice(1).map((cut, i) => pieces.slice((cuts[i] ?? open) + 1, cut));
}

function expand(pieces: readonly Piece[], budget: { left: number }): Piece[][] | null {
  for (let open = pieces.indexOf(OPEN); open !== -1; open = pieces.indexOf(OPEN, open + 1)) {
    const group = groupAt(pieces, open);
    if (group === null) continue;
    const alternatives = alternativesOf(pieces, open, group.close, group.commas, budget.left);
    if (alternatives === null) continue;
    const words: Piece[][] = [];
    for (const alternative of alternatives) {
      const expanded = expand([...pieces.slice(0, open), ...alternative, ...pieces.slice(group.close + 1)], budget);
      if (expanded === null) return null;
      words.push(...expanded);
    }
    return words;
  }
  budget.left -= 1;
  return budget.left < 0 ? null : [[...pieces]];
}

function expandBraces({ word, braces }: Lexed): Word[] {
  if (braces.length === 0) return [word];
  const expanded = expand(piecesOf(word.text, braces), { left: MAX_EXPANSIONS });
  if (expanded === null) return [word];
  return expanded.map(textOf).flatMap(text => (text === '' ? [] : [{ text, literal: word.literal }]));
}

/** Bash and zsh brace-expand every word of a simple command except the assignments that lead it. */
function expandWords(lexed: readonly Lexed[]): Word[] {
  let assigning = true;
  return lexed.flatMap(entry => {
    assigning &&= ASSIGNMENT_WORD.test(entry.word.text);
    return assigning ? [entry.word] : expandBraces(entry);
  });
}

class Lexer {
  private readonly src: string;
  private pos = 0;
  readonly commands: SimpleCommand[] = [];
  private words: Lexed[] = [];
  private word: Word | null = null;
  private braces: number[] = [];
  private heredocs: string[] = [];
  private skipNextWord = false;

  constructor(src: string) {
    this.src = src;
  }

  run(): SimpleCommand[] {
    while (this.pos < this.src.length) this.step();
    this.endCommand();
    return this.commands;
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  private append(text: string, literal = true): void {
    this.word ??= { text: '', literal: true };
    this.word.text += text;
    if (!literal) this.word.literal = false;
  }

  private endWord(): void {
    if (this.word === null) return;
    if (this.skipNextWord) this.skipNextWord = false;
    else this.words.push({ word: this.word, braces: this.braces });
    this.word = null;
    this.braces = [];
  }

  private endCommand(): void {
    this.endWord();
    const words = expandWords(this.words);
    if (words.length > 0) this.commands.push({ words });
    this.words = [];
  }

  private nested(script: string): void {
    this.commands.push(...splitCommands(script));
  }

  private step(): void {
    const c = this.peek();
    if (c === ' ' || c === '\t') {
      this.endWord();
      this.pos++;
      return;
    }
    if (c === '\n') {
      this.endCommand();
      this.pos++;
      this.readHeredocs();
      return;
    }
    if (c === '#' && this.word === null) {
      while (this.pos < this.src.length && this.peek() !== '\n') this.pos++;
      return;
    }
    if (SEPARATORS.has(c)) {
      this.endCommand();
      this.pos++;
      return;
    }
    if (c === '<' || c === '>') {
      this.redirection();
      return;
    }
    if (c === "'") {
      const end = this.src.indexOf("'", this.pos + 1);
      const stop = end === -1 ? this.src.length : end;
      this.append(this.src.slice(this.pos + 1, stop));
      this.pos = stop + 1;
      return;
    }
    if (c === '"') {
      this.doubleQuoted();
      return;
    }
    if (c === '\\') {
      const next = this.peek(1);
      if (next !== '\n') this.append(next);
      this.pos += 2;
      return;
    }
    if (c === '$' && (this.peek(1) === "'" || this.peek(1) === '"')) {
      this.pos++;
      return;
    }
    if (c === '$') {
      this.dollar();
      return;
    }
    if (c === '`') {
      this.backtick();
      return;
    }
    if (c === '{' || c === ',' || c === '}') this.braces.push(this.word?.text.length ?? 0);
    this.append(c);
    this.pos++;
  }

  private redirection(): void {
    const fd = this.word !== null && /^\d+$/.test(this.word.text) ? this.word : null;
    if (fd) {
      this.word = null;
      this.braces = [];
    } else this.endWord();
    const c = this.peek();
    if (c === '<' && this.peek(1) === '<' && this.peek(2) !== '<') {
      this.pos += 2;
      if (this.peek() === '-') this.pos++;
      while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
      const start = this.pos;
      while (this.pos < this.src.length && !/[\s;&|()<>]/.test(this.peek())) this.pos++;
      this.heredocs.push(this.src.slice(start, this.pos).replace(/['"\\]/g, ''));
      return;
    }
    this.pos++;
    while (this.peek() === '<' || this.peek() === '>' || this.peek() === '&' || this.peek() === '|') this.pos++;
    if (this.src[this.pos - 1] === '&' && /[\d-]/.test(this.peek())) {
      while (/[\d-]/.test(this.peek())) this.pos++;
      return;
    }
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
    this.skipNextWord = true;
  }

  private readHeredocs(): void {
    while (this.heredocs.length > 0) {
      const delimiter = this.heredocs.shift() ?? '';
      while (this.pos < this.src.length) {
        const end = this.src.indexOf('\n', this.pos);
        const stop = end === -1 ? this.src.length : end;
        const line = this.src.slice(this.pos, stop);
        this.pos = stop + 1;
        if (line.trim() === delimiter) break;
      }
    }
  }

  private doubleQuoted(): void {
    this.pos++;
    this.append('');
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '"') {
        this.pos++;
        return;
      }
      if (c === '\\' && '"\\$`\n'.includes(this.peek(1))) {
        if (this.peek(1) !== '\n') this.append(this.peek(1));
        this.pos += 2;
      } else if (c === '$') this.dollar();
      else if (c === '`') this.backtick();
      else {
        this.append(c);
        this.pos++;
      }
    }
  }

  private dollar(): void {
    const next = this.peek(1);
    if (next === '(') {
      const body = this.balanced(this.pos + 2);
      this.nested(body.text);
      this.append('$(…)', false);
      this.pos = body.end;
      return;
    }
    if (next === '{') {
      const end = this.src.indexOf('}', this.pos + 2);
      const stop = end === -1 ? this.src.length : end;
      this.append(`\${${this.src.slice(this.pos + 2, stop)}}`, false);
      this.pos = stop + 1;
      return;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(this.src.slice(this.pos + 1));
    if (name) {
      this.append(`$${name[0]}`, false);
      this.pos += 1 + name[0].length;
      return;
    }
    this.append('$');
    this.pos++;
  }

  private backtick(): void {
    let end = this.pos + 1;
    while (end < this.src.length && this.src[end] !== '`') end += this.src[end] === '\\' ? 2 : 1;
    this.nested(this.src.slice(this.pos + 1, end).replace(/\\([`\\$])/g, '$1'));
    this.append('$(…)', false);
    this.pos = end + 1;
  }

  private balanced(start: number): { text: string; end: number } {
    let depth = 1;
    let i = start;
    while (i < this.src.length) {
      const c = this.src[i];
      if (c === '\\') i += 2;
      else if (c === "'") {
        const close = this.src.indexOf("'", i + 1);
        i = close === -1 ? this.src.length : close + 1;
      } else if (c === '"') {
        i++;
        while (i < this.src.length && this.src[i] !== '"') i += this.src[i] === '\\' ? 2 : 1;
        i++;
      } else {
        if (c === '(') depth++;
        if (c === ')') depth--;
        i++;
        if (depth === 0) return { text: this.src.slice(start, i - 1), end: i };
      }
    }
    return { text: this.src.slice(start), end: this.src.length };
  }
}

function dropReserved(command: SimpleCommand): SimpleCommand | null {
  let first = 0;
  while (first < command.words.length && command.words[first]?.literal && RESERVED.has(command.words[first]?.text ?? '')) first++;
  const words = command.words.slice(first);
  const head = words[0];
  if (!head || (head.literal && HEADERS.has(head.text))) return null;
  return { words };
}

export function splitCommands(script: string): SimpleCommand[] {
  return new Lexer(script)
    .run()
    .map(dropReserved)
    .filter((c): c is SimpleCommand => c !== null);
}
