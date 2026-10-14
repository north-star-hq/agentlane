import type { Lane, Platform } from './scene.ts';
import { ADDED_COLOUR, APP, ITEMS } from './scene.ts';
import type { Scene } from './stage.ts';
import { enter, move, n, set } from './stage.ts';
import type { Move, Style } from './timeline.ts';
import { EASE } from './timeline.ts';
import { measure } from './type.ts';

export type Step = { do: 'add'; at: number } | { do: 'tick'; item: string; at: number };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEVICE = { w: 124, h: 244 };

const COLUMN_W = 114;

interface Frame {
  screen: Rect;
  radius: number;
  content: { x: number; y: number };
}

const PHONE_SCREEN: Rect = { x: 5, y: 5, w: 114, h: 234 };
const STATUS_H = 25;
const HOME_H = 9;
const BROWSER_BAR = 30;
const CONTENT_H = PHONE_SCREEN.h - STATUS_H - HOME_H;

export const FRAMES: Record<Platform, Frame> = {
  web: {
    screen: { x: 1, y: BROWSER_BAR, w: DEVICE.w - 2, h: DEVICE.h - BROWSER_BAR - 1 },
    radius: 7,
    content: { x: 5, y: BROWSER_BAR },
  },
  ios: {
    screen: PHONE_SCREEN,
    radius: 16,
    content: { x: 5, y: 5 + STATUS_H },
  },
  android: {
    screen: PHONE_SCREEN,
    radius: 10,
    content: { x: 5, y: 5 + STATUS_H },
  },
};

const FIELD: Rect = { x: 6, y: 26, w: 102, h: 20 };
const BUTTON = { x: FIELD.x + FIELD.w - 10, y: FIELD.y + FIELD.h / 2, r: 7 };
const LIST = { top: 54, rowH: 25, cardH: 21, x: 6, w: 102 };
const CHECK_X = LIST.x + 11;
const NAME = { face: 's6', size: 9.5, x: LIST.x + 31 } as const;
const FIELD_TEXT = { face: 's4', size: 8.5, x: FIELD.x + 9 } as const;
const CHAR_GAP = 0.1;

interface Timeline {
  focus: number;
  chars: number[];
  submit: number;
  returnTap: number;
  end: number;
}

export function addTimes(at: number, text: string): Timeline {
  const typing = at + 0.35;
  const chars = Array.from({ length: text.length }, (_, i) => typing + i * CHAR_GAP);
  const typed = (chars.at(-1) ?? typing) + CHAR_GAP;
  const returnTap = typed + 0.3;
  const submit = returnTap + 0.05;
  return { focus: at + 0.05, chars, submit, returnTap, end: submit + 0.45 };
}

export function stepEnd(step: Step, lane: Lane): number {
  return step.do === 'add' ? addTimes(step.at, lane.adds).end : step.at + 0.45;
}

export function shotTimes(steps: Step[], lane: Lane): number[] {
  return steps.map(step => stepEnd(step, lane) + 0.15);
}

function basketGlyph(x: number, y: number, size: number, colour: string): string {
  const k = size / 10;
  return (
    `<path transform="translate(${n(x)} ${n(y)}) scale(${n(k)})" fill="none" stroke="${colour}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ` +
    `d="M1.5 4.2h7l-.9 4.3H2.4ZM3 4.2 4.6 1.5M7 4.2 5.4 1.5M4 5.8v1.2M6 5.8v1.2"/>`
  );
}

function check(scene: Scene, cy: number, tick: number | null): string {
  const a = scene.app;
  const r = 5;
  const outline = `<circle cx="${n(CHECK_X)}" cy="${n(cy)}" r="${String(r)}" fill="none" stroke="${a.muted}" stroke-width="1"/>`;
  if (tick === null) return outline;
  const filled = `<circle ${scene.anim({ opacity: 0, scale: 0.6 }, [enter(tick + 0.05, 0.2)], 'center')} cx="${n(CHECK_X)}" cy="${n(cy)}" r="${String(r)}" fill="${a.green}"/>`;
  const mark = `<path ${scene.anim({ dash: 1 }, [move(tick + 0.1, 0.25, { dash: 0 }, EASE.out)])} pathLength="1" stroke-dasharray="1" d="M${n(CHECK_X - 2.4)} ${n(cy + 0.1)}l1.7 1.8 3.3-3.6" fill="none" stroke="${a.onGreen}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`;
  return outline + filled + mark;
}

