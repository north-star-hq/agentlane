import fs from 'node:fs';
import path from 'node:path';
import { DriverError } from './errors.ts';
import { runCommand, tail } from './exec.ts';
import { decodePng, type Pixels } from './pixels.ts';

export interface Size {
  width: number;
  height: number;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageTools {
  /** The screenshot downscaled to `width` pixels across, decoded, for the pixel check. */
  pixels(jpeg: Buffer, width: number): Promise<Pixels>;
  /** Crops (in image pixels), then scales, a JPEG. */
  transform(jpeg: Buffer, edit: { crop?: Crop; scale?: number }): Promise<Buffer>;
}

/** Reads a JPEG's pixel size from its start-of-frame marker. */
export function jpegSize(jpeg: Buffer): Size | undefined {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) return undefined;
    const marker = jpeg[offset + 1] ?? 0;
    const length = jpeg.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

/** Image edits with macOS's `sips`, through files in a scratch folder. */
export function sipsImages(scratch: string): ImageTools {
  let counter = 0;
  const files = (extension: string) => {
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    counter += 1;
    const stem = path.join(scratch, `image-${String(process.pid)}-${String(counter)}`);
    return { input: `${stem}.jpg`, output: `${stem}.${extension}` };
  };
  const sips = async (args: string[], input: string, output: string): Promise<Buffer> => {
    const ran = await runCommand('sips', [...args, input, '--out', output], { timeoutMs: 30_000 });
    try {
      if (ran.code !== 0 || !fs.existsSync(output)) {
        throw new DriverError(
          `sips failed (${ran.error ?? `exit ${String(ran.code)}`}): ${tail(ran.stderr || ran.stdout, 4)}`,
          'sips ships with macOS; image edits need it',
        );
      }
      return fs.readFileSync(output);
    } finally {
      fs.rmSync(input, { force: true });
      fs.rmSync(output, { force: true });
    }
  };
  return {
    async pixels(jpeg, width) {
      const { input, output } = files('png');
      fs.writeFileSync(input, jpeg);
      return decodePng(await sips(['-s', 'format', 'png', '--resampleWidth', String(width)], input, output));
    },
    async transform(jpeg, edit) {
      const { input, output } = files('jpg');
      fs.writeFileSync(input, jpeg);
      const size = jpegSize(jpeg);
      const args = ['-s', 'format', 'jpeg'];
      let width = size?.width;
      if (edit.crop) {
        const crop = edit.crop;
        args.push('--cropToHeightWidth', String(crop.height), String(crop.width), '--cropOffset', String(crop.y), String(crop.x));
        width = crop.width;
      }
      if (edit.scale !== undefined && width !== undefined) {
        args.push('--resampleWidth', String(Math.max(1, Math.round(width * edit.scale))));
      }
      return sips(args, input, output);
    },
  };
}
