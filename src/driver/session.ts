import fs from 'node:fs';
import path from 'node:path';
import { checkAbsent, readIn, treeBound } from './absence.ts';
import { diffScreens, renderDiff, volatileBetween, type VolatileSet } from './diff.ts';
import { messageOf } from './errors.ts';
import { buildFailure, renderFailure, type RunFailure } from './failure.ts';
import { parseFlow, writeFlow, type FlowStep, type RecordedRun } from './flow.ts';
import { jpegSize, type Crop, type ImageTools } from './images.ts';
import { look, sparsenessOf, type LookOptions, type Sparseness } from './look.ts';
import { imageOf, textOf } from './maestro-child.ts';
import { refineSparseness } from './pixels.ts';
import { absenceSelectors, finalAbsenceSteps, flowYaml, prepareFlow, splittable, type PreparedFlow } from './plan.ts';
import { selectorsOfStep, selectorYaml, type Selector } from './selector.ts';
import { SessionFailure, type Supervisor } from './supervisor.ts';
import { parseInspectScreen, type ReadableScreen, type Rect, type ScreenRead } from './tree.ts';

export interface ImageData {
  data: string;
  mimeType: string;
}

export interface OpResult {
  ok: boolean;
  text: string;
  image?: ImageData;
  failure?: RunFailure;
  data?: Record<string, unknown>;
}

export interface LookArgs extends LookOptions {
  /** Maestro's own `inspect_screen` text instead of the snapshot. */
  raw?: boolean;
}

export interface ScreenshotArgs {
  /** 0 < scale <= 1, applied after the crop. */
  scale?: number;
  /** In screen points, as `look` prints bounds. */
  crop?: Crop;
}

export interface RunArgs {
  yaml?: string;
  /** An absolute path to a flow file. */
  file?: string;
  env?: Record<string, string>;
  quick?: boolean;
  appId?: string;
}

export interface RecordArgs {
  action: 'save' | 'show' | 'clear';
  /** For save: an absolute path. */
  file?: string;
}

export const PIXEL_CHECK_WIDTH = 200;
const VOLATILE_TTL_MS = 5 * 60_000;
const RECENT_READ_MS = 5000;
const RESPAWN_NOTE = "Maestro's session was rebuilt for this call";

interface MaestroOutcome {
  ok: boolean;
  error: string;
}

/** Turns a `run` reply into its error text: per-flow errors from a file run, the plain message from inline YAML. */
export function flowError(reply: string): string {
  try {
    const parsed = JSON.parse(reply) as { results?: { success?: boolean; error?: string }[]; error?: unknown };
    const errors = (parsed.results ?? [])
      .filter(result => result.success === false)
      .map(result => result.error)
      .filter((error): error is string => typeof error === 'string' && error !== '');
    if (errors.length > 0) return errors.join('\n');
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    return reply;
  }
  return reply;
}

interface VolatileRecord {
  version: 1;
  anchors: string[];
}

