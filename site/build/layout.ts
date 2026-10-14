import type { DocPage, Landing, Release, Section } from './content.ts';
import { escapeHtml, renderInline } from './markdown.ts';

export const REPO_URL = 'https://github.com/north-star-hq/agentlane';

type Current = { kind: 'landing' } | { kind: 'changelog' } | { kind: 'doc'; slug: string };

interface Shell {
  root: string;
  title: string;
  description: string;
  current: Current;
  sections: Section[];
  body: string;
  markdown: string;
}

const THEME_SCRIPT = `(function () {
  var key = 'agentlane-theme', root = document.documentElement, order = ['system', 'light', 'dark'];
  function stored() { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function store(value) { try { if (value === 'system') localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) {} }
  var saved = stored();
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', function () {
    var button = document.querySelector('.theme-toggle');
    if (!button) return;
    function label() {
      var theme = root.getAttribute('data-theme') || 'system';
      button.querySelector('span').textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
    }
    button.hidden = false;
    label();
    button.addEventListener('click', function () {
      var current = root.getAttribute('data-theme') || 'system';
      var next = order[(order.indexOf(current) + 1) % order.length];
      if (next === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', next);
      store(next);
      label();
    });
  });
})();`;

const NAV_SCRIPT = `(function () {
  var entry = window.performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
  if (!location.hash && !(entry && entry.type === 'back_forward')) window.scrollTo(0, 0);
  var sidebar = document.querySelector('.sidebar');
  var here = sidebar && sidebar.querySelector('[aria-current="page"]');
  if (here && here.offsetTop + here.offsetHeight > sidebar.clientHeight) sidebar.scrollTop = here.offsetTop - sidebar.clientHeight / 3;
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length) return;
  var headings = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
  function mark() {
    var line = document.querySelector('.topbar').offsetHeight + 48;
    var at = 0;
    headings.forEach(function (h, i) { if (h && h.getBoundingClientRect().top <= line) at = i; });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) at = headings.length - 1;
    links.forEach(function (a, i) { if (i === at) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
  }
  window.addEventListener('scroll', mark, { passive: true });
  mark();
})();`;

function attr(text: string): string {
  return escapeHtml(text);
}

function themed(root: string, name: string, alt: string, width: number, height: number, cls: string): string {
  return [
    `<img class="${cls} only-light" src="${root}assets/${name}-light.svg" alt="${attr(alt)}" width="${String(width)}" height="${String(height)}">`,
    `<img class="${cls} only-dark" src="${root}assets/${name}-dark.svg" alt="${attr(alt)}" width="${String(width)}" height="${String(height)}" loading="lazy">`,
  ].join('');
}

function hero(root: string, alt: string): string {
  return (['light', 'dark'] as const)
    .map(
      theme =>
        `<picture class="only-${theme}"><source media="(prefers-reduced-motion: reduce)" srcset="${root}assets/hero-${theme}-still.svg"><img class="hero-img" src="${root}assets/hero-${theme}.svg" alt="${attr(alt)}" width="960" height="540"${theme === 'dark' ? ' loading="lazy"' : ''}></picture>`,
    )
    .join('');
}

function docHref(root: string, slug: string): string {
  return `${root}docs/${slug}.html`;
}

function navList(root: string, current: Current, sections: Section[]): string {
  const here = (match: boolean) => (match ? ' aria-current="page"' : '');
  const groups = sections
    .map(section => {
      const items = section.pages
        .map(
          page =>
            `<li><a href="${docHref(root, page.slug)}"${here(current.kind === 'doc' && current.slug === page.slug)}><span class="nav-num">${page.number}</span>${escapeHtml(page.title)}</a></li>`,
        )
        .join('');
      return `<li class="nav-section"><p class="nav-title"><span class="nav-num">${section.number}</span>${escapeHtml(section.title)}</p><ol>${items}</ol></li>`;
    })
    .join('');
  return [
    `<ul class="nav-top"><li><a href="${root}index.html"${here(current.kind === 'landing')}>Overview</a></li></ul>`,
    `<ol class="nav-path">${groups}</ol>`,
    `<ul class="nav-top"><li><a href="${root}changelog.html"${here(current.kind === 'changelog')}>Changelog</a></li></ul>`,
  ].join('');
}

