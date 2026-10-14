import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildSite, pageMarkdown } from '../site/build/build.ts';
import { checkSite } from '../site/build/check.ts';
import { loadSections, SITE } from '../site/build/content.ts';
import { checkFacts, undocumentedVariables } from '../site/build/facts.ts';
import { referenceGaps } from '../site/build/reference.ts';

function source(name: string): string {
  return fs.readFileSync(path.join(SITE, 'docs', `${name}.md`), 'utf8');
}

describe('the docs site', () => {
  let out: string;
  let pages: string[];

  before(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlane-site-'));
    pages = buildSite(out);
  });

  after(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('builds with every link, anchor and asset in place and a title on every page', () => {
    assert.deepEqual(checkSite(out), []);
  });

  test('writes the landing page, the changelog and a page for each entry in docs.yaml', () => {
    const docs = loadSections().flatMap(s => s.pages.map(p => `docs/${p.slug}.html`));
    assert.deepEqual(pages.sort(), ['changelog.html', 'index.html', ...docs].sort());
  });

  test('serves a still hero to readers who ask for less motion', () => {
    const landing = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    for (const theme of ['light', 'dark']) {
      assert.ok(landing.includes(`<source media="(prefers-reduced-motion: reduce)" srcset="assets/hero-${theme}-still.svg">`));
      const still = fs.readFileSync(path.join(out, `assets/hero-${theme}-still.svg`), 'utf8');
      assert.ok(!still.includes('prefers-reduced-motion'));
      assert.ok(still.includes('<style>') && still.includes('*{animation:none!important}'));
    }
  });

  test('has no page left as an outline', () => {
    assert.deepEqual(
      loadSections()
        .flatMap(s => s.pages)
        .filter(p => p.outline)
        .map(p => p.slug),
      [],
    );
  });

  test('writes llms.txt with the summary and every page, grouped as the sidebar groups them', () => {
    const index = fs.readFileSync(path.join(out, 'llms.txt'), 'utf8');
    const sections = loadSections();
    assert.match(index, /^# agentlane\n\n> \S/);
    const headings = [...index.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    assert.deepEqual(headings, [...sections.map(s => s.title), 'Optional']);
    const links = [...index.matchAll(/^- \[[^\]]+\]\(([^)]+)\): \S/gm)].map(m => m[1]);
    assert.deepEqual(links, [...sections.flatMap(s => s.pages.map(p => `docs/${p.slug}.md`)), 'changelog.md']);
  });

  test('writes llms-full.txt with every page in path order', () => {
    const full = fs.readFileSync(path.join(out, 'llms-full.txt'), 'utf8');
    const pages = loadSections().flatMap(s => s.pages);
    let at = -1;
    for (const page of pages) {
      const next = full.indexOf(pageMarkdown(page));
      assert.ok(next > at, `${page.slug} is missing or out of order`);
      at = next;
    }
  });

  test('names only commands, flags and variables this branch has', () => {
    const pages = loadSections().flatMap(s => s.pages);
    assert.deepEqual(checkFacts(pages.map(p => ({ file: p.slug, markdown: pageMarkdown(p) }))), []);
  });

  test('leaves no command, flag, tool, config section or variable out of the reference', () => {
    for (const page of ['cli', 'mcp', 'config'] as const) assert.deepEqual(referenceGaps(page, source(page)), [], page);
    assert.deepEqual(undocumentedVariables(source('environment')), []);
  });

  test('stays small enough to publish as a preview', () => {
    const files = fs.readdirSync(out, { recursive: true, withFileTypes: true }).filter(e => e.isFile());
    assert.ok(files.length <= 200, `${String(files.length)} files`);
  });

  describe('the check', () => {
    let copy: string;

    before(() => {
      copy = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlane-site-check-'));
      fs.cpSync(out, copy, { recursive: true });
    });

    after(() => {
      fs.rmSync(copy, { recursive: true, force: true });
    });

    function plant(file: string, edit: (html: string) => string): string[] {
      const target = path.join(copy, file);
      const original = fs.readFileSync(target, 'utf8');
      const before = checkSite(copy);
      fs.writeFileSync(target, edit(original));
      try {
        return checkSite(copy).filter(problem => !before.includes(problem));
      } finally {
        fs.writeFileSync(target, original);
      }
    }

    test('finds a broken internal link', () => {
      const problems = plant('docs/getting-started.html', html => html.replace('href="lanes.html"', 'href="lane.html"'));
      assert.deepEqual(problems, ["docs/getting-started.html: lane.html points at a file the site doesn't have"]);
    });

    test('finds a link to an anchor the target page lacks', () => {
      const problems = plant('index.html', html => html.replace('href="changelog.html#0-3-0"', 'href="changelog.html#9-9-9"'));
      assert.deepEqual(problems, ["index.html: changelog.html#9-9-9 points at an id changelog.html doesn't have"]);
    });

    test('finds a missing asset', () => {
      fs.renameSync(path.join(copy, 'assets/hero-dark.svg'), path.join(copy, 'hero.moved'));
      try {
        assert.ok(checkSite(copy).includes("index.html: assets/hero-dark.svg points at a file the site doesn't have"));
      } finally {
        fs.renameSync(path.join(copy, 'hero.moved'), path.join(copy, 'assets/hero-dark.svg'));
      }
    });

    test('finds a page without a title', () => {
      const problems = plant('changelog.html', html => html.replace(/<title>[^<]*<\/title>/, '<title></title>'));
      assert.deepEqual(problems, ['changelog.html: no <title>']);
    });

    test('finds a page without its Markdown copy, or without a link to it', () => {
      fs.renameSync(path.join(copy, 'docs/lanes.md'), path.join(copy, 'lanes.moved'));
      try {
        assert.ok(checkSite(copy).includes('docs/lanes.html: no Markdown copy at docs/lanes.md'));
      } finally {
        fs.renameSync(path.join(copy, 'lanes.moved'), path.join(copy, 'docs/lanes.md'));
      }
      const problems = plant('docs/lanes.html', html => html.replaceAll(' href="lanes.md"', ' href="getting-started.md"'));
      assert.deepEqual(problems, ['docs/lanes.html: no link to its Markdown copy']);
    });

    test('finds a page llms.txt leaves out, and a link in it that goes nowhere', () => {
      const problems = plant('llms.txt', text =>
        text.replace(/^- \[[^\]]+\]\(docs\/lanes\.md\).*\n/m, '').replace('(docs/setup.md)', '(docs/set-up.md)'),
      );
      assert.deepEqual(problems, [
        "llms.txt: docs/set-up.md points at a file the site doesn't have",
        "llms.txt: doesn't list docs/lanes.md",
        "llms.txt: doesn't list docs/setup.md",
      ]);
    });

    test('finds a request to another origin and a link that is not relative', () => {
      const problems = plant('index.html', html =>
        html
          .replace('href="assets/site.css"', 'href="https://cdn.example.com/site.css"')
          .replace('href="changelog.html"', 'href="/changelog.html"'),
      );
      assert.deepEqual(problems, [
        'index.html: loads https://cdn.example.com/site.css from another origin',
        'index.html: /changelog.html is not relative',
      ]);
    });
  });

  describe('the reference checks', () => {
    test('find a command, a flag and a variable the CLI and the source lack', () => {
      const problems = checkFacts([
        {
          file: 'planted',
          markdown:
            'Run `npx agentlane deploy`, then:\n\n```sh\nnode_modules/.bin/agentlane up --fast\n```\n\n`AGENTLANE_SPEED` is set.',
        },
      ]);
      assert.deepEqual(problems, [
        'planted: agentlane up has no --fast flag',
        'planted: agentlane deploy is not a command in agentlane --help',
        'planted: AGENTLANE_SPEED is not a variable the source sets or reads',
      ]);
    });

    test('find a CLI group, an MCP tool and a config table the pages leave out', () => {
      assert.deepEqual(referenceGaps('cli', source('cli').replace('<!-- generated: cli bench -->', '')), [
        'the CLI group bench',
        'the command bench',
      ]);
      assert.deepEqual(referenceGaps('mcp', source('mcp').replace('<!-- generated: mcp run -->', '')), ['the MCP tool run']);
      assert.deepEqual(
        referenceGaps(
          'config',
          source('config').replace('## hygiene', '## Hygiene').replace('<!-- generated: config driver -->', ''),
        ),
        ['the config section hygiene', 'the config table driver'],
      );
    });

    test('find a variable the environment page leaves out', () => {
      assert.deepEqual(undocumentedVariables(source('environment').replaceAll('AGENTLANE_MAESTRO', 'MAESTRO')), [
        'AGENTLANE_MAESTRO',
      ]);
    });
  });
});
