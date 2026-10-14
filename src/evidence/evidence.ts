import fs from 'node:fs';
import path from 'node:path';
import { browserOfLane, hasBrowser } from '../browser/lane-browser.ts';
import type { BrowserControl } from '../browser/control.ts';
import type { BrowserTools } from '../browser/tools.ts';
import type { Clock } from '../clock.ts';
import { adbPath } from '../devices/adb.ts';
import { DriverError, messageOf } from '../driver/errors.ts';
import { enginePaths } from '../driver/paths.ts';
import { evidenceDir } from '../hooks/env.ts';
import { CLI } from '../name.ts';
import { UsageError } from '../registry/refusal.ts';
import type { LaneInfo } from '../registry/types.ts';
import { laneDir, readUpRecord } from '../up/lane-files.ts';
import { startDeviceVideo, stopDeviceVideo, writeDeviceLog, type DeviceTarget, type EvidenceSystem } from './device.ts';
import {
  clearInProgress,
  copyNewer,
  newEvidenceFile,
  newEvidenceFolder,
  readFrom,
  readInProgress,
  sizeOf,
  writeInProgress,
  type EvidenceTarget,
} from './files.ts';

export interface EvidenceContext {
  stateDir: string;
  lane: LaneInfo;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  system: EvidenceSystem;
  browser: BrowserTools;
  /** The device screen as the lane's driver takes it, as JPEG. */
  deviceShot: () => Promise<Buffer>;
}

export interface Kept {
  /** The file or folder written. */
  path: string;
  files: string[];
  notes: string[];
  problems: string[];
}

export function laneEvidence(stateDir: string, laneId: string): string {
  return evidenceDir(laneDir(stateDir, laneId));
}

/** Which of the lane's screens a verb acts on: the one named, or the only one the lane holds. */
export function evidenceTarget(lane: LaneInfo, asked: EvidenceTarget | undefined): EvidenceTarget {
  if (asked === 'device' && lane.device === null) {
    throw new UsageError(
      `lane ${lane.id} holds no simulator or emulator`,
      `${CLI} up --platform ios (or android), or pass --browser`,
    );
  }
  if (asked === 'browser' && lane.browser === null) {
    throw new UsageError(`lane ${lane.id} holds no browser`, `${CLI} up --platform web, or pass --device`);
  }
  if (asked) return asked;
  if (lane.device && lane.browser) {
    throw new UsageError(
      `lane ${lane.id} holds a ${lane.device.platform === 'ios' ? 'simulator' : 'emulator'} and a browser`,
      'pass --device or --browser',
    );
  }
  if (lane.device) return 'device';
  if (lane.browser) return 'browser';
  throw new UsageError(`lane ${lane.id} holds no simulator, emulator or browser`, `${CLI} up`);
}

export function deviceTargetOf(ctx: Pick<EvidenceContext, 'stateDir' | 'lane' | 'env'>): DeviceTarget {
  const { device } = ctx.lane;
  if (!device) throw new UsageError(`lane ${ctx.lane.id} holds no simulator or emulator`, `${CLI} up`);
  const bundleId = readUpRecord(laneDir(ctx.stateDir, ctx.lane.id))?.bundleId ?? null;
  return device.platform === 'ios'
    ? { platform: 'ios', device: device.id, bundleId }
    : { platform: 'android', device: device.serial ?? device.id, adb: adbPath(ctx.env), bundleId };
}

async function controlOf(ctx: EvidenceContext): Promise<BrowserControl> {
  const { lane } = ctx;
  if (!hasBrowser(lane)) throw new UsageError(`lane ${lane.id} holds no browser`, `${CLI} up --platform web`);
  const { control } = await browserOfLane(ctx.browser, ctx.stateDir, lane, ctx.env);
  if (!(await control.isOpen())) {
    throw new DriverError(
      `the lane's ${control.driver} browser is not open`,
      `${CLI} up --platform web (it opens the web app in it)`,
    );
  }
  return control;
}

