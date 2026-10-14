import fs from 'node:fs';

export interface Font {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  glyphOf(char: string): number;
  advance(glyph: number): number;
  kern(left: number, right: number): number;
  outline(glyph: number): Contour[];
}

export interface Point {
  x: number;
  y: number;
  on: boolean;
}

export type Contour = Point[];

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME = 0x10;
const Y_SAME = 0x20;

const ARGS_ARE_WORDS = 0x0001;
const ARGS_ARE_XY = 0x0002;
const HAS_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAS_XY_SCALE = 0x0040;
const HAS_2X2 = 0x0080;

export function readFont(file: string): Font {
  const data = fs.readFileSync(file);
  const tables = new Map<string, number>();
  const count = data.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    tables.set(data.toString('latin1', record, record + 4), data.readUInt32BE(record + 8));
  }
  const table = (tag: string): number => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`${file} has no ${tag} table`);
    return offset;
  };

  const head = table('head');
  const unitsPerEm = data.readUInt16BE(head + 18);
  const longOffsets = data.readInt16BE(head + 50) === 1;
  const glyphCount = data.readUInt16BE(table('maxp') + 4);
  const hhea = table('hhea');
  const ascent = data.readInt16BE(hhea + 4);
  const descent = data.readInt16BE(hhea + 6);
  const metricCount = data.readUInt16BE(hhea + 34);
  const hmtx = table('hmtx');
  const advances: number[] = [];
  for (let g = 0; g < glyphCount; g++) advances.push(data.readUInt16BE(hmtx + Math.min(g, metricCount - 1) * 4));

  const cmap = new Map<number, number>();
  const cmapAt = table('cmap');
  for (let i = 0; i < data.readUInt16BE(cmapAt + 2); i++) {
    const record = cmapAt + 4 + i * 8;
    if (data.readUInt16BE(record) !== 3 || data.readUInt16BE(record + 2) !== 1) continue;
    const sub = cmapAt + data.readUInt32BE(record + 4);
    if (data.readUInt16BE(sub) !== 4) throw new Error(`${file}: only cmap format 4 is read`);
    const segments = data.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      const end = data.readUInt16BE(ends + s * 2);
      const start = data.readUInt16BE(starts + s * 2);
      const delta = data.readInt16BE(deltas + s * 2);
      const rangeAt = ranges + s * 2;
      const range = data.readUInt16BE(rangeAt);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        const glyph = range === 0 ? (code + delta) & 0xffff : data.readUInt16BE(rangeAt + range + (code - start) * 2);
        if (glyph !== 0) cmap.set(code, range === 0 ? glyph : (glyph + delta) & 0xffff);
      }
    }
  }

  const loca = table('loca');
  const glyf = table('glyf');
  const glyphAt = (g: number): [number, number] =>
    longOffsets
      ? [data.readUInt32BE(loca + g * 4), data.readUInt32BE(loca + g * 4 + 4)]
      : [data.readUInt16BE(loca + g * 2) * 2, data.readUInt16BE(loca + g * 2 + 2) * 2];

  const kerning = new Map<number, number>();
  const kernAt = tables.get('kern');
  if (kernAt !== undefined) {
    const sub = kernAt + 4;
    const pairs = data.readUInt16BE(sub + 6);
    for (let i = 0; i < pairs; i++) {
      const at = sub + 14 + i * 6;
      kerning.set(data.readUInt16BE(at) * 65536 + data.readUInt16BE(at + 2), data.readInt16BE(at + 4));
    }
  }

  function outline(g: number): Contour[] {
    const [start, end] = glyphAt(g);
    if (start === end) return [];
    const at = glyf + start;
    const contours = data.readInt16BE(at);
    if (contours < 0) return composite(at + 10);
    const endPoints: number[] = [];
    for (let c = 0; c < contours; c++) endPoints.push(data.readUInt16BE(at + 10 + c * 2));
    const points = (endPoints.at(-1) ?? -1) + 1;
    let p = at + 10 + contours * 2;
    p += 2 + data.readUInt16BE(p);
    const flags: number[] = [];
    while (flags.length < points) {
      const flag = data.readUInt8(p++);
      flags.push(flag);
      if (flag & REPEAT) {
        const times = data.readUInt8(p++);
        for (let r = 0; r < times; r++) flags.push(flag);
      }
    }
    const coordinates = (short: number, same: number): number[] => {
      const values: number[] = [];
      let value = 0;
      for (const flag of flags) {
        if (flag & short) {
          const step = data.readUInt8(p++);
          value += flag & same ? step : -step;
        } else if (!(flag & same)) {
          value += data.readInt16BE(p);
          p += 2;
        }
        values.push(value);
      }
      return values;
    };
    const xs = coordinates(X_SHORT, X_SAME);
    const ys = coordinates(Y_SHORT, Y_SAME);
    const result: Contour[] = [];
    let first = 0;
    for (const last of endPoints) {
      const contour: Contour = [];
      for (let i = first; i <= last; i++) contour.push({ x: xs[i] ?? 0, y: ys[i] ?? 0, on: ((flags[i] ?? 0) & ON_CURVE) !== 0 });
      result.push(contour);
      first = last + 1;
    }
    return result;
  }

  function composite(at: number): Contour[] {
    const result: Contour[] = [];
    let p = at;
    for (;;) {
      const flags = data.readUInt16BE(p);
      const component = data.readUInt16BE(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (flags & ARGS_ARE_WORDS) {
        dx = data.readInt16BE(p);
        dy = data.readInt16BE(p + 2);
        p += 4;
      } else {
        dx = data.readInt8(p);
        dy = data.readInt8(p + 1);
        p += 2;
      }
      if (!(flags & ARGS_ARE_XY)) throw new Error(`${file}: composite glyphs anchored by point are not read`);
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2dot14 = (offset: number): number => data.readInt16BE(offset) / 16384;
      if (flags & HAS_SCALE) {
        a = d = f2dot14(p);
        p += 2;
      } else if (flags & HAS_XY_SCALE) {
        a = f2dot14(p);
        d = f2dot14(p + 2);
        p += 4;
      } else if (flags & HAS_2X2) {
        [a, b, c, d] = [f2dot14(p), f2dot14(p + 2), f2dot14(p + 4), f2dot14(p + 6)];
        p += 8;
      }
      for (const contour of outline(component))
        result.push(contour.map(pt => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
      if (!(flags & MORE_COMPONENTS)) return result;
    }
  }

  return {
    unitsPerEm,
    ascent,
    descent,
    glyphOf(char: string): number {
      const glyph = cmap.get(char.codePointAt(0) ?? 0);
      if (glyph === undefined) throw new Error(`${file} has no glyph for ${JSON.stringify(char)}`);
      return glyph;
    },
    advance: g => advances[g] ?? 0,
    kern: (left, right) => kerning.get(left * 65536 + right) ?? 0,
    outline,
  };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true };
}

function startOnCurve(contour: Contour): Contour {
  const at = contour.findIndex(pt => pt.on);
  if (at !== -1) return [...contour.slice(at), ...contour.slice(0, at)];
  const first = contour[0];
  const last = contour.at(-1);
  return first === undefined || last === undefined ? [] : [midpoint(last, first), ...contour];
}

export function pathData(contours: Contour[], scale: number): string {
  const parts: string[] = [];
  let pen: [number, number] = [0, 0];
  const to = (...points: Point[]): string => {
    const values: number[] = [];
    let end = pen;
    for (const pt of points) {
      end = [Math.round(pt.x * scale), Math.round(-pt.y * scale)];
      values.push(end[0] - pen[0], end[1] - pen[1]);
    }
    pen = end;
    return values.map((v, i) => (i > 0 && v >= 0 ? ` ${String(v)}` : String(v))).join('');
  };
  for (const contour of contours) {
    const ring = startOnCurve(contour);
    const start = ring[0];
    if (start === undefined) continue;
    parts.push(`m${to(start)}`);
    const subpathStart = pen;
    let control: Point | null = null;
    for (const pt of [...ring.slice(1), start]) {
      if (pt === start && control === null) break;
      if (pt.on) {
        parts.push(control === null ? `l${to(pt)}` : `q${to(control, pt)}`);
        control = null;
      } else {
        if (control !== null) parts.push(`q${to(control, midpoint(control, pt))}`);
        control = pt;
      }
    }
    parts.push('z');
    pen = subpathStart;
  }
  return parts.join('');
}
