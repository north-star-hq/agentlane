import fs from 'node:fs';
import path from 'node:path';
import { renderHero, THEMES } from './render.ts';

export const MEDIA = path.resolve(import.meta.dirname, '..', '..', 'media');

export function heroPath(theme: string): string {
  return path.join(MEDIA, `hero-${theme}.svg`);
}

if (import.meta.main) {
  fs.mkdirSync(MEDIA, { recursive: true });
  for (const theme of THEMES) {
    const svg = renderHero(theme);
    fs.writeFileSync(heroPath(theme), svg);
    console.log(`${path.relative(process.cwd(), heroPath(theme))}: ${String(Buffer.byteLength(svg))} bytes`);
  }
}
