import { Marked, type Tokens } from 'marked';

export interface Heading {
  id: string;
  text: string;
  depth: number;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

const CALLOUTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', WARNING: 'Warning' };

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z]+;/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageHref(href: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
  return href.replace(/\.md(#|$)/, '.html$1');
}

function codeBlock(text: string, info: string | undefined): string {
  const title = /title="([^"]+)"/.exec(info ?? '')?.[1];
  const lang = (info ?? '').split(/\s+/)[0] ?? '';
  const head = title ? `<p class="code-title">${escapeHtml(title)}</p>` : '';
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<div class="code">${head}<pre tabindex="0"><code${cls}>${escapeHtml(text)}</code></pre></div>\n`;
}

function fieldList(rows: Map<string, string>[]): string {
  const items = rows
    .map(row => {
      const type = row.get('Type') ? `<span class="field-type">${row.get('Type') ?? ''}</span>` : '';
      const required = row.get('Required') === 'Yes' ? '<span class="field-required">required</span>' : '';
      const what = row.get('What it is') ?? '';
      return `<div class="field"><dt><span class="field-name">${row.get('Field') ?? ''}</span>${type}${required}</dt>${what ? `<dd>${what}</dd>` : ''}</div>`;
    })
    .join('\n');
  return `<dl class="fields">\n${items}\n</dl>\n`;
}

export function renderInline(source: string): string {
  return new Marked({ gfm: true }).parseInline(source, { async: false });
}

export function renderMarkdown(source: string, options: { idPrefix?: string } = {}): Rendered {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const prefix = options.idPrefix ?? '';
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const base = prefix + slug(inner);
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        const id = seen === 0 ? base : `${base}-${String(seen + 1)}`;
        headings.push({ id, text: inner, depth });
        return `<h${String(depth)} id="${id}">${inner}</h${String(depth)}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        return codeBlock(text, lang);
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(pageHref(href))}"${titleAttr}>${inner}</a>`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens);
        const marker = /^<p>\[!(NOTE|TIP|WARNING)\]\s*/.exec(inner);
        const kind = marker?.[1];
        if (!marker || !kind) return `<blockquote>${inner}</blockquote>\n`;
        const body = '<p>' + inner.slice(marker[0].length);
        return `<aside class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${CALLOUTS[kind] ?? kind}</p>${body}</aside>\n`;
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens);
        const head = token.header.map(c => `<th>${cell(c)}</th>`).join('');
        const labels = token.header.map(c => escapeHtml(plainText(c.text)));
        if (labels[0] === 'Field') {
          return fieldList(token.rows.map(row => new Map(row.map((c, i) => [labels[i] ?? '', cell(c)]))));
        }
        const rows = token.rows
          .map(row => `<tr>${row.map((c, i) => `<td data-label="${labels[i] ?? ''}">${cell(c)}</td>`).join('')}</tr>`)
          .join('\n');
        const wide = token.header.length >= 3 ? ' table-wide' : '';
        return `<div class="table${wide}" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const html = marked.parse(source, { async: false });
  return { html, headings };
}