function row(scene: Scene, y: number, name: string, colour: string, tick: number | null): string {
  const a = scene.app;
  const cy = y + LIST.cardH / 2;
  const width = measure(name, NAME.face, NAME.size);
  const run = scene.text({
    text: name,
    face: NAME.face,
    size: NAME.size,
    x: NAME.x,
    y: cy + 3.3,
    fit: [NAME.x - 4, LIST.x + LIST.w],
  });
  let label: string;
  if (tick === null) {
    label = `<g fill="${a.text}">${run}</g>`;
  } else {
    const fade = scene.anim({ fill: a.text }, [move(tick + 0.1, 0.25, { fill: a.muted }, EASE.plain)]);
    const strike = scene.anim({ dash: 1 }, [move(tick + 0.15, 0.3, { dash: 0 }, EASE.out)]);
    label =
      `<g ${fade}>${run}</g>` +
      `<path ${strike} pathLength="1" stroke-dasharray="1" d="M${n(NAME.x - 0.5)} ${n(cy)}h${n(width + 1)}" stroke="${a.muted}" stroke-width=".9"/>`;
  }
  return (
    `<rect x="${n(LIST.x)}" y="${n(y)}" width="${n(LIST.w)}" height="${n(LIST.cardH)}" rx="6" fill="${a.card}" stroke="${a.line}" stroke-width=".8"/>` +
    check(scene, cy, tick) +
    `<circle cx="${n(LIST.x + 23)}" cy="${n(cy)}" r="3.2" fill="${colour}"/>` +
    label
  );
}

interface Touch {
  x: number;
  y: number;
  at: number;
}

function touches(scene: Scene, list: Touch[]): string {
  const moves: Move[] = [];
  let free = 0;
  for (const t of [...list].sort((p, q) => p.at - q.at)) {
    const start = Math.max(free, t.at - 0.04);
    moves.push(set(start, { x: t.x, y: t.y, scale: 0.8 }));
    moves.push(move(Math.max(start + 0.01, t.at), 0.12, { opacity: 1, scale: 1 }, EASE.out));
    moves.push(move(t.at + 0.2, 0.22, { opacity: 0, scale: 1.25 }, EASE.out));
    free = t.at + 0.42;
  }
  const first = list[0];
  const from: Style = { opacity: 0, x: first?.x ?? 0, y: first?.y ?? 0, scale: 0.8 };
  return `<circle ${scene.anim(from, moves, 'center')} class="fx" r="7" fill="${scene.palette.accent}" fill-opacity=".6" stroke="${scene.app.page}" stroke-width="1.5"/>`;
}

function pointer(scene: Scene, rest: { x: number; y: number }, stops: Touch[], shownAt: number): string {
  const moves: Move[] = [enter(shownAt, 0.25)];
  const clicks: Move[] = [];
  for (const stop of stops) {
    moves.push(move(stop.at - 0.45, 0.4, { x: stop.x - rest.x, y: stop.y - rest.y }, EASE.inOut));
    clicks.push(
      move(stop.at, 0.12, { opacity: 1, scale: 1 }, EASE.out),
      move(stop.at + 0.18, 0.22, { opacity: 0, scale: 1.3 }, EASE.out),
    );
  }
  const body = scene.anim({ opacity: 0, x: 0, y: 0, scale: 1 }, moves);
  const ring = scene.anim({ opacity: 0, scale: 0.7 }, clicks, 'center');
  return (
    `<g transform="translate(${n(rest.x)} ${n(rest.y)})"><g ${body}>` +
    `<circle ${ring} class="fx" r="7" fill="${scene.palette.accent}" fill-opacity=".6" stroke="${scene.app.page}" stroke-width="1.5"/>` +
    `<path d="M0 0v10.5l2.6-2.4 1.8 4.1 1.7-.8-1.8-4 3.6-.2Z" fill="${scene.app.text}" stroke="${scene.app.page}" stroke-width=".9" stroke-linejoin="round"/>` +
    `</g></g>`
  );
}

