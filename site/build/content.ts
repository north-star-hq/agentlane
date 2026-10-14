import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { plainText, renderMarkdown, slug, type Heading } from './markdown.ts';
import { REPO, SITE } from './paths.ts';
import { expandGenerated } from './reference.ts';

export { REPO, SITE } from './paths.ts';

export interface DocPage {
  slug: string;
  number: string;
  section: string;
  title: string;
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

export interface Landing {
  title: string;
  description: string;
  headline: string;
  pitch: string;
  install: InstallStep[];
  agents: string[];
  heroAlt: string;
  why: { title: string; text: string }[];
  speed: { value: string; label: string }[];
  speedNote: string;
}

function frontMatter(file: string): { data: Record<string, unknown>; body: string } {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path.relative(REPO, file)}: no front matter`);
  return { data: parse(match[1] ?? '') as Record<string, unknown>, body: match[2] ?? '' };
}

function text(data: Record<string, unknown>, key: string, file: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${path.relative(REPO, file)}: front matter needs ${key}`);
  return value.trim();
}

export function loadSections(): Section[] {
  const nav = parse(fs.readFileSync(path.join(SITE, 'docs.yaml'), 'utf8')) as { title: string; pages: string[] }[];
  const listed = new Set<string>();
  const sections = nav.map((entry, s) => {
    const number = String(s + 1);
    const pages = entry.pages.map((name, p): DocPage => {
      if (listed.has(name)) throw new Error(`docs.yaml lists ${name} twice`);
      listed.add(name);
      const file = path.join(SITE, 'docs', `${name}.md`);
      const { data, body } = frontMatter(file);
      const markdown = expandGenerated(body).trim() + '\n';
      const { html, headings } = renderMarkdown(markdown);
      return {
        slug: name,
        number: `${number}.${String(p + 1)}`,
        section: entry.title,
        title: text(data, 'title', file),
        short: text(data, 'short', file),
        summary: text(data, 'summary', file),
        outline: data.status === 'outline',
        markdown,
        html,
        headings,
      };
    });
    return { number, title: entry.title, pages };
  });
  const unlisted = fs.readdirSync(path.join(SITE, 'docs')).filter(f => f.endsWith('.md') && !listed.has(f.slice(0, -3)));
  if (unlisted.length > 0) throw new Error(`site/docs has pages docs.yaml doesn't list: ${unlisted.join(', ')}`);
  return sections;
}

export function loadLanding(): Landing {
  const file = path.join(SITE, 'index.md');
  const { data } = frontMatter(file);
  const install = data.install as InstallStep[];
  const agents = data.agents as string[];
  return {
    title: text(data, 'title', file),
    description: text(data, 'description', file),
    headline: text(data, 'headline', file),
    pitch: text(data, 'pitch', file),
    install,
    agents,
    heroAlt: text(data, 'heroAlt', file),
    why: data.why as Landing['why'],
    speed: data.speed as Landing['speed'],
    speedNote: text(data, 'speedNote', file),
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
