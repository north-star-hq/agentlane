import fs from 'node:fs';
import path from 'node:path';
import type { Step } from './app.ts';
import { DEVICE, device, stepEnd } from './app.ts';
import type { Lane } from './scene.ts';
import { AGENT_NAMES, DEVICE_NAMES, FINISHER, LANES, PROJECT, TYPED } from './scene.ts';
import type { Palette, Theme } from './stage.ts';
import { APP_PALETTES, enter, escape, move, n, Scene } from './stage.ts';
import type { Style, Track } from './timeline.ts';
import { css, EASE } from './timeline.ts';
import type { Run } from './type.ts';
import { measure } from './type.ts';
import { agentMark, ANDROID_ATTRIBUTION, drawMark, markWidth, platformMark } from './marks.ts';

export type { Theme } from './stage.ts';
export const THEMES: readonly Theme[] = ['light', 'dark'];

export const WIDTH = 960;
export const HEIGHT = 540;

const BRAND = path.resolve(import.meta.dirname, '..', '..', 'brand');

const LEAN = 4 / 18;
const TOP = 100;
const BOTTOM = 506;
const BAND = 236;
const GAP = 26;
const STRIPE = 10;
const LEFT = Math.round((WIDTH - (LANES.length * BAND + (LANES.length - 1) * GAP + LEAN * (BOTTOM - TOP))) / 2);

const LABEL_Y = 216;
const DEVICE_TOP = 226;
const SHOTS_Y = 494;

const CHIP_W = 138;
const CHIP_MARK = { x: 11, size: 14 };
const CHIP_NAME_X = 32;
const CHIP_DOT_X = CHIP_W - 16;
const COMMAND_SIZE = 16;
export const COMMAND_PAD = 18;

const FREE = '#8E929B';
const TERMINAL = '#17191E';

const AT = {
  card: 0.1,
  chips: 0.35,
  connectors: 0.7,
  pill: 1.6,
  typing: 1.9,
  typed: 2.95,
  split: 3.1,
  lanes: 3.5,
  lit: 4.35,
  resources: 4.45,
  tiles: 4.7,
  shots: 4.95,
  done: 9.5,
  release: 10.0,
  empty: 10.25,
  fold: 10.5,
  freed: 10.95,
  fade: 13.2,
  reset: 13.8,
};

export const LOOP = 14.4;
export const STILL = 9.45;

export const SCRIPTS: readonly Step[][] = [
  [
    { do: 'add', at: 5.95 },
    { do: 'tick', item: 'Eggs', at: 8.4 },
    { do: 'tick', item: 'Tomatoes', at: 10.3 },
  ],
  [
    { do: 'tick', item: 'Lemons', at: 6.15 },
    { do: 'add', at: 7.0 },
  ],
  [
    { do: 'tick', item: 'Sourdough', at: 6.45 },
    { do: 'add', at: 7.35 },
    { do: 'tick', item: 'Lemons', at: 10.9 },
  ],
];

