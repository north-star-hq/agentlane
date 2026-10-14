import fs from 'node:fs';
import path from 'node:path';

function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1] ?? ''));
}

function decode(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"');
}

interface Reference {
  value: string;
  loads: boolean;
}

function htmlReferences(html: string): Reference[] {
  const refs: Reference[] = [];
  for (const tag of html.matchAll(/<([a-z]+)\b[^>]*>/gi)) {
    const name = (tag[1] ?? '').toLowerCase();
    for (const attr of tag[0].matchAll(/\s(href|src)="([^"]*)"/g)) {
      refs.push({ value: decode(attr[2] ?? ''), loads: !(name === 'a' && attr[1] === 'href') });
    }
    for (const attr of tag[0].matchAll(/\ssrcset="([^"]*)"/g)) {
      for (const candidate of (attr[1] ?? '').split(',')) {
        refs.push({ value: decode(candidate.trim().split(/\s+/)[0] ?? ''), loads: true });
      }
    }
  }
  return refs;
}

function cssReferences(css: string): Reference[] {
  return [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(m => ({ value: m[1] ?? '', loads: true }));
}

export function checkSite(dir: string): string[] {
  const problems: string[] = [];
  const all = files(dir);
  const idCache = new Map<string, Set<string>>();
  const idsOf = (file: string) => {
    let found = idCache.get(file);
    if (!found) {
      found = ids(fs.readFileSync(path.join(dir, file), 'utf8'));
      idCache.set(file, found);
    }
    return found;
  };

  if (!all.includes('index.html')) problems.push('index.html: missing at the root');
  problems.push(...checkMarkdownCopies(dir, all));

  for (const file of all) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    let refs: Reference[];
    if (file.endsWith('.html')) {
      if (!/^<!doctype html>/i.test(text)) problems.push(`${file}: no <!doctype html>`);
      if (!/<meta charset="utf-8">/i.test(text)) problems.push(`${file}: no charset`);
      if (!/<meta name="viewport"/i.test(text)) problems.push(`${file}: no viewport`);
      if (!/<title>[^<\s][^<]*<\/title>/.test(text)) problems.push(`${file}: no <title>`);
      refs = htmlReferences(text);
    } else if (file.endsWith('.css')) {
      refs = cssReferences(text);
    } else {
      continue;
    }
    for (const { value, loads } of refs) {
      if (/^(https?:)?\/\//i.test(value)) {
        if (loads) problems.push(`${file}: loads ${value} from another origin`);
        continue;
      }
      if (/^[a-z]+:/i.test(value)) continue;
      if (value.startsWith('/')) {
        problems.push(`${file}: ${value} is not relative`);
        continue;
      }
      const [pathPart = '', fragment] = value.split('#', 2);
      const target = pathPart === '' ? file : path.normalize(path.join(path.dirname(file), pathPart));
      if (target.startsWith('..') || !all.includes(target)) {
        problems.push(`${file}: ${value} points at a file the site doesn't have`);
        continue;
      }
      if (fragment && target.endsWith('.html') && !idsOf(target).has(fragment)) {
        problems.push(`${file}: ${value} points at an id ${target} doesn't have`);
      }
    }
  }
  return problems;
}

function markdownLinks(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1] ?? '');
}

/** Each page has its Markdown copy beside it and links to it, and llms.txt lists every docs page's copy. */
function checkMarkdownCopies(dir: string, all: readonly string[]): string[] {
  const problems: string[] = [];
  for (const file of all.filter(f => f.endsWith('.html'))) {
    const copy = file.replace(/\.html$/, '.md');
    if (!all.includes(copy)) {
      problems.push(`${file}: no Markdown copy at ${copy}`);
      continue;
    }
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!html.includes(`<a href="${path.basename(copy)}"`) && !html.includes(` href="${path.basename(copy)}"`))
      problems.push(`${file}: no link to its Markdown copy`);
  }
  for (const name of ['llms.txt', 'llms-full.txt']) if (!all.includes(name)) problems.push(`${name}: missing at the root`);
  if (!all.includes('llms.txt')) return problems;
  const index = fs.readFileSync(path.join(dir, 'llms.txt'), 'utf8');
  const listed = new Set(markdownLinks(index));
  for (const link of listed) {
    if (/^[a-z]+:/i.test(link) || link.startsWith('/')) problems.push(`llms.txt: ${link} is not relative`);
    else if (!all.includes(path.normalize(link))) problems.push(`llms.txt: ${link} points at a file the site doesn't have`);
  }
  for (const copy of all.filter(f => /^docs\/[^/]+\.md$/.test(f) || f === 'changelog.md')) {
    if (!listed.has(copy)) problems.push(`llms.txt: doesn't list ${copy}`);
  }
  return problems;
}
