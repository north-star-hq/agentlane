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

class Lexer {
  private readonly src: string;
  private pos = 0;
  readonly commands: SimpleCommand[] = [];
  private words: Word[] = [];
  private word: Word | null = null;
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
    else this.words.push(this.word);
    this.word = null;
  }

  private endCommand(): void {
    this.endWord();
    if (this.words.length > 0) this.commands.push({ words: this.words });
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
    if (c === '$') {
      this.dollar();
      return;
    }
    if (c === '`') {
      this.backtick();
      return;
    }
    this.append(c);
    this.pos++;
  }

  private redirection(): void {
    const fd = this.word !== null && /^\d+$/.test(this.word.text) ? this.word : null;
    if (fd) this.word = null;
    else this.endWord();
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
    if (next === "'") {
      this.pos++;
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