function tokens(theme: Theme): Palette {
  const source = fs.readFileSync(path.join(BRAND, 'tokens.css'), 'utf8');
  const selector = theme === 'light' ? ':root {' : ":root[data-theme='dark'] {";
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`brand/tokens.css has no ${selector} block`);
  const block = source.slice(start, source.indexOf('}', start));
  const read = (name: string): string => {
    const match = new RegExp(`--al-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (match?.[1] === undefined) throw new Error(`brand/tokens.css sets no --al-${name} for ${theme}`);
    return match[1].toUpperCase();
  };
  return {
    bg: read('bg'),
    surface: read('surface'),
    text: read('text'),
    muted: read('muted'),
    border: read('border'),
    accent: read('accent'),
    accentText: read('accent-text'),
    terminalEdge: theme === 'light' ? TERMINAL : '#33363E',
  };
}

function lockup(theme: Theme): { body: string; minY: number } {
  const source = fs.readFileSync(path.join(BRAND, `lockup-${theme}.svg`), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1]?.split(' ').map(Number);
  const open = source.indexOf('>', source.indexOf('<svg')) + 1;
  const body = source
    .slice(open, source.lastIndexOf('</svg>'))
    .replace(/<title>[^<]*<\/title>/, '')
    .trim();
  if (viewBox?.length !== 4 || body === '') throw new Error(`brand/lockup-${theme}.svg is not the lockup this script expects`);
  return { body, minY: viewBox[1] ?? 0 };
}

function laneX(lane: number, y: number): number {
  return LEFT + lane * (BAND + GAP) + LEAN * (BOTTOM - y);
}

function inside(lane: number, y: number): [number, number] {
  return [laneX(lane, y) + STRIPE, laneX(lane, y) + BAND];
}

function slanted(lane: number, inset: number, width: number): string {
  const corners = [
    [laneX(lane, BOTTOM) + inset, BOTTOM],
    [laneX(lane, BOTTOM) + inset + width, BOTTOM],
    [laneX(lane, TOP) + inset + width, TOP],
    [laneX(lane, TOP) + inset, TOP],
  ];
  return corners.map(([x, y]) => `${n(x ?? 0)},${n(y ?? 0)}`).join(' ');
}

function header(theme: Theme): string {
  const { body, minY } = lockup(theme);
  const scale = 24 / (32 * 2.59);
  return `<g transform="translate(32 22) scale(${n(scale)}) translate(0 ${n(-minY)})">${body}</g>`;
}

function projectCard(scene: Scene): string {
  const p = scene.palette;
  const id = scene.anim(
    { opacity: 0, scale: 0.96 },
    [enter(AT.card, 0.4), move(AT.split, 0.3, { opacity: 0, scale: 0.97 }, EASE.out)],
    'center',
  );
  const folder = `<path d="M24 28a4 4 0 0 1 4-4h9l4 4h11a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H28a4 4 0 0 1-4-4Z" fill="${p.border}" stroke="${p.muted}" stroke-width="1.5"/>`;
  return (
    `<g transform="translate(340 236)"><g ${id}>` +
    `<rect width="280" height="76" rx="12" fill="${p.surface}" stroke="${p.border}" stroke-width="1.5"/>${folder}` +
    scene.text({ text: PROJECT, face: 's8', size: 19, x: 72, y: 37, fill: p.text, fit: [64, 280] }) +
    scene.text({ text: `~/code/${PROJECT}`, face: 'm4', size: 12, x: 72, y: 56, fill: p.muted, fit: [64, 280] }) +
    `</g></g>`
  );
}

function chipStart(lane: number): [number, number] {
  return [480 + (lane - 1) * 160 - CHIP_W / 2, 158];
}

function chipHome(lane: number): [number, number] {
  return [laneX(lane, 140) + 22, 112];
}

function connectors(scene: Scene): string {
  const p = scene.palette;
  return LANES.map((_, lane) => {
    const [x] = chipStart(lane);
    const from = x + CHIP_W / 2;
    const to = 480 + (lane - 1) * 70;
    const id = scene.anim({ opacity: 1, dash: 1 }, [
      move(AT.connectors + lane * 0.08, 0.45, { dash: 0 }, EASE.out),
      move(AT.split, 0.2, { opacity: 0 }, EASE.out),
    ]);
    return `<path ${id} d="M${n(from)} 187C${n(from)} 212 ${n(to)} 210 ${n(to)} 235" pathLength="1" stroke-dasharray="1" fill="none" stroke="${p.muted}" stroke-width="1.5"/>`;
  }).join('');
}

function chip(scene: Scene, lane: number, data: Lane): string {
  const p = scene.palette;
  const [sx, sy] = chipStart(lane);
  const [hx, hy] = chipHome(lane);
  const finisher = lane === FINISHER;
  const out = finisher ? move(AT.fold, 0.35, { opacity: 0 }, EASE.out) : move(AT.fade, 0.5, { opacity: 0 }, EASE.out);
  const id = scene.anim({ opacity: 0, x: 0, y: 8 }, [
    move(AT.chips + lane * 0.12, 0.35, { opacity: 1, y: 0 }, EASE.out),
    move(AT.lanes + 0.05, 0.85, { x: hx - sx, y: hy - sy }, EASE.inOut),
    out,
  ]);
  const lit = AT.lit + lane * 0.1;
  const dotMoves = [move(lit, 0.25, { fill: p.accent }, EASE.plain)];
  if (finisher) dotMoves.push(move(AT.done, 0.2, { opacity: 0 }, EASE.out));
  const dot = scene.anim(finisher ? { fill: FREE, opacity: 1 } : { fill: FREE }, dotMoves);
  const check = finisher
    ? `<path ${scene.anim({ opacity: 0 }, [move(AT.done + 0.05, 0.25, { opacity: 1 }, EASE.out)])} d="M${n(CHIP_DOT_X - 5)} 14.5l3 3 6-7" fill="none" stroke="${p.text}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';
  const mark = agentMark(data.agent, scene.theme);
  const markW = markWidth(mark, CHIP_MARK.size);
  if (CHIP_MARK.x + markW > CHIP_NAME_X - 5) throw new Error(`the ${data.agent} mark crowds its name`);
  return (
    `<g transform="translate(${n(sx)} ${n(sy)})"><g ${id}>` +
    `<rect width="${String(CHIP_W)}" height="28" rx="14" fill="${p.surface}" stroke="${p.border}" stroke-width="1.5"/>` +
    drawMark(mark, CHIP_MARK.x + (CHIP_NAME_X - 5 - CHIP_MARK.x - markW) / 2, 14 - CHIP_MARK.size / 2, CHIP_MARK.size, p.text) +
    `<circle ${dot} cx="${String(CHIP_DOT_X)}" cy="14" r="4.5"/>${check}` +
    `<g class="chip">${scene.text({ text: AGENT_NAMES[data.agent], face: 's6', size: 13, x: CHIP_NAME_X, y: 18.6, fill: p.text, fit: [0, CHIP_DOT_X - 4.5], margin: 10 })}</g>` +
    `</g></g>`
  );
}

function command(scene: Scene): string {
  const textX = 40;
  const textWidth = measure(TYPED, 'm6', COMMAND_SIZE);
  const width = textX + textWidth + COMMAND_PAD;
  const left = 480 - width / 2;
  const top = 346;
  const scale = 0.8;
  const typing = TYPED.length * 0.07;
  const travel = scene.anim(
    { x: 0, y: 0, scale: 1 },
    [move(AT.split, 0.7, { x: 928 - width * scale - left, y: 37 - (44 * scale) / 2 - top, scale }, EASE.inOut)],
    '0 0',
  );
  const shown = scene.anim({ opacity: 0, scale: 0.96 }, [enter(AT.pill), move(AT.fade, 0.5, { opacity: 0 }, EASE.out)], 'center');
  const reveal = scene.anim({ x: 0 }, [move(AT.typing, typing, { x: textWidth }, `steps(${String(TYPED.length)},end)`)]);
  const caret = scene.anim({ x: 0, opacity: 1 }, [
    move(AT.typing, typing, { x: textWidth }, `steps(${String(TYPED.length)},end)`),
    move(AT.typed, 0.1, { opacity: 0 }, EASE.out),
  ]);
  const p = scene.palette;
  const clip = scene.clip(`<rect x="${n(textX - 2)}" y="8" width="${n(textWidth + 6)}" height="28"/>`);
  return (
    clip.def +
    `<g transform="translate(${n(left)} ${String(top)})"><g ${travel}><g ${shown}>` +
    `<rect width="${n(width)}" height="44" rx="22" fill="${TERMINAL}" stroke="${p.terminalEdge}" stroke-width="1.5"/>` +
    scene.text({ text: '$', face: 'm6', size: COMMAND_SIZE, x: 20, y: 27.5, fill: p.accent, fit: [0, textX] }) +
    `<g clip-path="url(#${clip.id})"><g class="typed">${scene.text({ text: TYPED, face: 'm6', size: COMMAND_SIZE, x: textX, y: 27.5, fill: '#F3F3F1', fit: [0, width], margin: COMMAND_PAD })}</g>` +
    `<rect ${reveal} x="${n(textX + 2)}" y="8" width="${n(textWidth + 6)}" height="28" fill="${TERMINAL}"/></g>` +
    `<rect ${caret} x="${n(textX)}" y="13" width="2" height="19" fill="#F3F3F1"/>` +
    `</g></g></g>`
  );
}

function resources(scene: Scene, lane: number, data: Lane): string {
  const p = scene.palette;
  const rows: [string, string][] = [
    ['dev server', `:${String(data.devServer)}`],
    ['api', `:${String(data.api)}`],
    ['database', data.database],
  ];
  return rows
    .map(([label, value], r) => {
      const y = 160 + r * 16.5;
      const x = laneX(lane, 176) + 24;
      const [, right] = inside(lane, y);
      const id = scene.anim({ opacity: 0, y: 4 }, [enter(AT.resources + lane * 0.1 + r * 0.07, 0.25)]);
      return (
        `<g ${id}>${scene.text({ text: label, face: 'm4', size: 11, x, y, fill: p.muted, fit: [x - 4, x + 80] })}` +
        `${scene.text({ text: value, face: 'm4', size: 11, x: x + 80, y, fill: p.text, fit: [x + 76, right] })}</g>`
      );
    })
    .join('');
}

function screenshots(scene: Scene, lane: number, times: number[]): string {
  const p = scene.palette;
  const y = SHOTS_Y;
  const x = laneX(lane, y - 6) + 24;
  const label = scene.anim({ opacity: 0 }, [move(AT.shots + lane * 0.1, 0.3, { opacity: 1 }, EASE.out)]);
  const labelWidth = measure('screenshots', 's4', 10.5);
  const [, right] = inside(lane, y);
  const thumbs = times
    .map((at, c) => {
      const id = scene.anim({ opacity: 0, scale: 0.85 }, [enter(at + 0.08, 0.2)], 'center');
      const tx = x + labelWidth + 10 + c * 19;
      if (tx + 14 > right - 6) throw new Error(`lane ${String(lane + 1)} has more screenshots than fit`);
      return (
        `<g ${id}><rect x="${n(tx)}" y="${String(y - 15)}" width="13" height="19" rx="2.5" fill="${p.bg}" stroke="${p.muted}" stroke-width="1.1"/>` +
        `<rect x="${n(tx + 3)}" y="${String(y - 11)}" width="7" height="2" rx="1" fill="${p.muted}"/>` +
        `<rect x="${n(tx + 3)}" y="${String(y - 7)}" width="5" height="2" rx="1" fill="${p.border}"/></g>`
      );
    })
    .join('');
  return `<g ${label}>${scene.text({ text: 'screenshots', face: 's4', size: 10.5, x, y: y - 2, fill: p.muted, fit: [x - 4, right] })}</g>${thumbs}`;
}

const PLATFORM_MARK_H: Record<Lane['platform'], number> = { web: 12.5, ios: 13.5, android: 8 };

function platformLabel(scene: Scene, platform: Lane['platform'], baseline: number, width: number): string {
  const p = scene.palette;
  const mark = platformMark(platform);
  const height = PLATFORM_MARK_H[platform];
  const markW = markWidth(mark, height);
  const textX = markW + 4.5;
  return (
    drawMark(mark, 0, baseline - 3.7 - height / 2, height, p.text) +
    scene.text({
      text: DEVICE_NAMES[platform],
      face: 's4',
      size: 10.5,
      x: textX,
      y: baseline,
      fill: p.muted,
      fit: [textX - 4, width],
    })
  );
}

function tile(scene: Scene, lane: number, data: Lane): { svg: string; shots: number[] } {
  const { w, h } = DEVICE;
  const [l, r] = inside(lane, DEVICE_TOP + h / 2);
  const left = l + (r - l - w) / 2;
  const [topLeft] = inside(lane, LABEL_Y - 10);
  const [, bottomRight] = inside(lane, DEVICE_TOP + h);
  if (left < topLeft + 2 || left + w > bottomRight - 2) throw new Error(`the ${data.platform} device does not fit its lane`);
  const shownAt = AT.tiles + lane * 0.1;
  const id = scene.anim({ opacity: 0, scale: 0.96 }, [enter(shownAt, 0.35)], 'center');
  const built = device(scene, { lane: data, steps: SCRIPTS[lane] ?? [], shownAt });
  return {
    svg:
      `<g transform="translate(${n(left)} ${String(DEVICE_TOP)})"><g ${id}>` +
      platformLabel(scene, data.platform, LABEL_Y - DEVICE_TOP - 2, w) +
      built.svg +
      `</g></g>`,
    shots: built.shots,
  };
}

function lane(scene: Scene, index: number, data: Lane): string {
  const p = scene.palette;
  const finisher = index === FINISHER;
  const slide = scene.anim({ x: (1 - index) * (BAND + GAP) }, [move(AT.lanes + 0.05, 0.85, { x: 0 }, EASE.inOut)]);
  const gone: Style = finisher ? { opacity: 0, scaleY: 0.02 } : { opacity: 0 };
  const shown = scene.anim(
    finisher ? { opacity: 0, scaleY: 1 } : { opacity: 0 },
    [
      move(AT.lanes, 0.3, { opacity: 1 }, EASE.out),
      finisher ? move(AT.fold, 0.5, gone, EASE.out) : move(AT.fade, 0.5, gone, EASE.out),
    ],
    finisher ? '50% 0' : undefined,
  );
  const lit = AT.lit + index * 0.1;
  const stripeMoves = [move(lit, 0.25, { fill: p.accent }, EASE.plain)];
  if (finisher) stripeMoves.push(move(AT.release, 0.3, { fill: FREE }, EASE.plain));
  const stripe = scene.anim({ fill: FREE }, stripeMoves);
  const label = scene.anim({ opacity: 0 }, [move(AT.lit, 0.3, { opacity: 1 }, EASE.out)]);
  const contents = finisher ? ` ${scene.anim({ opacity: 1 }, [move(AT.empty, 0.25, { opacity: 0 }, EASE.out)])}` : '';
  const labelX = laneX(index, TOP) + 2;
  const built = tile(scene, index, data);
  return (
    `<g ${slide}><g ${shown}>` +
    `<polygon points="${slanted(index, 0, BAND)}" fill="${p.surface}" stroke="${p.border}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<polygon ${stripe} points="${slanted(index, 0, STRIPE)}"/>` +
    `<g ${label}>${scene.text({ text: `lane ${String(index + 1)}`, face: 's4', size: 11, x: labelX, y: TOP - 9, fill: p.muted, fit: [labelX - 4, labelX + BAND] })}</g>` +
    `<g${contents}>` +
    resources(scene, index, data) +
    built.svg +
    screenshots(scene, index, built.shots) +
    `</g></g></g>`
  );
}

function released(scene: Scene): string {
  const p = scene.palette;
  const data = LANES[FINISHER];
  if (data === undefined) throw new Error('the finishing lane is not in the scene');
  const id = scene.anim({ opacity: 0, y: 6 }, [enter(AT.freed, 0.4), move(AT.fade, 0.5, { opacity: 0 }, EASE.out)]);
  const cx = laneX(FINISHER, 300) + BAND / 2 + STRIPE / 2;
  const fit = (y: number): [number, number] => inside(FINISHER, y - 14);
  return (
    `<g ${id}>` +
    `<polygon points="${slanted(FINISHER, 0, BAND)}" fill="none" stroke="${p.border}" stroke-width="1.5" stroke-dasharray="6 6"/>` +
    scene.text({
      text: `${AGENT_NAMES[data.agent]} is done`,
      face: 's8',
      size: 16,
      x: cx,
      y: 282,
      anchor: 'middle',
      fill: p.text,
      fit: fit(282),
      margin: 12,
    }) +
    scene.text({
      text: 'lane released',
      face: 's4',
      size: 13,
      x: cx,
      y: 304,
      anchor: 'middle',
      fill: p.muted,
      fit: fit(304),
      margin: 12,
    }) +
    scene.text({
      text: `:${String(data.devServer)} :${String(data.api)} free`,
      face: 'm4',
      size: 12,
      x: cx,
      y: 326,
      anchor: 'middle',
      fill: p.muted,
      fit: fit(326),
      margin: 12,
    }) +
    `</g>`
  );
}

export function describe(): string {
  const names = LANES.map(l => AGENT_NAMES[l.agent]);
  const devices = LANES.map(l => DEVICE_NAMES[l.platform]);
  const finisher = LANES[FINISHER];
  return (
    `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''} start on one project. ` +
    `The command ${TYPED} gives each its own lane: its own ports, dev server and database, ` +
    `plus ${devices.slice(0, -1).join(', ')} or ${devices.at(-1) ?? ''}. ` +
    `Each agent drives its own copy of the app, typing an item into the list and ticking items off, and takes screenshots. ` +
    `When ${finisher === undefined ? 'one agent' : AGENT_NAMES[finisher.agent]} is done, its lane is released and folds away, and the loop starts again.`
  );
}

function build(theme: Theme): { scene: Scene; body: string } {
  const scene = new Scene(theme, tokens(theme), APP_PALETTES[theme], AT.reset);
  for (const [i, data] of LANES.entries()) {
    const steps = SCRIPTS[i] ?? [];
    const last = Math.max(...steps.map(step => stepEnd(step, data)));
    const until = i === FINISHER ? AT.done : AT.fade;
    if (last + 0.6 > until) throw new Error(`lane ${String(i + 1)} is still working at ${String(last)} s`);
  }
  const body =
    header(theme) +
    LANES.map((data, i) => lane(scene, i, data)).join('') +
    released(scene) +
    connectors(scene) +
    projectCard(scene) +
    LANES.map((data, i) => chip(scene, i, data)).join('') +
    command(scene);
  return { scene, body };
}

export function sceneTracks(theme: Theme): Track[] {
  return build(theme).scene.tracks;
}

export function sceneText(theme: Theme): Run[] {
  return build(theme).scene.type.runs;
}

export function renderHero(theme: Theme): string {
  const { scene, body } = build(theme);
  const p = scene.palette;
  const style =
    scene.tracks.map(track => css(track, LOOP, STILL)).join('') +
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}.fx{visibility:hidden}}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-labelledby="title desc">` +
    `<title id="title">${escape(`What ${TYPED} does`)}</title><desc id="desc">${escape(describe())}</desc>` +
    `<style>${style}</style>` +
    `<defs>${scene.type.defs()}</defs>` +
    `<rect width="${String(WIDTH)}" height="${String(HEIGHT)}" rx="16" fill="${p.bg}" stroke="${p.border}" stroke-width="1"/>` +
    body +
    (LANES.some(l => l.platform === 'android') ? `<!-- ${ANDROID_ATTRIBUTION} -->` : '') +
    `</svg>\n`
  );
}
