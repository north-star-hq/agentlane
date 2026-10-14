import zlib from 'node:zlib';
import { contentElements, type Sparseness } from './look.ts';
import type { ReadableScreen, Rect } from './tree.ts';

export interface Pixels {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB or RGBA), which is what sips writes. */
export function decodePng(png: Buffer): Pixels {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9] ?? -1;
      const interlace = body[12];
      channels = CHANNELS[colorType] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(
          `unsupported PNG (bit depth ${String(depth)}, color type ${String(colorType)}, interlace ${String(interlace)})`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (data[y * stride + i - channels] ?? 0) : 0;
      const up = y > 0 ? (data[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= channels ? (data[(y - 1) * stride + i - channels] ?? 0) : 0;
      const value = line[i] ?? 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`PNG row ${String(y)} has unknown filter ${String(filter)}`);
      }
      data[y * stride + i] = out & 0xff;
    }
  }
  return { width, height, channels, data };
}

export interface PixelDetail {
  /** Share of the screen not covered by any readable element. */
  uncovered: number;
  /** Share of the uncovered pixels that sit on a sharp edge: text, lines, markers, drawn rows. */
  edges: number;
}

export const EDGE_DELTA = 48;
export const BLANK_EDGE_SHARE = 0.004;
const COVER_PAD_POINTS = 3;

/**
 * How much drawn detail the screenshot shows where the accessibility tree has nothing. Covered areas are the readable
 * elements' bounds (plus a small pad for anti-aliasing) and the status bar; everything else is scanned for sharp edges.
 * Flat fills and soft gradients (a short page's empty space, a dimmed backdrop) have none; text, map tiles and drawn
 * rows have many.
 */
export function uncoveredDetail(image: Pixels, screen: Rect, covered: readonly Rect[]): PixelDetail {
  const { width, height, channels, data } = image;
  const sx = width / Math.max(1, screen.x2 - screen.x1);
  const sy = height / Math.max(1, screen.y2 - screen.y1);
  const mask = new Uint8Array(width * height);
  for (const rect of covered) {
    const x1 = Math.max(0, Math.floor((rect.x1 - screen.x1 - COVER_PAD_POINTS) * sx));
    const x2 = Math.min(width, Math.ceil((rect.x2 - screen.x1 + COVER_PAD_POINTS) * sx));
    const y1 = Math.max(0, Math.floor((rect.y1 - screen.y1 - COVER_PAD_POINTS) * sy));
    const y2 = Math.min(height, Math.ceil((rect.y2 - screen.y1 + COVER_PAD_POINTS) * sy));
    for (let y = y1; y < y2; y++) mask.fill(1, y * width + x1, y * width + x2);
  }
  const colors = Math.min(channels, 3);
  const at = (x: number, y: number, c: number) => data[(y * width + x) * channels + Math.min(c, channels - 1)] ?? 0;
  let free = 0;
  let edges = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const index = y * width + x;
      if (mask[index] || mask[index + 1] || mask[index + width]) continue;
      free += 1;
      let delta = 0;
      for (let c = 0; c < colors; c++) {
        const here = at(x, y, c);
        delta = Math.max(delta, Math.abs(here - at(x + 1, y, c)), Math.abs(here - at(x, y + 1, c)));
      }
      if (delta > EDGE_DELTA) edges += 1;
    }
  }
  return { uncovered: free / Math.max(1, (width - 1) * (height - 1)), edges: free === 0 ? 0 : edges / free };
}

export type PixelJudgement = 'blank' | 'drawn';

export function judgeUncovered(detail: PixelDetail): PixelJudgement {
  return detail.edges < BLANK_EDGE_SHARE ? 'blank' : 'drawn';
}

/** The rects that count as read: the status bar band and every content element of the read. */
export function coveredRects(read: ReadableScreen): Rect[] {
  const { statusBar, elements } = contentElements(read);
  return [statusBar, ...elements.flatMap(element => (element.node.bounds ? [element.node.bounds] : []))];
}

/**
 * Re-judges a sparse read with its screenshot. When the parts of the screen the tree doesn't explain are blank, the
 * screen really is short (a short page, a small sheet over a plain backdrop), so the read is complete after all.
 */
export function refineSparseness(
  read: ReadableScreen,
  sparseness: Sparseness,
  image: Pixels,
): Sparseness & { pixels: PixelDetail } {
  const pixels = uncoveredDetail(image, read.screen, coveredRects(read));
  if (!sparseness.sparse || judgeUncovered(pixels) === 'drawn') return { ...sparseness, pixels };
  return { ...sparseness, sparse: false, reason: undefined, pixels };
}
