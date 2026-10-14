export const EASE = {
  out: 'cubic-bezier(0.23,1,0.32,1)',
  inOut: 'cubic-bezier(0.77,0,0.175,1)',
  plain: 'ease',
  linear: 'linear',
} as const;

export type Ease = (typeof EASE)[keyof typeof EASE] | `steps(${string},end)`;

export interface Style {
  opacity?: number;
  x?: number;
  y?: number;
  scale?: number;
  scaleY?: number;
  fill?: string;
  dash?: number;
}

export interface Move {
  at: number;
  dur: number;
  to: Style;
  ease: Ease;
}

export interface Track {
  id: string;
  from: Style;
  moves: Move[];
  origin?: string;
}

interface Key {
  at: number;
  style: Style;
  ease: Ease | null;
}

function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function hasTransform(style: Style): boolean {
  return style.x !== undefined || style.y !== undefined || style.scale !== undefined || style.scaleY !== undefined;
}

export function declarations(style: Style, transform: boolean): string {
  const parts: string[] = [];
  if (style.opacity !== undefined) parts.push(`opacity:${num(style.opacity)}`);
  if (transform) {
    const sx = style.scale ?? 1;
    const sy = style.scaleY ?? sx;
    parts.push(`transform:translate(${num(style.x ?? 0)}px,${num(style.y ?? 0)}px) scale(${num(sx)},${num(sy)})`);
  }
  if (style.fill !== undefined) parts.push(`fill:${style.fill}`);
  if (style.dash !== undefined) parts.push(`stroke-dashoffset:${num(style.dash)}`);
  return parts.join(';');
}

function same(a: Style, b: Style): boolean {
  return declarations(a, true) === declarations(b, true);
}

function keysOf(track: Track, loop: number): Key[] {
  const keys: Key[] = [{ at: 0, style: track.from, ease: null }];
  const moves = [...track.moves].sort((a, b) => a.at - b.at);
  for (const move of moves) {
    const last = keys[keys.length - 1];
    if (last === undefined) throw new Error('unreachable');
    if (move.at < last.at - 1e-9) throw new Error(`${track.id}: a move at ${String(move.at)}s overlaps the one before it`);
    if (move.at + move.dur > loop + 1e-9) throw new Error(`${track.id}: a move runs past the loop`);
    if (move.at > last.at + 1e-9) keys.push({ at: move.at, style: last.style, ease: move.ease });
    else last.ease = move.ease;
    keys.push({ at: move.at + move.dur, style: { ...last.style, ...move.to }, ease: null });
  }
  const end = keys[keys.length - 1];
  if (end === undefined) throw new Error('unreachable');
  if (!same(end.style, track.from)) throw new Error(`${track.id}: the loop ends in a different state than it starts`);
  if (end.at < loop - 1e-9) keys.push({ at: loop, style: end.style, ease: null });
  return keys;
}

export function styleAt(track: Track, loop: number, time: number): Style {
  let style = track.from;
  for (const key of keysOf(track, loop)) if (key.at <= time + 1e-9) style = key.style;
  return style;
}

export function seamless(track: Track, loop: number): boolean {
  const keys = keysOf(track, loop);
  const first = keys[0];
  const last = keys[keys.length - 1];
  return first !== undefined && last !== undefined && first.at === 0 && last.at === loop && same(first.style, last.style);
}

export function css(track: Track, loop: number, still: number): string {
  const keys = keysOf(track, loop);
  const transform = keys.some(key => hasTransform(key.style));
  const frames = keys
    .map(key => {
      const ease = key.ease === null ? '' : `;animation-timing-function:${key.ease}`;
      return `${num((key.at / loop) * 100)}%{${declarations(key.style, transform)}${ease}}`;
    })
    .join('');
  const origin = track.origin === undefined ? '' : `;transform-box:fill-box;transform-origin:${track.origin}`;
  const rest = declarations(styleAt(track, loop, still), transform);
  return `#${track.id}{${rest};animation:k${track.id} ${num(loop)}s linear infinite${origin}}@keyframes k${track.id}{${frames}}`;
}
