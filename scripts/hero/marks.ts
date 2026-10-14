import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../../src/registry/owner.ts';
import type { Platform } from './scene.ts';
import type { Theme } from './stage.ts';
import { n } from './stage.ts';

export const MARKS = path.resolve(import.meta.dirname, 'marks');

type Box = readonly [number, number, number, number];

interface Source {
  file: string;
  box: Box;
}

export interface Mark {
  box: Box;
  paths: string[];
}

const GLYPH_BOX = { globe: [2.1, 2.1, 19.8, 19.8], phone: [5.1, 1.6, 13.8, 20.8], terminal: [1.6, 2.6, 20.8, 18.8] } as const;

const BLOSSOM: Box = [180.5, 180.5, 354.67, 354.67];
const CUBE: Box = [0, 0, 466.73, 532.09];
const ROBOT_HEAD: Box = [0.46, 0.56, 151, 88];

const AGENT_MARKS: Partial<Record<Agent, Record<Theme, Source>>> = {
  claude: {
    light: { file: 'terminal.svg', box: GLYPH_BOX.terminal },
    dark: { file: 'terminal.svg', box: GLYPH_BOX.terminal },
  },
  codex: {
    light: { file: 'openai-blossom-black.svg', box: BLOSSOM },
    dark: { file: 'openai-blossom-white.svg', box: BLOSSOM },
  },
  cursor: {
    light: { file: 'cursor-cube-2d-light.svg', box: CUBE },
    dark: { file: 'cursor-cube-2d-dark.svg', box: CUBE },
  },
};

const PLATFORM_MARKS: Record<Platform, Source> = {
  web: { file: 'globe.svg', box: GLYPH_BOX.globe },
  ios: { file: 'phone.svg', box: GLYPH_BOX.phone },
  android: { file: 'android-head-flat.svg', box: ROBOT_HEAD },
};

export const ANDROID_ATTRIBUTION =
  'The Android robot is reproduced or modified from work created and shared by Google and used according to terms described in the Creative Commons 3.0 Attribution License.';

const KEPT = ['d', 'fill', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity'];

export function markFiles(): string[] {
  const sources = [...Object.values(AGENT_MARKS).flatMap(m => [m.light, m.dark]), ...Object.values(PLATFORM_MARKS)];
  return [...new Set(sources.map(s => s.file))].sort();
}

function read(source: Source): Mark {
  const raw = fs.readFileSync(path.join(MARKS, source.file), 'utf8');
  const svg = raw
    .replace(/<\?xml[^>]*>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<clipPath[\s\S]*?<\/clipPath>/g, '');
  const classes = new Map(
    [...svg.matchAll(/\.([\w-]+)\s*\{\s*fill:\s*(#[0-9a-fA-F]{3,6})\s*;?\s*\}/g)].map(([, name, fill]) => [name, fill]),
  );
  const paths = [...svg.matchAll(/<path\s([^>]*?)\/?>/g)].map(([, attributes]) => {
    const found = new Map([...(attributes ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k ?? '', v ?? '']));
    const cls = found.get('class');
    if (cls !== undefined && !found.has('fill')) found.set('fill', classes.get(cls) ?? '');
    if (!found.has('d')) throw new Error(`${source.file} has a path without d`);
    return `<path ${KEPT.filter(k => found.has(k))
      .map(k => `${k}="${found.get(k) ?? ''}"`)
      .join(' ')}/>`;
  });
  if (paths.length === 0) throw new Error(`${source.file} has no paths`);
  return { box: source.box, paths };
}

export function agentMark(agent: Agent, theme: Theme): Mark {
  const source = AGENT_MARKS[agent]?.[theme];
  if (source === undefined) throw new Error(`no mark for ${agent}`);
  return read(source);
}

export function platformMark(platform: Platform): Mark {
  return read(PLATFORM_MARKS[platform]);
}

export function markWidth(mark: Mark, height: number): number {
  return (mark.box[2] * height) / mark.box[3];
}

export function drawMark(mark: Mark, x: number, y: number, height: number, colour: string): string {
  const [bx, by, , bh] = mark.box;
  const k = height / bh;
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${String(Math.round(k * 1e5) / 1e5)}) translate(${n(-bx)} ${n(-by)})" color="${colour}">${mark.paths.join('')}</g>`;
}
