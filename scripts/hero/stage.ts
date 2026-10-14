import type { Ease, Move, Style, Track } from './timeline.ts';
import { EASE } from './timeline.ts';
import type { TextSpec } from './type.ts';
import { Typesetter } from './type.ts';

export type Theme = 'light' | 'dark';

export interface Palette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  terminalEdge: string;
}

export interface AppPalette {
  page: string;
  card: string;
  field: string;
  text: string;
  muted: string;
  line: string;
  green: string;
  onGreen: string;
  greenSoft: string;
  frame: string;
  frameEdge: string;
  cutout: string;
  flash: number;
}

export const APP_PALETTES: Record<Theme, AppPalette> = {
  light: {
    page: '#F6F7F4',
    card: '#FFFFFF',
    field: '#FFFFFF',
    text: '#16181C',
    muted: '#6B6F76',
    line: '#E1E3DD',
    green: '#1F8A5B',
    onGreen: '#FFFFFF',
    greenSoft: '#DDF0E5',
    frame: '#ECEDE9',
    frameEdge: '#CDCFC9',
    cutout: '#1E2024',
    flash: 0.45,
  },
  dark: {
    page: '#14161A',
    card: '#1E2126',
    field: '#1E2126',
    text: '#F1F2EF',
    muted: '#9A9EA6',
    line: '#2E3238',
    green: '#3DBE7E',
    onGreen: '#0B2417',
    greenSoft: '#173526',
    frame: '#24272D',
    frameEdge: '#3A3E46',
    cutout: '#050506',
    flash: 0.22,
  },
};

export class Scene {
  readonly tracks: Track[] = [];
  readonly type = new Typesetter();
  readonly palette: Palette;
  readonly app: AppPalette;
  readonly reset: number;
  readonly theme: Theme;
  private clips = 0;

  constructor(theme: Theme, palette: Palette, app: AppPalette, reset: number) {
    this.theme = theme;
    this.palette = palette;
    this.app = app;
    this.reset = reset;
  }

  anim(from: Style, moves: Move[], origin?: string): string {
    const id = `a${String(this.tracks.length)}`;
    const all = [...moves, set(this.reset, from)];
    this.tracks.push(origin === undefined ? { id, from, moves: all } : { id, from, moves: all, origin });
    return `id="${id}"`;
  }

  text(spec: TextSpec): string {
    return this.type.text(spec);
  }

  clip(shape: string): { id: string; def: string } {
    const id = `c${String(this.clips++)}`;
    return { id, def: `<clipPath id="${id}">${shape}</clipPath>` };
  }
}

export function move(at: number, dur: number, to: Style, ease: Ease): Move {
  return { at, dur, to, ease };
}

export function set(at: number, to: Style): Move {
  return { at, dur: 0.01, to, ease: EASE.linear };
}

export function enter(at: number, dur = 0.3): Move {
  return move(at, dur, { opacity: 1, scale: 1, y: 0 }, EASE.out);
}

export function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