export async function keepScreenshot(ctx: EvidenceContext, target: EvidenceTarget): Promise<Kept> {
  const evidence = laneEvidence(ctx.stateDir, ctx.lane.id);
  const at = new Date(ctx.clock.now());
  if (target === 'browser') {
    const file = newEvidenceFile(evidence, 'screenshot-browser', 'png', at);
    await (await controlOf(ctx)).screenshot(file);
    return { path: file, files: [file], notes: [], problems: [] };
  }
  const file = newEvidenceFile(evidence, 'screenshot-device', 'jpg', at);
  fs.writeFileSync(file, await ctx.deviceShot(), { mode: 0o600 });
  return { path: file, files: [file], notes: [], problems: [] };
}

export async function startVideo(ctx: EvidenceContext, target: EvidenceTarget): Promise<Kept> {
  const evidence = laneEvidence(ctx.stateDir, ctx.lane.id);
  const running = readInProgress(evidence, 'video', target);
  if (running) {
    throw new UsageError(
      `a ${target} recording runs already, into ${running.file ?? 'its file'}`,
      `${CLI} evidence video stop --${target}`,
    );
  }
  const at = new Date(ctx.clock.now());
  if (target === 'browser') {
    const file = newEvidenceFile(evidence, 'video-browser', 'webm', at);
    await (await controlOf(ctx)).videoStart(file);
    writeInProgress(evidence, 'video', { version: 1, target, startedAt: ctx.clock.now(), file });
    return { path: file, files: [], notes: [], problems: [] };
  }
  const file = newEvidenceFile(evidence, 'video-device', 'mp4', at);
  const recording = await startDeviceVideo(ctx.system, deviceTargetOf(ctx), file, ctx.clock);
  writeInProgress(evidence, 'video', recording);
  return {
    path: file,
    files: [],
    notes: recording.platform === 'android' ? ['an emulator records at most 3 minutes at a time'] : [],
    problems: [],
  };
}

export async function stopVideo(ctx: EvidenceContext, target: EvidenceTarget): Promise<Kept> {
  const evidence = laneEvidence(ctx.stateDir, ctx.lane.id);
  const running = readInProgress(evidence, 'video', target);
  if (!running?.file)
    throw new UsageError(`no ${target} recording runs for lane ${ctx.lane.id}`, `${CLI} evidence video start --${target}`);
  if (target === 'browser') {
    try {
      await (await controlOf(ctx)).videoStop();
    } finally {
      clearInProgress(evidence, 'video', target);
    }
    const exists = fs.existsSync(running.file);
    return {
      path: running.file,
      files: exists ? [running.file] : [],
      notes: [],
      problems: exists ? [] : ['the driver wrote no video'],
    };
  }
  const adb = running.platform === 'android' ? adbPath(ctx.env) : undefined;
  const stopped = await stopDeviceVideo(ctx.system, running, ctx.clock, adb);
  clearInProgress(evidence, 'video', target);
  return { path: running.file, files: stopped.file ? [stopped.file] : [], notes: [], problems: stopped.problems };
}

function driverFiles(ctx: Pick<EvidenceContext, 'stateDir' | 'lane'>): { log: string; steps: string; shots: string } {
  const paths = enginePaths(ctx.stateDir, ctx.lane.id);
  return { log: paths.log, steps: paths.steps, shots: paths.shots };
}

/** Restarts the background trace a Playwright browser keeps for failures, so a trace stopped now starts here. */
async function restartTrace(control: BrowserControl, scratch: string): Promise<void> {
  await control.traceStop(scratch).catch(() => []);
  fs.rmSync(scratch, { recursive: true, force: true });
  await control.traceStart();
}

