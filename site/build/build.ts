import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadLanding, loadReleases, loadSections, REPO, SITE, type DocPage, type Landing, type Section } from './content.ts';
import { checkFacts } from './facts.ts';
import { changelogBody, docBody, landingBody, shell } from './layout.ts';
import { plainText } from './markdown.ts';

export const DEFAULT_OUT = path.join(SITE, 'dist');

const COPIED: [from: string, to: string][] = [
  ['brand/tokens.css', 'assets/tokens.css'],
  ['brand/mark.svg', 'assets/mark.svg'],
  ['brand/lockup-light.svg', 'assets/lockup-light.svg'],
  ['brand/lockup-dark.svg', 'assets/lockup-dark.svg'],
  ['media/hero-light.svg', 'assets/hero-light.svg'],
  ['media/hero-dark.svg', 'assets/hero-dark.svg'],
  ['site/assets/site.css', 'assets/site.css'],
  ['site/assets/fonts/overpass.woff2', 'assets/fonts/overpass.woff2'],
  ['site/assets/fonts/overpass-mono.woff2', 'assets/fonts/overpass-mono.woff2'],
  ['site/assets/fonts/OFL.txt', 'assets/fonts/OFL.txt'],
];

const REDUCED_MOTION = '@media (prefers-reduced-motion:reduce){*{animation:none!important}.fx{visibility:hidden}}';

export function stillHero(svg: string): string {
  if (!svg.includes(REDUCED_MOTION))
    throw new Error("the hero's reduced-motion rule changed; update REDUCED_MOTION in site/build/build.ts");
  return svg.replace(REDUCED_MOTION, '*{animation:none!important}.fx{visibility:hidden}');
}

function write(out: string, file: string, content: string): void {
  const target = path.join(out, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function pageMarkdown(page: DocPage): string {
  return `# ${page.title}\n\n${page.summary}\n\n${page.markdown}`;
}

export function landingMarkdown(landing: Landing, sections: Section[]): string {
  const steps = landing.install
    .map(
      (step, i) =>
        `${String(i + 1)}. ${step.label}:\n\n   ${step.command ? `\`\`\`sh\n   ${step.command}\n   \`\`\`` : `> ${step.prompt ?? ''}`}`,
    )
    .join('\n\n');
  const docs = sections
    .map(s => `## ${s.title}\n\n${s.pages.map(p => `- [${p.title}](docs/${p.slug}.md): ${p.short}`).join('\n')}`)
    .join('\n\n');
  return (
    [
      `# ${landing.title}: ${landing.headline}`,
      landing.pitch,
      `Works with ${landing.agents.join(', ')}.`,
      `## Start in your project\n\n${steps}`,
      `## Why agentlane\n\n${landing.why.map(w => `- **${w.title}.** ${asMarkdownLinks(w.text)}`).join('\n')}`,
      `## Fast where agents spend their time\n\n${landing.speed.map(st => `- **${st.value}** ${st.label}`).join('\n')}\n\n${asMarkdownLinks(landing.speedNote)}`,
      docs,
      '## Changelog\n\n[Every release](changelog.md)',
    ].join('\n\n') + '\n'
  );
}

function asMarkdownLinks(text: string): string {
  return text.replace(/\.html(#[^)]*)?\)/g, '.md$1)');
}

export function llmsIndex(landing: Landing, sections: Section[]): string {
  const groups = sections.map(
    s => `## ${s.title}\n\n${s.pages.map(p => `- [${p.title}](docs/${p.slug}.md): ${plainText(p.short)}`).join('\n')}`,
  );
  return (
    [
      `# ${landing.title}`,
      `> ${landing.description}`,
      'Each link below is the Markdown copy of one page of the docs, in the order the site reads. llms-full.txt holds every page in one file.',
      ...groups,
      '## Optional\n\n- [Changelog](changelog.md): What changed in each release, newest first.',
    ].join('\n\n') + '\n'
  );
}

export function buildSite(out: string = DEFAULT_OUT): string[] {
  const sections = loadSections();
  const landing = loadLanding();
  const releases = loadReleases();
  const pages = sections.flatMap(s => s.pages);
  const problems = checkFacts(pages.map(p => ({ file: `site/docs/${p.slug}.md`, markdown: pageMarkdown(p) })));
  if (problems.length > 0) throw new Error(`the docs name what this branch doesn't have:\n${problems.join('\n')}`);
  const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [from, to] of COPIED) {
    fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
    fs.copyFileSync(path.join(REPO, from), path.join(out, to));
  }

  for (const theme of ['light', 'dark']) {
    const svg = fs.readFileSync(path.join(REPO, 'media', `hero-${theme}.svg`), 'utf8');
    write(out, `assets/hero-${theme}-still.svg`, stillHero(svg));
  }

  const written: string[] = [];
  const emit = (file: string, html: string) => {
    write(out, file, html);
    written.push(file);
  };

  write(out, 'index.md', landingMarkdown(landing, sections));
  write(out, 'changelog.md', changelog);
  for (const page of pages) write(out, `docs/${page.slug}.md`, pageMarkdown(page));
  write(out, 'llms.txt', llmsIndex(landing, sections));
  write(out, 'llms-full.txt', [...pages.map(pageMarkdown), changelog].join('\n\n'));

  emit(
    'index.html',
    shell({
      root: '',
      title: `${landing.title}: ${landing.headline}`,
      description: landing.description,
      current: { kind: 'landing' },
      sections,
      body: landingBody('', landing, sections, releases),
      markdown: 'index.md',
    }),
  );
  emit(
    'changelog.html',
    shell({
      root: '',
      title: 'Changelog | agentlane',
      description: 'What changed in each release of agentlane.',
      current: { kind: 'changelog' },
      sections,
      body: changelogBody(releases),
      markdown: 'changelog.md',
    }),
  );
  pages.forEach((page, i) => {
    emit(
      `docs/${page.slug}.html`,
      shell({
        root: '../',
        title: `${page.title} | agentlane`,
        description: plainText(page.summary),
        current: { kind: 'doc', slug: page.slug },
        sections,
        body: docBody('../', page, pages[i - 1], pages[i + 1]),
        markdown: `${page.slug}.md`,
      }),
    );
  });
  return written;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const out = path.resolve(values.out ?? DEFAULT_OUT);
  const written = buildSite(out);
  console.log(`${String(written.length)} pages in ${path.relative(process.cwd(), out) || '.'}`);
}
