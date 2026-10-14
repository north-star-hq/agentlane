import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { jpegSize } from '../../src/driver/images.ts';
import { sparsenessOf } from '../../src/driver/look.ts';
import { BLANK_EDGE_SHARE, decodePng, refineSparseness, uncoveredDetail } from '../../src/driver/pixels.ts';
import { parseInspectScreen, type ReadableScreen } from '../../src/driver/tree.ts';

const SCREENS = path.resolve(import.meta.dirname, '..', 'fixtures', 'ios-26.5');

function capture(name: string): { read: ReadableScreen; png: Buffer } {
  const read = parseInspectScreen(fs.readFileSync(path.join(SCREENS, `${name}.inspect.json`), 'utf8'));
  if (!read.readable) throw new Error(`${name} is unreadable`);
  return { read, png: fs.readFileSync(path.join(SCREENS, `${name}.200.png`)) };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Encodes RGB pixels as a PNG, filtering row y with filters[y % filters.length]. */
function encodePng(width: number, height: number, rgb: Uint8Array, filters: number[]): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length] ?? 0;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const value = rgb[y * stride + i] ?? 0;
      const left = i >= 3 ? (rgb[y * stride + i - 3] ?? 0) : 0;
      const up = y > 0 ? (rgb[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= 3 ? (rgb[(y - 1) * stride + i - 3] ?? 0) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;
      raw[y * (stride + 1) + 1 + i] = (value - predicted) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('decodePng undoes every PNG row filter', () => {
  const width = 7;
  const height = 10;
  const rgb = new Uint8Array(width * height * 3).map((_, i) => (i * 37 + (i % 5) * 11) & 0xff);
  const decoded = decodePng(encodePng(width, height, rgb, [0, 1, 2, 3, 4]));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decoded.channels, 3);
  assert.deepEqual([...decoded.data], [...rgb]);
});

test('decodePng refuses what it does not read', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/);
});

test('the PNGs sips writes decode to the size it was asked for', () => {
  for (const name of ['canvas-page', 'short-page', 'example-home', 'example-sheet']) {
    const pixels = decodePng(capture(name).png);
    assert.equal(pixels.width, 200, name);
    assert.ok(pixels.height > 400, name);
  }
});

test('a canvas page Safari draws but cannot describe stays nearly empty after the pixel check', () => {
  const { read, png } = capture('canvas-page');
  const tree = sparsenessOf(read);
  assert.equal(tree.sparse, true);
  const refined = refineSparseness(read, tree, decodePng(png));
  assert.equal(refined.sparse, true);
  assert.ok(refined.pixels.edges > BLANK_EDGE_SHARE * 5, `edge share ${String(refined.pixels.edges)}`);
});

test('a short page reads as nearly empty from the tree, and the pixel check shows its empty part is blank', () => {
  const { read, png } = capture('short-page');
  const tree = sparsenessOf(read);
  assert.equal(tree.sparse, true);
  const refined = refineSparseness(read, tree, decodePng(png));
  assert.equal(refined.sparse, false);
  assert.equal(refined.reason, undefined);
  assert.ok(refined.pixels.edges < BLANK_EDGE_SHARE, `edge share ${String(refined.pixels.edges)}`);
});

test("a sheet over the app's own screen stays nearly empty: the dimmed screen behind it is drawn, not read", () => {
  const { read, png } = capture('example-sheet');
  const refined = refineSparseness(read, sparsenessOf(read), decodePng(png));
  assert.equal(refined.sparse, true);
});

test("the example app's home screen is complete without the pixel check", () => {
  const { read, png } = capture('example-home');
  const tree = sparsenessOf(read);
  assert.equal(tree.sparse, false);
  assert.deepEqual(refineSparseness(read, tree, decodePng(png)).sparse, false);
});

test('pixels under readable elements and the status bar are not counted', () => {
  const width = 20;
  const height = 40;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  for (let y = 10; y < 20; y++) for (let x = 0; x < width; x += 2) rgb.fill(0, (y * width + x) * 3, (y * width + x) * 3 + 3);
  const image = { width, height, channels: 3, data: rgb };
  const screen = { x1: 0, y1: 0, x2: 200, y2: 400 };
  assert.ok(uncoveredDetail(image, screen, []).edges > 0.1);
  const covered = uncoveredDetail(image, screen, [{ x1: 0, y1: 100, x2: 200, y2: 200 }]);
  assert.equal(covered.edges, 0);
  assert.ok(covered.uncovered < 0.8);
});

test('jpegSize reads the frame size of the screenshots Maestro returns', () => {
  assert.deepEqual(jpegSize(fs.readFileSync(path.join(SCREENS, 'canvas-page.screenshot.jpg'))), { width: 460, height: 1001 });
  assert.equal(jpegSize(Buffer.from('nope')), undefined);
});