export async function startTrace(ctx: EvidenceContext, target: EvidenceTarget): Promise<Kept> {
  const evidence = laneEvidence(ctx.stateDir, ctx.lane.id);
  const startedAt = ctx.clock.now();
  if (target === 'browser') {
    const control = await controlOf(ctx);
    if (control.tracesActions) await restartTrace(control, path.join(evidence, '.trace-scratch'));
    else await control.traceStart();
    writeInProgress(evidence, 'trace', { version: 1, target, startedAt });
    return { path: evidence, files: [], notes: [`tracing the ${control.driver} browser's actions`], problems: [] };
  }
  const files = driverFiles(ctx);
  writeInProgress(evidence, 'trace', {
    version: 1,
    target,
    startedAt,
    driverLogBytes: sizeOf(files.log),
    stepsBytes: sizeOf(files.steps),
  });
  return { path: evidence, files: [], notes: ["tracing the driver's calls, the flows run and the device's log"], problems: [] };
}

/**
 * Stops a trace and keeps it. A browser's is the driver's own: Playwright's action trace (`npx playwright show-trace`
 * opens it), which also runs from `up` on so a stop without a start covers the session so far; agent-browser's is a
 * DevTools performance trace. A device's is what the toolkit saw: the driver's log, the flows that ran, the
 * screenshots they kept, and the device's log, over the traced time.
 */
export async function stopTrace(ctx: EvidenceContext, target: EvidenceTarget): Promise<Kept> {
  const evidence = laneEvidence(ctx.stateDir, ctx.lane.id);
  const started = readInProgress(evidence, 'trace', target);
  const at = new Date(ctx.clock.now());
  if (target === 'browser') {
    const control = await controlOf(ctx);
    if (!started && !control.tracesActions) {
      throw new UsageError(
        'no browser trace runs: agent-browser traces only between a start and a stop',
        `${CLI} evidence trace start --browser`,
      );
    }
    const dir = newEvidenceFolder(evidence, 'trace-browser', at);
    const kept: Kept = { path: dir, files: [], notes: [], problems: [] };
    try {
      kept.files.push(...(await control.traceStop(dir)));
    } finally {
      clearInProgress(evidence, 'trace', target);
    }
    if (control.tracesActions) {
      try {
        await control.traceStart();
      } catch (error) {
        kept.problems.push(`could not start the failure trace again: ${messageOf(error).split('\n')[0] ?? ''}`);
      }
    }
    return kept;
  }
  if (!started) throw new UsageError(`no device trace runs for lane ${ctx.lane.id}`, `${CLI} evidence trace start --device`);
  const dir = newEvidenceFolder(evidence, 'trace-device', at);
  const kept: Kept = { path: dir, files: [], notes: [], problems: [] };
  const files = driverFiles(ctx);
  const write = (name: string, text: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode: 0o600 });
    kept.files.push(file);
  };
  write('driver.log', readFrom(files.log, started.driverLogBytes ?? 0));
  write('flows.jsonl', readFrom(files.steps, started.stepsBytes ?? 0));
  kept.files.push(...copyNewer(files.shots, path.join(dir, 'screenshots'), started.startedAt));
  try {
    const file = path.join(dir, 'device.log');
    const scope = await writeDeviceLog(ctx.system, deviceTargetOf(ctx), ctx.clock.now() - started.startedAt, file, ctx.clock);
    kept.files.push(file);
    kept.notes.push(`device.log holds ${scope}`);
  } catch (error) {
    kept.problems.push(`device log: ${messageOf(error).split('\n')[0] ?? ''}`);
  }
  clearInProgress(evidence, 'trace', target);
  return kept;
}

function copyLogs(from: string, into: string): string[] {
  const copied: string[] = [];
  for (const name of fs.readdirSync(from, { withFileTypes: true })) {
    if (!name.isFile() || !name.name.endsWith('.log')) continue;
    fs.mkdirSync(into, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(from, name.name), path.join(into, name.name));
    copied.push(path.join(into, name.name));
  }
  return copied;
}

/**
 * Keeps the lane's logs as they are now: the services' and hooks' logs, the driver's, the device's over the last
 * `sinceMs`, and the browser's console. `targets` names the screens whose own logs to take.
 */
