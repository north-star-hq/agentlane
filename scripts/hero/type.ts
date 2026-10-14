import path from 'node:path';
import type { Font } from './font.ts';
import { pathData, readFont } from './font.ts';

const FONTS = path.resolve(import.meta.dirname, 'fonts');

export const FACES = {
  s4: 'overpass-sans-400.ttf',
  s6: 'overpass-sans-600.ttf',
  s8: 'overpass-sans-800.ttf',
  m4: 'overpass-mono-400.ttf',
  m6: 'overpass-mono-600.ttf',
} as const;

export type Face = keyof typeof FACES;

const EM = 1000;
export const MARGIN = 4;

const loaded = new Map<Face, Font>();

export function font(face: Face): Font {
  let found = loaded.get(face);
  if (found === undefined) {
    found = readFont(path.join(FONTS, FACES[face]));
    loaded.set(face, found);
  }
  return found;
}

export function glyphId(face: Face, char: string): string {
  return `${face}-${(char.codePointAt(0) ?? 0).toString(16)}`;
}

interface Placed {
  char: string;
  x: number;
}

function layout(text: string, face: Face): { glyphs: Placed[]; advance: number } {
  const f = font(face);
  const unit = EM / f.unitsPerEm;
  const glyphs: Placed[] = [];
  let x = 0;
  let previous: number | null = null;
  for (const char of text) {
    const glyph = f.glyphOf(char);
    if (previous !== null) x += f.kern(previous, glyph) * unit;
    glyphs.push({ char, x });
    x += f.advance(glyph) * unit;
    previous = glyph;
  }
  return { glyphs, advance: x };
}

export function measure(text: string, face: Face, size: number): number {
  return (layout(text, face).advance * size) / EM;
}

export type Anchor = 'start' | 'middle' | 'end';

export interface TextSpec {
  text: string;
  face: Face;
  size: number;
  x: number;
  y: number;
  fill?: string;
  anchor?: Anchor;
  fit: readonly [number, number];
  margin?: number;
}

export interface Run {
  text: string;
  face: Face;
  size: number;
  left: number;
  right: number;
  fit: readonly [number, number];
  margin: number;
}

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export class Typesetter {
  readonly runs: Run[] = [];
  private readonly used = new Map<Face, Set<string>>();

  text(spec: TextSpec): string {
    const { glyphs, advance } = layout(spec.text, spec.face);
    const width = (advance * spec.size) / EM;
    const anchor = spec.anchor ?? 'start';
    const left = anchor === 'start' ? spec.x : anchor === 'middle' ? spec.x - width / 2 : spec.x - width;
    const run: Run = {
      text: spec.text,
      face: spec.face,
      size: spec.size,
      left,
      right: left + width,
      fit: spec.fit,
      margin: spec.margin ?? MARGIN,
    };
    if (run.left - run.fit[0] < run.margin - 1e-6 || run.fit[1] - run.right < run.margin - 1e-6) {
      throw new Error(
        `"${spec.text}" spans ${n(run.left)} to ${n(run.right)}, which leaves less than ${String(run.margin)} px inside ${n(run.fit[0])} to ${n(run.fit[1])}`,
      );
    }
    this.runs.push(run);
    let set = this.used.get(spec.face);
    if (set === undefined) {
      set = new Set();
      this.used.set(spec.face, set);
    }
    const uses = glyphs
      .filter(g => g.char !== ' ')
      .map(g => {
        set.add(g.char);
        const x = Math.round(g.x);
        return `<use href="#${glyphId(spec.face, g.char)}"${x === 0 ? '' : ` x="${String(x)}"`}/>`;
      })
      .join('');
    const fill = spec.fill === undefined ? '' : ` fill="${spec.fill}"`;
    return `<g transform="translate(${n(left)} ${n(spec.y)}) scale(${String(spec.size / EM)})"${fill}>${uses}</g>`;
  }

  defs(): string {
    const paths: string[] = [];
    for (const [face, chars] of [...this.used].sort(([a], [b]) => a.localeCompare(b))) {
      const f = font(face);
      for (const char of [...chars].sort()) {
        paths.push(`<path id="${glyphId(face, char)}" d="${pathData(f.outline(f.glyphOf(char)), EM / f.unitsPerEm)}"/>`);
      }
    }
    return paths.join('');
  }
}
