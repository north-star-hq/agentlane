import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { heroPath } from '../scripts/hero/generate.ts';
import { agentMark, ANDROID_ATTRIBUTION, markFiles, MARKS, platformMark } from '../scripts/hero/marks.ts';
import { LOOP, renderHero, sceneText, sceneTracks, THEMES } from '../scripts/hero/render.ts';
import { AGENT_NAMES, COMMAND, LANES, TYPED } from '../scripts/hero/scene.ts';
import { seamless } from '../scripts/hero/timeline.ts';
import type { Face } from '../scripts/hero/type.ts';
import { FACES, font } from '../scripts/hero/type.ts';
import { CLI } from '../src/name.ts';
import { AGENTS } from '../src/registry/owner.ts';

const BUDGET = 200 * 1024;

const committed = (theme: string) => fs.readFileSync(heroPath(theme), 'utf8');

function isFace(name: string): name is Face {
  return name in FACES;
}

function decode(group: string): string {
  let text = '';
  let pen: number | null = null;
  for (const [, face, code, x] of group.matchAll(/<use href="#(\w+)-([0-9a-f]+)"(?: x="(-?\d+)")?\/>/g)) {
    assert.ok(face !== undefined && isFace(face), `unknown face ${String(face)}`);
    const f = font(face);
    const char = String.fromCodePoint(parseInt(code ?? '0', 16));
    const at = Number(x ?? 0);
    if (pen !== null) {
      const space = (f.advance(f.glyphOf(' ')) * 1000) / f.unitsPerEm;
      text += ' '.repeat(Math.max(0, Math.round((at - pen) / space)));
    }
    text += char;
    pen = at + (f.advance(f.glyphOf(char)) * 1000) / f.unitsPerEm;
  }
  return text;
}

function labelled(svg: string, name: string): string[] {
  return [...svg.matchAll(new RegExp(`<g class="${name}"><g [^>]*>((?:<use [^>]*/>)*)</g></g>`, 'g'))].map(([, uses]) =>
    decode(uses ?? ''),
  );
}

function keyframes(svg: string): Map<string, string> {
  return new Map(
    [...svg.matchAll(/@keyframes (\w+)\{((?:[\d.]+%\{[^}]*\})+)\}/g)].map(([, name, body]) => [name ?? '', body ?? '']),
  );
}

function declarationsAt(body: string, percent: string): string {
  const frame = new RegExp(`(?:^|\\})${percent.replace('.', '\\.')}%\\{([^}]*)\\}`).exec(body)?.[1];
  assert.ok(frame !== undefined, `no ${percent}% frame in ${body.slice(0, 80)}`);
  return frame.replace(/;?animation-timing-function:[^;]*/, '');
}

test('the committed hero SVGs are what the generator makes now', () => {
  for (const theme of THEMES) {
    assert.ok(
      committed(theme) === renderHero(theme),
      `media/hero-${theme}.svg is stale: run pnpm run hero and commit the result`,
    );
  }
});

test('each hero SVG stays under 200 KB', () => {
  for (const theme of THEMES) {
    const bytes = fs.statSync(heroPath(theme)).size;
    assert.ok(bytes < BUDGET, `media/hero-${theme}.svg is ${String(bytes)} bytes`);
  }
});

test('every animation runs once per 12 to 20 second loop and ends the loop where it began', () => {
  for (const theme of THEMES) {
    const svg = committed(theme);
    const durations = [...svg.matchAll(/animation:k\w+ ([\d.]+)s linear infinite/g)].map(([, seconds]) => Number(seconds));
    assert.ok(durations.length > 20, `${theme}: found ${String(durations.length)} animations`);
    assert.deepEqual(new Set(durations), new Set([LOOP]));
    const loop = durations[0] ?? 0;
    assert.ok(loop >= 12 && loop <= 20, `${theme}: the loop is ${String(loop)} s`);
    const frames = keyframes(svg);
    assert.equal(frames.size, durations.length);
    for (const [name, body] of frames) {
      assert.equal(declarationsAt(body, '0'), declarationsAt(body, '100'), `${theme}: ${name} jumps at the loop seam`);
    }
    for (const track of sceneTracks(theme)) assert.ok(seamless(track, LOOP), track.id);
  }
});