export async function keepLogs(ctx: EvidenceContext, targets: readonly EvidenceTarget[], sinceMs: number): Promise<Kept> {
  const evidence = laneEvidence(ctx.stateDir, ctx.lane.id);
  const dir = newEvidenceFolder(evidence, 'logs', new Date(ctx.clock.now()));
  const kept: Kept = { path: dir, files: [], notes: [], problems: [] };
  const lane = laneDir(ctx.stateDir, ctx.lane.id);
  if (fs.existsSync(lane)) {
    kept.files.push(...copyLogs(lane, path.join(dir, 'services')));
    const hooks = path.join(lane, 'hooks');
    if (fs.existsSync(hooks)) kept.files.push(...copyLogs(hooks, path.join(dir, 'hooks')));
  }
  const driverLog = driverFiles(ctx).log;
  if (fs.existsSync(driverLog)) {
    fs.copyFileSync(driverLog, path.join(dir, 'driver.log'));
    kept.files.push(path.join(dir, 'driver.log'));
  }
  if (targets.includes('device') && ctx.lane.device) {
    try {
      const file = path.join(dir, 'device.log');
      const scope = await writeDeviceLog(ctx.system, deviceTargetOf(ctx), sinceMs, file, ctx.clock);
      kept.files.push(file);
      kept.notes.push(`device.log holds ${scope}`);
    } catch (error) {
      kept.problems.push(`device log: ${messageOf(error).split('\n')[0] ?? ''}`);
    }
  }
  if (targets.includes('browser') && ctx.lane.browser) {
    try {
      const file = path.join(dir, 'browser-console.txt');
      fs.writeFileSync(file, await (await controlOf(ctx)).console(), { mode: 0o600 });
      kept.files.push(file);
    } catch (error) {
      kept.problems.push(`browser console: ${messageOf(error).split('\n')[0] ?? ''}`);
    }
  }
  return kept;
}

/** What a failed `run` on the device left: the flow, the failure, the screen, and the driver's log over the run. */
export function keepRunFailure(
  stateDir: string,
  laneId: string,
  run: { flow: string; failure: string; screenshot: Buffer | null; driverLogFrom: number },
  at: Date = new Date(),
): string {
  const dir = newEvidenceFolder(laneEvidence(stateDir, laneId), 'run-failed', at);
  fs.writeFileSync(path.join(dir, 'flow.yaml'), run.flow, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'failure.txt'), `${run.failure.trimEnd()}\n`, { mode: 0o600 });
  if (run.screenshot) fs.writeFileSync(path.join(dir, 'screenshot.jpg'), run.screenshot, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'driver.log'), readFrom(enginePaths(stateDir, laneId).log, run.driverLogFrom), {
    mode: 0o600,
  });
  return dir;
}

/** Ends the lane's recordings at its release so each file is complete; the files stay with the evidence. */
export async function stopRecordings(
  ctx: Pick<EvidenceContext, 'stateDir' | 'lane' | 'env' | 'clock' | 'system'>,
  control: BrowserControl | null,
): Promise<{ notes: string[]; problems: string[] }> {
  const evidence = laneEvidence(ctx.stateDir, ctx.lane.id);
  const result = { notes: [] as string[], problems: [] as string[] };
  const browser = readInProgress(evidence, 'video', 'browser');
  if (browser) {
    try {
      if (control) await control.videoStop();
      result.notes.push(`stopped the browser recording into ${browser.file ?? 'its file'}`);
    } catch (error) {
      result.problems.push(`could not stop the browser recording: ${messageOf(error).split('\n')[0] ?? ''}`);
    }
    clearInProgress(evidence, 'video', 'browser');
  }
  const device = readInProgress(evidence, 'video', 'device');
  if (device) {
    let adb: string | undefined;
    try {
      adb = device.platform === 'android' ? adbPath(ctx.env) : undefined;
    } catch {
      adb = undefined;
    }
    const stopped = await stopDeviceVideo(ctx.system, device, ctx.clock, adb);
    if (stopped.file) result.notes.push(`stopped the device recording into ${stopped.file}`);
    result.problems.push(...stopped.problems.map(p => `device recording: ${p}`));
    clearInProgress(evidence, 'video', 'device');
  }
  clearInProgress(evidence, 'trace', 'browser');
  clearInProgress(evidence, 'trace', 'device');
  return result;
}