function field(scene: Scene, text: string, times: Timeline | null): string {
  const a = scene.app;
  const f = FIELD;
  const baseline = f.y + f.h / 2 + 3;
  const shape = `<rect x="${n(f.x)}" y="${n(f.y)}" width="${n(f.w)}" height="${n(f.h)}" rx="${n(f.h / 2)}" fill="${a.field}" stroke="${a.line}" stroke-width=".8"/>`;
  const button =
    `<circle cx="${n(BUTTON.x)}" cy="${n(BUTTON.y)}" r="${String(BUTTON.r)}" fill="${a.green}"/>` +
    `<path d="M${n(BUTTON.x)} ${n(BUTTON.y - 3)}v6m-3-3h6" stroke="${a.onGreen}" stroke-width="1.3" stroke-linecap="round"/>`;
  const fit: readonly [number, number] = [f.x, BUTTON.x - BUTTON.r];
  const placeholderRun = scene.text({
    text: APP.placeholder,
    ...FIELD_TEXT,
    y: baseline,
    fill: a.muted,
    fit,
  });
  if (times === null) return shape + button + placeholderRun;
  const first = times.chars[0] ?? times.focus;
  const placeholder = scene.anim({ opacity: 1 }, [
    set(first, { opacity: 0 }),
    move(times.submit + 0.15, 0.2, { opacity: 1 }, EASE.out),
  ]);
  const typedRun = scene.text({ text, ...FIELD_TEXT, y: baseline, fill: a.text, fit });
  const widths = Array.from(text, (_, i) => measure(text.slice(0, i + 1), FIELD_TEXT.face, FIELD_TEXT.size));
  const full = widths.at(-1) ?? 0;
  const cover = scene.anim(
    { x: 0 },
    times.chars.map((t, i) => set(t, { x: widths[i] ?? 0 })),
  );
  const typed = scene.anim({ opacity: 0 }, [set(first, { opacity: 1 }), move(times.submit, 0.12, { opacity: 0 }, EASE.out)]);
  const caret = scene.anim({ opacity: 0, x: 0 }, [
    set(times.focus, { opacity: 1 }),
    ...times.chars.map((t, i) => set(t + 0.005, { x: (widths[i] ?? 0) + 0.9 })),
    move(times.submit, 0.1, { opacity: 0 }, EASE.out),
  ]);
  const focus = scene.anim({ opacity: 0 }, [
    move(times.focus, 0.15, { opacity: 1 }, EASE.out),
    move(times.submit + 0.1, 0.2, { opacity: 0 }, EASE.out),
  ]);
  const clip = scene.clip(`<rect x="${n(FIELD_TEXT.x - 1)}" y="${n(f.y)}" width="${n(full + 3)}" height="${n(f.h)}"/>`);
  return (
    shape +
    `<rect ${focus} x="${n(f.x)}" y="${n(f.y)}" width="${n(f.w)}" height="${n(f.h)}" rx="${n(f.h / 2)}" fill="none" stroke="${a.green}" stroke-width="1.3"/>` +
    button +
    `<g ${placeholder}>${placeholderRun}</g>` +
    clip.def +
    `<g ${typed}><g clip-path="url(#${clip.id})">${typedRun}<rect ${cover} x="${n(FIELD_TEXT.x + 0.3)}" y="${n(f.y + 3)}" width="${n(full + 2)}" height="${n(f.h - 6)}" fill="${a.field}"/></g></g>` +
    `<rect ${caret} x="${n(FIELD_TEXT.x)}" y="${n(f.y + 5)}" width=".9" height="${n(f.h - 10)}" fill="${a.green}"/>`
  );
}

interface AppView {
  svg: string;
  targets: Touch[];
}

