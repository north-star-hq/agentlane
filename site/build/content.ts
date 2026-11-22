import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { plainText, renderMarkdown, slug, type Heading } from './markdown.ts';
import { ICONS } from './icons.ts';
import { REPO, SITE } from './paths.ts';
import { expandGenerated } from './reference.ts';

export { REPO, SITE } from './paths.ts';

export interface DocPage {
  slug: string;
  number: string;
  section: string;
  title: string;
  label: string;
  short: string;
  summary: string;
  outline: boolean;
  markdown: string;
  html: string;
  headings: Heading[];
}

export interface Section {
  number: string;
  title: string;
  pages: DocPage[];
}

export interface Release {
  id: string;
  version: string;
  lead: string;
  html: string;
}

export interface InstallStep {
  label: string;
  command?: string;
  prompt?: string;
}

export interface Link {
  label: string;
  href: string;
  icon?: string;
  primary?: boolean;
}

export interface Card {
  icon: string;
  title: string;
  text: string;
  href: string;
}

export interface Landing {
  title: string;
  problem: string;
  description: string;
  badge: { text: string; href: string };
  headline: string;
  marked: { before: string; text: string; after: string };
  sentence: string;
  figure: string;
  buttons: Link[];
  install: InstallStep[];
  agents: string[];
  heroAlt: string;
  cards: Card[];
  about: { title: string; paragraphs: string[] };
  speed: { value: string; label: string }[];
}

function frontMatter(file: string): { data: Record<string, unknown>; body: string } {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---[ \t]*\n(?:([\s\S]*?)\n)??---[ \t]*(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path.relative(REPO, file)}: no front matter`);
  const data: unknown = parse(match[1] ?? '');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw needs(file, 'fields');
  return { data: data as Fields, body: match[2] ?? '' };
}

type Fields = Record<string, unknown>;

function needs(file: string, what: string): Error {
  return new Error(`${path.relative(REPO, file)}: front matter needs ${what}`);
}

function text(value: unknown, file: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw needs(file, name);
  return value.trim();
}

function fields(value: unknown, file: string, name: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw needs(file, `${name}, with fields under it`);
  return value as Fields;
}

function only(value: Fields, file: string, prefix: string, keys: string[]): Fields {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra !== undefined)
    throw new Error(`${path.relative(REPO, file)}: front matter has ${prefix}${extra}, which the build doesn't read`);
  return value;
}

function list<T>(value: unknown, file: string, name: string, item: (value: unknown, name: string) => T): T[] {
  if (!Array.isArray(value) || value.length === 0) throw needs(file, `${name}, a list`);
  return value.map((entry, i) => item(entry, `${name}[${String(i)}]`));
}

export function loadSections(site = SITE): Section[] {
  const nav = parse(fs.readFileSync(path.join(site, 'docs.yaml'), 'utf8')) as { title: string; pages: string[] }[];
  const listed = new Set<string>();
  const sections = nav.map((entry, s) => {
    const number = String(s + 1);
    const pages = entry.pages.map((name, p): DocPage => {
      if (listed.has(name)) throw new Error(`docs.yaml lists ${name} twice`);
      listed.add(name);
      const file = path.join(site, 'docs', `${name}.md`);
      const { data, body } = frontMatter(file);
      only(data, file, '', ['title', 'label', 'short', 'summary', 'status']);
      const markdown = expandGenerated(body).trim() + '\n';
      const { html, headings } = renderMarkdown(markdown);
      const title = text(data.title, file, 'title');
      return {
        slug: name,
        number: `${number}.${String(p + 1)}`,
        section: entry.title,
        title,
        label: data.label === undefined ? title : text(data.label, file, 'label'),
        short: text(data.short, file, 'short'),
        summary: text(data.summary, file, 'summary'),
        outline: data.status === 'outline',
        markdown,
        html,
        headings,
      };
    });
    return { number, title: entry.title, pages };
  });
  const unlisted = fs.readdirSync(path.join(site, 'docs')).filter(f => f.endsWith('.md') && !listed.has(f.slice(0, -3)));
  if (unlisted.length > 0) throw new Error(`site/docs has pages docs.yaml doesn't list: ${unlisted.join(', ')}`);
  return sections;
}