export function shell(page: Shell): string {
  const { root, current, sections } = page;
  const nav = navList(root, current, sections);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${attr(page.description)}">
<link rel="icon" href="${root}assets/mark.svg" type="image/svg+xml">
<link rel="preload" href="${root}assets/fonts/overpass.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${root}assets/tokens.css">
<link rel="stylesheet" href="${root}assets/site.css">
<link rel="alternate" type="text/markdown" href="${page.markdown}">
<script>${THEME_SCRIPT}</script>
</head>
<body class="kind-${current.kind}">
<a class="skip" href="#main">Skip to the content</a>
<header class="topbar">
  <a class="brand" href="${root}index.html">${themed(root, 'lockup', 'agentlane', 557, 150, 'lockup')}</a>
  <nav class="topnav" aria-label="Site">
    <a href="${docHref(root, 'getting-started')}">Docs</a>
    <a href="${root}changelog.html">Changelog</a>
    <a href="${REPO_URL}">GitHub</a>
  </nav>
  <button type="button" class="theme-toggle" hidden aria-label="Colour theme"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg><span>System</span></button>
</header>
<details class="menu">
  <summary>Pages</summary>
  <nav aria-label="Docs">${nav}</nav>
</details>
<div class="frame">
  <aside class="sidebar"><nav aria-label="Docs">${nav}</nav></aside>
  <main id="main">
${page.body}
  </main>
</div>
<footer class="footer">
  <p>agentlane is MIT licensed. Made by North Star.</p>
  <p><a href="${REPO_URL}">Source on GitHub</a> <a href="${root}changelog.html">Changelog</a> <a href="${page.markdown}">This page in Markdown</a> <a href="${root}llms.txt">llms.txt</a></p>
</footer>
<script>${NAV_SCRIPT}</script>
</body>
</html>
`;
}

export function landingBody(root: string, landing: Landing, sections: Section[], releases: Release[]): string {
  const steps = landing.install
    .map((step, i) => {
      const what = step.command
        ? `<pre class="cmd" tabindex="0"><code>${escapeHtml(step.command)}</code></pre>`
        : `<p class="prompt">${escapeHtml(step.prompt ?? '')}</p>`;
      return `<li><p class="step-label"><span class="step-num">${String(i + 1)}</span>${escapeHtml(step.label)}</p>${what}</li>`;
    })
    .join('');
  const agents = landing.agents.map(a => `<li>${escapeHtml(a)}</li>`).join('');
  const why = landing.why.map(w => `<li><h3>${escapeHtml(w.title)}</h3><p>${renderInline(w.text)}</p></li>`).join('');
  const stats = landing.speed.map(s => `<div><dt>${escapeHtml(s.value)}</dt><dd>${escapeHtml(s.label)}</dd></div>`).join('');
  const path = sections
    .map(section => {
      const pages = section.pages
        .map(
          page =>
            `<li><a href="${docHref(root, page.slug)}"><span class="path-page-num">${page.number}</span><span class="path-page-title">${escapeHtml(page.title)}</span><span class="path-page-short">${renderInline(page.short)}</span></a></li>`,
        )
        .join('');
      return `<li class="path-section"><h3><span class="path-num">${section.number}</span>${escapeHtml(section.title)}</h3><ol>${pages}</ol></li>`;
    })
    .join('');
  const recent = releases
    .filter(r => r.version !== 'Unreleased')
    .slice(0, 2)
    .map(
      r =>
        `<li><a href="${root}changelog.html#${r.id}"><span class="recent-version">${escapeHtml(r.version)}</span><span class="recent-lead">${escapeHtml(r.lead)}</span></a></li>`,
    )
    .join('');
  return `<div class="landing">
<section class="intro" aria-labelledby="headline">
  <div class="intro-text">
    <h1 id="headline">${escapeHtml(landing.headline)}</h1>
    <p class="pitch">${renderInline(landing.pitch)}</p>
    <div class="works-with"><p>Works with</p><ul>${agents}</ul></div>
  </div>
  <section class="install" aria-labelledby="install-title">
    <h2 id="install-title">Start in your project</h2>
    <ol class="steps">${steps}</ol>
    <p class="install-more"><a href="${docHref(root, 'getting-started')}">Getting started</a> walks through each step.</p>
  </section>
</section>
<figure class="hero">
  <div class="hero-stage">${hero(root, landing.heroAlt)}</div>
</figure>
<section class="why" aria-labelledby="why-title">
  <div class="path-head"><h2 id="why-title">Why agentlane</h2></div>
  <ul class="why-grid">${why}</ul>
</section>
<section class="speed-strip" aria-labelledby="speed-title">
  <div class="path-head"><h2 id="speed-title">Fast where agents spend their time</h2><p><a href="${docHref(root, 'speed')}">What makes it fast</a></p></div>
  <dl class="stats">${stats}</dl>
  <p class="stats-note">${renderInline(landing.speedNote)}</p>
</section>
<section class="path" aria-labelledby="path-title">
  <div class="path-head"><h2 id="path-title">The docs, in order</h2><p>From the first command to the full reference.</p></div>
  <ol class="path-sections">${path}</ol>
</section>
<section class="recent" aria-labelledby="recent-title">
  <div class="path-head"><h2 id="recent-title">Recent releases</h2><p><a href="${root}changelog.html">Every release</a></p></div>
  <ol class="recent-list">${recent}</ol>
</section>
</div>`;
}

function pager(root: string, previous: DocPage | undefined, next: DocPage | undefined): string {
  const card = (page: DocPage | undefined, label: string, cls: string) =>
    page
      ? `<a class="pager-${cls}" href="${docHref(root, page.slug)}"><span class="pager-label">${label}</span><span class="pager-title">${page.number} ${escapeHtml(page.title)}</span></a>`
      : '<span></span>';
  return `<nav class="pager" aria-label="Previous and next page">${card(previous, 'Previous', 'prev')}${card(next, 'Next', 'next')}</nav>`;
}

export function docBody(root: string, page: DocPage, previous: DocPage | undefined, next: DocPage | undefined): string {
  const toc = page.headings
    .filter(h => h.depth === 2)
    .map(h => `<li><a href="#${h.id}">${h.text.replace(/<[^>]*>/g, '')}</a></li>`)
    .join('');
  const note = page.outline
    ? '<p class="outline-note">This page is an outline. The headings are in place and the text is still to be written.</p>'
    : '';
  return `<article class="doc">
<header class="doc-head">
  <p class="doc-pos"><span class="doc-num">${page.number}</span>${escapeHtml(page.section)}<a class="doc-md" href="${page.slug}.md">Markdown</a></p>
  <h1>${escapeHtml(page.title)}</h1>
  <p class="lead">${renderInline(page.summary)}</p>
  ${note}
</header>
<div class="doc-grid">
  <div class="doc-main">
  <div class="prose">
${page.html}
  </div>
  ${pager(root, previous, next)}
  </div>
  <aside class="toc-col">${toc ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ol>${toc}</ol></nav>` : ''}</aside>
</div>
</article>`;
}

export function changelogBody(releases: Release[]): string {
  const entries = releases
    .map(
      r => `<section class="release" aria-labelledby="${r.id}">
  <h2 class="release-version" id="${r.id}">${escapeHtml(r.version)}</h2>
  <div class="prose">
${r.html}
  </div>
</section>`,
    )
    .join('\n');
  return `<article class="changelog">
<header class="doc-head">
  <h1>Changelog</h1>
  <p class="lead">What changed in each release of agentlane, newest first.</p>
</header>
${entries}
</article>`;
}