function appView(scene: Scene, lane: Lane, steps: Step[]): AppView {
  const a = scene.app;
  const add = steps.find(step => step.do === 'add');
  const addAt = add === undefined ? null : addTimes(add.at, lane.adds);
  const ticks = new Map<string, number>();
  for (const step of steps) if (step.do === 'tick') ticks.set(step.item, step.at);
  const rowY = (index: number): number => LIST.top + index * LIST.rowH;

  const header =
    `<rect x="6" y="5" width="14" height="14" rx="4" fill="${a.green}"/>` +
    basketGlyph(8.2, 7, 9.6, a.onGreen) +
    scene.text({ text: APP.name, face: 's8', size: 11, x: 25, y: 16.2, fill: a.text, fit: [21, COLUMN_W] });

  const rows = ITEMS.map((item, i) => row(scene, rowY(i), item.name, item.colour, ticks.get(item.name) ?? null)).join('');
  let added = '';
  const listMoves: Move[] = [];
  if (addAt !== null) {
    const shown = scene.anim({ opacity: 0 }, [move(addAt.submit + 0.1, 0.3, { opacity: 1 }, EASE.out)]);
    const glow = scene.anim({ opacity: 1 }, [move(addAt.submit + 0.9, 0.6, { opacity: 0 }, EASE.plain)]);
    const y = LIST.top - LIST.rowH;
    added =
      `<g ${shown}>${row(scene, y, lane.adds, ADDED_COLOUR[lane.adds] ?? a.green, null)}` +
      `<rect ${glow} class="fx" x="${n(LIST.x)}" y="${n(y)}" width="${n(LIST.w)}" height="${n(LIST.cardH)}" rx="6" fill="${a.green}" fill-opacity=".14" stroke="${a.green}" stroke-width="1"/></g>`;
    listMoves.push(move(addAt.submit + 0.05, 0.35, { y: LIST.rowH }, EASE.inOut));
  }
  const listClip = scene.clip(
    `<rect x="0" y="${n(LIST.top - 2)}" width="${n(COLUMN_W)}" height="${n(CONTENT_H - LIST.top + 2)}"/>`,
  );
  const list = `${listClip.def}<g clip-path="url(#${listClip.id})"><g ${scene.anim({ y: 0 }, listMoves)}>${added}${rows}</g></g>`;

  const targets: Touch[] = [];
  for (const step of steps) {
    if (step.do === 'add' && addAt !== null) {
      targets.push({ x: FIELD.x + 66, y: FIELD.y + FIELD.h / 2, at: step.at });
      targets.push({ x: BUTTON.x, y: BUTTON.y, at: addAt.returnTap });
    } else if (step.do === 'tick') {
      let index = ITEMS.findIndex(item => item.name === step.item);
      if (index === -1) throw new Error(`${step.item} is not on the list`);
      if (addAt !== null && addAt.submit < step.at) index += 1;
      targets.push({ x: CHECK_X, y: rowY(index) + LIST.cardH / 2, at: step.at });
    }
  }
  return { svg: header + field(scene, lane.adds, addAt) + list, targets };
}

function statusBar(scene: Scene, platform: 'ios' | 'android'): string {
  const a = scene.app;
  const W = PHONE_SCREEN.w;
  const ios = platform === 'ios';
  const y = 15;
  const time = scene.text({
    text: '9:41',
    face: ios ? 's6' : 's4',
    size: 7.5,
    x: ios ? 22 : 10,
    y,
    anchor: ios ? 'middle' : 'start',
    fill: a.text,
    fit: ios ? [6, 40] : [6, 44],
  });
  const right = W - (ios ? 12 : 9);
  const battery = ios
    ? `<rect x="${n(right - 10)}" y="${n(y - 6)}" width="10" height="5.2" rx="1.5" fill="none" stroke="${a.text}" stroke-width=".8" opacity=".55"/><rect x="${n(right - 9)}" y="${n(y - 5)}" width="7" height="3.2" rx=".7" fill="${a.text}"/>`
    : `<rect x="${n(right - 3.8)}" y="${n(y - 7)}" width="3.8" height="7" rx=".8" fill="${a.text}"/>`;
  const wifiX = ios ? right - 15.5 : right - 9;
  const wifi = `<path d="M${n(wifiX - 3)} ${n(y - 4.8)}a4.3 4.3 0 0 1 6 0l-3 3.4Z" fill="${a.text}"/>`;
  return time + wifi + battery;
}

function phoneFrame(scene: Scene, platform: 'ios' | 'android'): { under: string; over: string } {
  const a = scene.app;
  const { w, h } = DEVICE;
  const s = PHONE_SCREEN;
  const outer = platform === 'ios' ? 21 : 14;
  const cx = s.x + s.w / 2;
  const camera =
    platform === 'ios'
      ? `<rect x="${n(cx - 16)}" y="${n(s.y + 6)}" width="32" height="9.5" rx="4.75" fill="${a.cutout}" stroke="${a.frameEdge}" stroke-width=".6"/>`
      : `<circle cx="${n(cx)}" cy="${n(s.y + 11)}" r="3.2" fill="${a.cutout}" stroke="${a.frameEdge}" stroke-width=".6"/>`;
  const barW = platform === 'ios' ? 38 : 28;
  const bar = `<rect x="${n(cx - barW / 2)}" y="${n(s.y + s.h - 5.5)}" width="${String(barW)}" height="2.2" rx="1.1" fill="${a.text}" opacity=".7"/>`;
  return {
    under: `<rect x=".5" y=".5" width="${n(w - 1)}" height="${n(h - 1)}" rx="${String(outer)}" fill="${a.frame}" stroke="${a.frameEdge}" stroke-width="1"/>`,
    over:
      `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" rx="${String(FRAMES[platform].radius)}" fill="none" stroke="${a.frameEdge}" stroke-width=".8"/>` +
      camera +
      bar,
  };
}