function readVolatile(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VolatileRecord>;
    return parsed.version === 1 && Array.isArray(parsed.anchors)
      ? parsed.anchors.filter((a): a is string => typeof a === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeVolatile(file: string, anchors: string[]): void {
  const record: VolatileRecord = { version: 1, anchors };
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const SCREENSHOT_FILE = /\.(png|jpe?g)$/i;
const INTERNAL_DIRS = new Set(['bin', 'images']);

function freePath(file: string): string {
  if (!fs.existsSync(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let n = 2; ; n++) {
    const next = path.join(dir, `${name}-${String(n)}${ext}`);
    if (!fs.existsSync(next)) return next;
  }
}

function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** The tools of one claimed simulator, on top of its supervised Maestro session. */
export class DriverSession {
  private readonly supervisor: Supervisor;
  private readonly images: ImageTools;
  private readonly stepsFile: string;
  private readonly volatileFile: string;
  private readonly workDir: string;
  private readonly shotsDir: string;
  private readonly log: (line: string) => void;
  private lastRead: ScreenRead | undefined;
  private lastReadAt = 0;
  private actedSinceRead = true;
  private readonly volatile = new Map<string, number>();
  private lastAppId: string | undefined;
  private screen: Rect | undefined;

  constructor(
    supervisor: Supervisor,
    images: ImageTools,
    files: { steps: string; volatile: string; work: string; shots: string },
    log: (line: string) => void,
  ) {
    this.supervisor = supervisor;
    this.images = images;
    this.stepsFile = files.steps;
    this.volatileFile = files.volatile;
    this.workDir = files.work;
    this.shotsDir = files.shots;
    this.log = log;
    const now = Date.now();
    for (const anchor of readVolatile(this.volatileFile)) this.volatile.set(anchor, now);
  }

  private saveVolatile(): void {
    try {
      writeVolatile(this.volatileFile, [...this.volatile.keys()]);
    } catch (error) {
      this.log(`could not keep the ticking labels in ${this.volatileFile}: ${messageOf(error)}`);
    }
  }

  private volatileSet(): VolatileSet {
    const now = Date.now();
    let dropped = false;
    for (const [anchor, at] of this.volatile) {
      if (now - at > VOLATILE_TTL_MS) {
        this.volatile.delete(anchor);
        dropped = true;
      }
    }
    if (dropped) this.saveVolatile();
    return new Set(this.volatile.keys());
  }

  private async inspect(): Promise<{ read: ScreenRead; respawned: boolean; text: string }> {
    const { result, respawned } = await this.supervisor.call('inspect_screen', {}, { retry: true });
    const text = textOf(result);
    const read: ScreenRead = result.isError
      ? { readable: false, source: 'inspect_screen', reason: text.trim() || 'Maestro returned an error with no text.' }
      : parseInspectScreen(text);
    if (!this.actedSinceRead && this.lastRead?.readable && read.readable) {
      const now = Date.now();
      let learned = false;
      for (const anchor of volatileBetween(this.lastRead, read, { digitsOnly: true })) {
        learned ||= !this.volatile.has(anchor);
        this.volatile.set(anchor, now);
      }
      if (learned) this.saveVolatile();
    }
    if (read.readable) this.screen = read.screen;
    this.lastRead = read;
    this.lastReadAt = Date.now();
    this.actedSinceRead = false;
    return { read, respawned, text };
  }

  private async shot(): Promise<{ jpeg: Buffer; respawned: boolean }> {
    const { result, respawned } = await this.supervisor.call('take_screenshot', {}, { retry: true });
    const image = imageOf(result);
    if (result.isError || !image) throw new Error(textOf(result) || 'Maestro returned no image');
    return { jpeg: Buffer.from(image.data, 'base64'), respawned };
  }

  private async refine(read: ReadableScreen, sparseness: Sparseness, jpeg: Buffer): Promise<Sparseness> {
    try {
      const refined = refineSparseness(read, sparseness, await this.images.pixels(jpeg, PIXEL_CHECK_WIDTH));
      this.log(
        `pixel check: ${String(Math.round(refined.pixels.uncovered * 100))}% uncovered, edge share ${refined.pixels.edges.toFixed(4)}: ${refined.sparse ? 'drawn' : 'blank'}`,
      );
      return refined;
    } catch (error) {
      this.log(`pixel check skipped: ${messageOf(error)}`);
      return sparseness;
    }
  }

  /** The last read, when nothing has acted on the screen since and it is recent: what the caller last saw. */
  private recentRead(): { read: ScreenRead; respawned: boolean } | undefined {
    if (this.actedSinceRead || !this.lastRead?.readable || Date.now() - this.lastReadAt > RECENT_READ_MS) return undefined;
    return { read: this.lastRead, respawned: false };
  }

  /** One read with nothing done since the last, so numbers that change on their own are known before the next diff. */
  async idleSample(): Promise<void> {
    if (this.actedSinceRead || !this.lastRead?.readable) return;
    await this.inspect();
  }

  async look(args: LookArgs): Promise<OpResult> {
    const { read, respawned, text } = await this.inspect();
    if (args.raw === true) return { ok: true, text };
    let result = look(read, args);
    let image: ImageData | undefined;
    let shotRespawned = false;
    if (result.attachScreenshot) {
      const shot = await this.shot();
      shotRespawned = shot.respawned;
      if (read.readable && result.sparseness?.sparse) {
        const refined = await this.refine(read, result.sparseness, shot.jpeg);
        if (!refined.sparse) result = look(read, args, refined);
      }
      if (result.attachScreenshot) image = { data: shot.jpeg.toString('base64'), mimeType: 'image/jpeg' };
    }
    const notes = respawned || shotRespawned ? [`${RESPAWN_NOTE}.`] : [];
    return {
      ok: true,
      text: [...notes, result.text].join('\n'),
      ...(image ? { image } : {}),
      data: { shown: result.shown, onScreen: result.onScreen, interactive: result.interactive, sparse: result.attachScreenshot },
    };
  }

  async screenshot(args: ScreenshotArgs): Promise<OpResult> {
    const shot = await this.shot();
    const respawned = shot.respawned;
    let jpeg = shot.jpeg;
    if (args.crop !== undefined || args.scale !== undefined) {
      const size = jpegSize(jpeg);
      let crop: Crop | undefined;
      if (args.crop && size) {
        this.screen ??= await this.inspect().then(({ read }) => (read.readable ? read.screen : undefined));
        const screen = this.screen ?? { x1: 0, y1: 0, x2: size.width, y2: size.height };
        const sx = size.width / (screen.x2 - screen.x1);
        const sy = size.height / (screen.y2 - screen.y1);
        const x = Math.max(0, Math.round((args.crop.x - screen.x1) * sx));
        const y = Math.max(0, Math.round((args.crop.y - screen.y1) * sy));
        crop = {
          x,
          y,
          width: Math.max(1, Math.min(size.width - x, Math.round(args.crop.width * sx))),
          height: Math.max(1, Math.min(size.height - y, Math.round(args.crop.height * sy))),
        };
      }
      jpeg = await this.images.transform(jpeg, {
        ...(crop ? { crop } : {}),
        ...(args.scale === undefined ? {} : { scale: args.scale }),
      });
    }
    const size = jpegSize(jpeg);
    const notes = respawned ? [`${RESPAWN_NOTE}.`] : [];
    return {
      ok: true,
      text: [...notes, `Screenshot, ${size ? `${String(size.width)}x${String(size.height)} px` : 'JPEG'}.`].join('\n'),
      image: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    };
  }

  private async maestroRun(args: { yaml: string } | { files: string[] }, env: Record<string, string>): Promise<MaestroOutcome> {
    this.actedSinceRead = true;
    const started = Date.now();
    try {
      const { result } = await this.supervisor.call(
        'run',
        { ...args, ...(Object.keys(env).length ? { env } : {}) },
        { retry: false },
      );
      this.log(`maestro run answered in ${String(Date.now() - started)} ms`);
      return result.isError ? { ok: false, error: flowError(textOf(result)) } : { ok: true, error: '' };
    } catch (error) {
      if (!(error instanceof SessionFailure)) throw error;
      return {
        ok: false,
        error: `Maestro's session failed during the run and the flow was not sent again (${error.kind}): ${error.message}`,
      };
    }
  }

  /**
   * Reads the screen after the absence steps Maestro passed, and returns the first step whose absence the read can't
   * prove, with why. `seen` holds the run's reads so far and the selectors of the steps Maestro found present.
   */
  private async unprovenAbsence(
    steps: readonly FlowStep[],
    seen: { reads: ScreenRead[]; present: Set<string> },
  ): Promise<{ step: FlowStep; reason: string } | undefined> {
    const checks = steps.flatMap(step => absenceSelectors(step).map(selector => ({ step, selector })));
    if (checks.length === 0) return undefined;
    const readBefore = (selector: Selector) => seen.present.has(selectorYaml(selector)) || readIn(seen.reads, selector);
    const { read } = await this.inspect();
    let sparseness: Sparseness | undefined;
    if (read.readable) {
      sparseness = sparsenessOf(read);
      const pixelsMatter = checks.some(({ selector }) => !treeBound(selector, readBefore(selector)));
      if (sparseness.sparse && pixelsMatter) sparseness = await this.refine(read, sparseness, (await this.shot()).jpeg);
    }
    seen.reads.push(read);
    for (const { step, selector } of checks) {
      const verdict = checkAbsent(read, selector, { ...(sparseness ? { sparseness } : {}), readBefore: readBefore(selector) });
      if (verdict.passed || verdict.matches.length > 0) continue;
      return {
        step,
        reason: `Maestro passed this step, but ${verdict.reason.charAt(0).toLowerCase()}${verdict.reason.slice(1)}`,
      };
    }
    return undefined;
  }

  /** Moves the images a flow's takeScreenshot wrote into Maestro's working folder to the lane's shots folder. */
  private keepScreenshots(since: number): string[] {
    const kept: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.workDir, { recursive: true, withFileTypes: true });
    } catch {
      return kept;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SCREENSHOT_FILE.test(entry.name)) continue;
      const from = path.join(entry.parentPath, entry.name);
      const relative = path.relative(this.workDir, from);
      if (INTERNAL_DIRS.has(relative.split(path.sep)[0] ?? '')) continue;
      try {
        if (fs.statSync(from).mtimeMs < since - 1000) continue;
        const to = freePath(path.join(this.shotsDir, relative));
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        moveFile(from, to);
        kept.push(to);
      } catch (error) {
        this.log(`could not keep the screenshot ${from}: ${messageOf(error)}`);
      }
    }
    return kept.sort();
  }

  private loadRecording(): RecordedRun[] {
    try {
      return fs
        .readFileSync(this.stepsFile, 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as RecordedRun);
    } catch {
      return [];
    }
  }

  private recordedAppId(): string | undefined {
    return this.loadRecording()
      .map(run => parseFlow(run.yaml).appId)
      .findLast(appId => appId !== undefined);
  }

  private record(run: RecordedRun): void {
    if (run.passed === 0) return;
    fs.mkdirSync(path.dirname(this.stepsFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.stepsFile, `${JSON.stringify(run)}\n`);
  }

  async run(args: RunArgs): Promise<OpResult> {
    const started = Date.now();
    const files = args.file === undefined ? undefined : [args.file];
    const yaml = args.file === undefined ? (args.yaml ?? '') : fs.readFileSync(args.file, 'utf8');
    const prepared: PreparedFlow =
      files === undefined
        ? prepareFlow(yaml, args.appId ?? this.lastAppId ?? this.recordedAppId())
        : { source: yaml, flow: parseFlow(yaml), appId: parseFlow(yaml).appId, headerAdded: false };
    if (prepared.appId !== undefined) this.lastAppId = prepared.appId;
    const { flow } = prepared;
    const env = args.env ?? {};
    const quick = args.quick === true;
    const before = this.recentRead() ?? (await this.inspect());

    let error: string | undefined;
    let failedStep: number | undefined;
    let absence = false;
    let passed = 0;
    const seen = { reads: [before.read], present: new Set<string>() };
    const notePresent = (step: FlowStep) => {
      for (const { selector, expect } of selectorsOfStep(step))
        if (expect === 'present') seen.present.add(selectorYaml(selector));
    };
    if (files === undefined && splittable(flow)) {
      for (const step of flow.steps) {
        const outcome = await this.maestroRun({ yaml: flowYaml(flow, [step], quick) }, env);
        if (!outcome.ok) {
          error = outcome.error;
          failedStep = step.index;
          break;
        }
        notePresent(step);
        const unproven = await this.unprovenAbsence([step], seen);
        if (unproven !== undefined) {
          error = unproven.reason;
          failedStep = step.index;
          absence = true;
          break;
        }
        passed += 1;
      }
    } else {
      const outcome = await this.maestroRun(
        files ? { files } : { yaml: quick && flow.error === undefined ? flowYaml(flow, flow.steps, true) : prepared.source },
        env,
      );
      if (outcome.ok) {
        passed = flow.steps.length;
        for (const step of flow.steps) notePresent(step);
        const unproven = await this.unprovenAbsence(finalAbsenceSteps(flow.steps), seen);
        if (unproven !== undefined) {
          error = unproven.reason;
          failedStep = unproven.step.index;
          absence = true;
          passed = failedStep;
        }
      } else {
        error = outcome.error;
      }
    }

    const after = this.actedSinceRead || !this.lastRead ? (await this.inspect()).read : this.lastRead;
    const seconds = ((Date.now() - started) / 1000).toFixed(2);
    const notes = before.respawned ? [`${RESPAWN_NOTE}.`] : [];
    const screenshots = this.keepScreenshots(started);
    const kept = screenshots.length > 0 ? [`Screenshots (kept after release): ${screenshots.join(', ')}`] : [];
    const data = { screenshots };
    if (error === undefined) {
      this.record({ yaml: prepared.source, passed: flow.steps.length });
      const diff = diffScreens(before.read, after, this.volatileSet());
      const steps = plural(flow.steps.length, 'step');
      return { ok: true, text: [...notes, `Passed ${steps} in ${seconds} s.`, renderDiff(diff), ...kept].join('\n'), data };
    }

    let failure = buildFailure({
      flow: prepared.source,
      error,
      screen: after,
      ...(failedStep === undefined ? {} : { failedStep }),
    });
    if (absence) {
      failure = {
        ...failure,
        kind: 'assertion',
        reachedDevice: 'no',
        reachedDeviceBecause: 'An absence check only reads the screen.',
      };
    }
    if (failedStep === undefined) passed = failure.completedSteps ?? 0;
    this.record({ yaml: prepared.source, passed });
    let image: ImageData | undefined;
    if (failure.screen?.attachScreenshot) {
      const shot = await this.shot().catch(() => undefined);
      if (shot && after.readable && failure.screen.sparseness?.sparse) {
        const refined = await this.refine(after, failure.screen.sparseness, shot.jpeg);
        if (!refined.sparse) failure = { ...failure, screen: look(after, {}, refined) };
      }
      if (shot && failure.screen?.attachScreenshot) image = { data: shot.jpeg.toString('base64'), mimeType: 'image/jpeg' };
    }
    const hint =
      prepared.flow.config === undefined && /Config Section Required/i.test(error)
        ? ['Start the YAML with `appId: <bundle id>` and a `---` line, or pass appId.']
        : [];
    return {
      ok: false,
      text: [...notes, renderFailure(failure), ...hint, ...kept, `(${seconds} s)`].join('\n'),
      failure,
      data,
      ...(image ? { image } : {}),
    };
  }

  recording(args: RecordArgs): OpResult {
    if (args.action === 'clear') {
      fs.rmSync(this.stepsFile, { force: true });
      return { ok: true, text: 'Cleared the recorded steps.' };
    }
    const runs = this.loadRecording();
    let recording: { flow: string; steps: unknown[] };
    try {
      recording = writeFlow(runs);
    } catch (error) {
      return { ok: false, text: `Nothing to record: ${messageOf(error)}` };
    }
    if (args.action === 'show') return { ok: true, text: recording.flow };
    if (args.file === undefined) return { ok: false, text: 'record save needs a file path.' };
    fs.mkdirSync(path.dirname(args.file), { recursive: true });
    fs.writeFileSync(args.file, recording.flow);
    return { ok: true, text: `Wrote ${plural(recording.steps.length, 'step')} to ${args.file}.`, data: { file: args.file } };
  }
}