test('the hero types the toolkit command and names only agents the toolkit supports', () => {
  assert.equal(COMMAND, path.posix.basename(CLI));
  assert.equal(TYPED, `${path.posix.basename(CLI)} up`);
  assert.deepEqual(Object.keys(AGENT_NAMES).sort(), [...AGENTS].sort());
  for (const lane of LANES)
    assert.ok((AGENTS as readonly string[]).includes(lane.agent), `${lane.agent} is not an agent the toolkit wires`);
  for (const theme of THEMES) {
    const svg = committed(theme);
    assert.deepEqual(labelled(svg, 'typed'), [`${path.posix.basename(CLI)} up`]);
    assert.deepEqual(
      labelled(svg, 'chip'),
      LANES.map(lane => AGENT_NAMES[lane.agent]),
    );
  }
});

test('all text is outlined from the bundled fonts and fits its box with room to spare', () => {
  for (const theme of THEMES) {
    const svg = committed(theme);
    assert.doesNotMatch(svg, /<text|font-family|@font-face/);
    const defined = new Set([...svg.matchAll(/<path id="(\w+-[0-9a-f]+)"/g)].map(([, id]) => id));
    const used = new Set([...svg.matchAll(/<use href="#([^"]+)"/g)].map(([, id]) => id));
    assert.ok(used.size > 50, `${theme}: only ${String(used.size)} glyphs in use`);
    assert.deepEqual(
      [...used].filter(id => !defined.has(id)),
      [],
      `${theme}: glyphs used but not defined`,
    );
    assert.deepEqual(
      [...defined].filter(id => !used.has(id)),
      [],
      `${theme}: glyphs defined but not used`,
    );
    const runs = sceneText(theme);
    assert.ok(runs.length > 50, `${theme}: only ${String(runs.length)} text runs`);
    for (const run of runs) {
      const room = Math.min(run.left - run.fit[0], run.fit[1] - run.right);
      assert.ok(room >= run.margin, `${theme}: "${run.text}" has ${room.toFixed(2)} px of room, needs ${String(run.margin)}`);
    }
    const command = runs.find(run => run.text === TYPED);
    assert.ok(command !== undefined && command.fit[1] - command.right >= 16, `${theme}: the command pill is tight`);
  }
});

test('each hero SVG is a self-contained accessible image', () => {
  for (const theme of THEMES) {
    const svg = committed(theme);
    assert.match(svg, /^<svg [^>]*role="img"[^>]*aria-labelledby="title desc"/);
    assert.match(svg, /<title id="title">[^<]+<\/title><desc id="desc">[^<]{80,}<\/desc>/);
    assert.match(svg, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important\}\.fx\{visibility:hidden\}\}/);
    assert.doesNotMatch(svg, /<script|<!DOCTYPE|<!ENTITY|href="(?!#)|@import|url\((?!#)/i);
  }
});

test('the marks are self-contained outlines, each with its source recorded', () => {
  const files = fs.readdirSync(MARKS).filter(name => name.endsWith('.svg'));
  assert.deepEqual(files.sort(), markFiles());
  const sources = fs.readFileSync(path.join(MARKS, 'SOURCES.md'), 'utf8');
  for (const file of files) {
    const svg = fs.readFileSync(path.join(MARKS, file), 'utf8');
    assert.doesNotMatch(
      svg,
      /<!DOCTYPE|<!ENTITY|<text|<image|<script|font-family|@font-face|@import|href="(?!#)|url\((?!#)/i,
      file,
    );
    assert.ok(sources.includes(`\`${file}\``), `SOURCES.md does not record ${file}`);
  }
});

test('each lane shows its agent mark and its platform mark, with the Android attribution', () => {
  for (const theme of THEMES) {
    const svg = committed(theme);
    for (const lane of LANES) {
      for (const mark of [agentMark(lane.agent, theme), platformMark(lane.platform)]) {
        for (const shape of mark.paths) assert.ok(svg.includes(shape), `${theme}: ${lane.agent}/${lane.platform} mark missing`);
      }
    }
    assert.equal(
      svg.includes(ANDROID_ATTRIBUTION),
      LANES.some(lane => lane.platform === 'android'),
    );
  }
});