export function loadLanding(file = path.join(SITE, 'index.md')): Landing {
  const { data } = frontMatter(file);
  only(data, file, '', [
    'title',
    'problem',
    'description',
    'badge',
    'headline',
    'marked',
    'sentence',
    'figure',
    'buttons',
    'install',
    'agents',
    'heroAlt',
    'cards',
    'about',
    'speed',
  ]);
  const where = path.relative(REPO, file);
  const headline = text(data.headline, file, 'headline');
  const marked = text(data.marked, file, 'marked');
  const sentence = headline.replace(/\.$/, '');
  const word = marked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = sentence.search(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}\\p{Pc}])${word}(?![\\p{L}\\p{M}\\p{N}\\p{Pc}])`, 'u'));
  if (at === -1) throw new Error(`${where}: marked is "${marked}", which the headline before its full stop doesn't contain`);
  const badge = only(fields(data.badge, file, 'badge'), file, 'badge.', ['text', 'href']);
  const buttons = list(data.buttons, file, 'buttons', (value, name): Link => {
    const button = only(fields(value, file, name), file, `${name}.`, ['label', 'href', 'icon', 'primary']);
    if (button.primary !== undefined && typeof button.primary !== 'boolean')
      throw needs(file, `${name}.primary to be true or false`);
    return {
      label: text(button.label, file, `${name}.label`),
      href: text(button.href, file, `${name}.href`),
      ...(button.icon === undefined ? {} : { icon: text(button.icon, file, `${name}.icon`) }),
      ...(button.primary === undefined ? {} : { primary: button.primary }),
    };
  });
  const install = list(data.install, file, 'install', (value, name): InstallStep => {
    const step = only(fields(value, file, name), file, `${name}.`, ['label', 'command', 'prompt']);
    const label = text(step.label, file, `${name}.label`);
    if ((step.command === undefined) === (step.prompt === undefined))
      throw needs(file, `${name} to have a command or a prompt, not both`);
    return step.command === undefined
      ? { label, prompt: text(step.prompt, file, `${name}.prompt`) }
      : { label, command: text(step.command, file, `${name}.command`) };
  });
  const cards = list(data.cards, file, 'cards', (value, name): Card => {
    const card = only(fields(value, file, name), file, `${name}.`, ['icon', 'title', 'text', 'href']);
    return {
      icon: text(card.icon, file, `${name}.icon`),
      title: text(card.title, file, `${name}.title`),
      text: text(card.text, file, `${name}.text`),
      href: text(card.href, file, `${name}.href`),
    };
  });
  for (const icon of [...buttons, ...cards].flatMap(b => b.icon ?? []))
    if (!(icon in ICONS)) throw new Error(`${where}: no icon called ${icon} in site/build/icons.ts`);
  for (const card of cards)
    if (/\[[^\]]*\]\(/.test(card.text))
      throw new Error(`${where}: the card "${card.title}" is a link already, so its text can't hold one`);
  const about = only(fields(data.about, file, 'about'), file, 'about.', ['title', 'paragraphs']);
  return {
    title: text(data.title, file, 'title'),
    problem: text(data.problem, file, 'problem'),
    description: text(data.description, file, 'description'),
    badge: { text: text(badge.text, file, 'badge.text'), href: text(badge.href, file, 'badge.href') },
    headline,
    marked: { before: sentence.slice(0, at), text: marked, after: sentence.slice(at + marked.length) },
    sentence: text(data.sentence, file, 'sentence'),
    figure: text(data.figure, file, 'figure'),
    buttons,
    install,
    agents: list(data.agents, file, 'agents', (value, name) => text(value, file, name)),
    heroAlt: text(data.heroAlt, file, 'heroAlt'),
    cards,
    about: {
      title: text(about.title, file, 'about.title'),
      paragraphs: list(about.paragraphs, file, 'about.paragraphs', (value, name) => text(value, file, name)),
    },
    speed: list(data.speed, file, 'speed', (value, name) => {
      const stat = only(fields(value, file, name), file, `${name}.`, ['value', 'label']);
      return { value: text(stat.value, file, `${name}.value`), label: text(stat.label, file, `${name}.label`) };
    }),
  };
}

function leadOf(paragraph: string): string {
  return plainText(paragraph)
    .split(/(?<=[.:])\s+/)
    .filter(sentence => !sentence.endsWith(':'))
    .join(' ');
}

export function loadReleases(file = path.join(REPO, 'CHANGELOG.md')): Release[] {
  const source = fs.readFileSync(file, 'utf8');
  const parts = source.split(/^## /m).slice(1);
  return parts.map(part => {
    const newline = part.indexOf('\n');
    const version = part.slice(0, newline).trim();
    const body = part.slice(newline + 1);
    const firstParagraph = body
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .find(p => p !== '' && !p.startsWith('#') && !p.startsWith('-') && !/^\d+\./.test(p));
    const id = slug(version);
    return { id, version, lead: leadOf(firstParagraph ?? ''), html: renderMarkdown(body, { idPrefix: `${id}-` }).html };
  });
}