function browserFrame(scene: Scene, port: number): { under: string; over: string } {
  const a = scene.app;
  const { w, h } = DEVICE;
  const tab = { x: 29, w: 66 };
  const omni = { x: 6, y: 17.5, w: w - 12, h: 10 };
  return {
    under:
      `<rect x=".5" y=".5" width="${n(w - 1)}" height="${n(h - 1)}" rx="8" fill="${a.frame}" stroke="${a.frameEdge}" stroke-width="1"/>` +
      [8.5, 14.5, 20.5].map(x => `<circle cx="${String(x)}" cy="8.5" r="2" fill="${a.frameEdge}"/>`).join('') +
      `<path d="M${n(tab.x)} 14.5V6a3.5 3.5 0 0 1 3.5-3.5h${n(tab.w - 7)}a3.5 3.5 0 0 1 3.5 3.5v8.5Z" fill="${a.card}"/>` +
      `<rect x="${n(tab.x + 5)}" y="5" width="7" height="7" rx="2" fill="${a.green}"/>` +
      scene.text({
        text: APP.name,
        face: 's6',
        size: 7,
        x: tab.x + 15,
        y: 11.2,
        fill: a.text,
        fit: [tab.x + 11, tab.x + tab.w],
      }) +
      `<rect x="1" y="14.5" width="${n(w - 2)}" height="${n(BROWSER_BAR - 14.5)}" fill="${a.card}"/>` +
      `<rect x="${n(omni.x)}" y="${n(omni.y)}" width="${n(omni.w)}" height="${n(omni.h)}" rx="5.5" fill="${a.frame}"/>` +
      scene.text({
        text: `localhost:${String(port)}`,
        face: 'm4',
        size: 7,
        x: omni.x + 6,
        y: omni.y + 7.4,
        fill: a.muted,
        fit: [omni.x, omni.x + omni.w],
      }) +
      `<path d="M1 ${String(BROWSER_BAR - 0.4)}H${n(w - 1)}" stroke="${a.line}" stroke-width=".8"/>`,
    over: '',
  };
}

export interface DeviceSpec {
  lane: Lane;
  steps: Step[];
  shownAt: number;
}

export interface Device {
  svg: string;
  shots: number[];
}

export function device(scene: Scene, spec: DeviceSpec): Device {
  const { lane, steps } = spec;
  const platform = lane.platform;
  const frame = FRAMES[platform];
  const a = scene.app;
  const s = frame.screen;
  const shots = shotTimes(steps, lane);
  const view = appView(scene, lane, steps);
  const cx = frame.content.x - s.x;
  const cy = frame.content.y - s.y;

  const driver =
    platform === 'web'
      ? pointer(
          scene,
          { x: COLUMN_W - 26, y: 150 },
          view.targets.map(t => ({ ...t, x: t.x + 2.5, y: t.y + 2.5 })),
          spec.shownAt + 0.4,
        )
      : touches(scene, view.targets);
  const flash = scene.anim(
    { opacity: 0 },
    shots.flatMap(t => [move(t, 0.06, { opacity: a.flash }, EASE.linear), move(t + 0.06, 0.3, { opacity: 0 }, EASE.out)]),
  );
  const r = frame.radius;
  const shape =
    platform === 'web'
      ? `<path d="M0 0H${n(s.w)}V${n(s.h - r)}a${String(r)} ${String(r)} 0 0 1-${String(r)} ${String(r)}H${String(r)}a${String(r)} ${String(r)} 0 0 1-${String(r)}-${String(r)}Z"/>`
      : `<rect width="${n(s.w)}" height="${n(s.h)}" rx="${String(r)}"/>`;
  const screenClip = scene.clip(shape);
  const status = platform === 'web' ? '' : statusBar(scene, platform);
  const built = platform === 'web' ? browserFrame(scene, lane.devServer) : phoneFrame(scene, platform);
  return {
    svg:
      built.under +
      screenClip.def +
      `<g transform="translate(${n(s.x)} ${n(s.y)})"><g clip-path="url(#${screenClip.id})">` +
      `<rect width="${n(s.w)}" height="${n(s.h)}" fill="${a.page}"/>` +
      status +
      `<g transform="translate(${n(cx)} ${n(cy)})">${view.svg}${driver}</g>` +
      `<rect ${flash} class="fx" width="${n(s.w)}" height="${n(s.h)}" fill="#FFFFFF"/>` +
      `</g></g>` +
      built.over,
    shots,
  };
}
