import type { Platform } from '../devices/backend.ts';
import type { LoadSample, LoadVerdict, Summary } from './stats.ts';

export const CELLS = ['warm', 'relaunch', 'cold', 'first-interaction', 'cold-cold'] as const;
export type Cell = (typeof CELLS)[number];

export const OPS = ['read', 'screenshot', 'quick-tap', 'tap', 'click', 'flow'] as const;
export type Op = (typeof OPS)[number];

/** A device or the lane's browser: the bench drives the example's mobile app or its web app. */
export type BenchPlatform = Platform | 'web';

/** The ops each platform has, and the cells: a browser lane is measured warm. */
export const PLATFORM_OPS: Record<BenchPlatform, readonly Op[]> = {
  ios: ['read', 'screenshot', 'quick-tap', 'tap', 'flow'],
  android: ['read', 'screenshot', 'quick-tap', 'tap', 'flow'],
  web: ['read', 'screenshot', 'click', 'flow'],
};
export const PLATFORM_CELLS: Record<BenchPlatform, readonly Cell[]> = {
  ios: CELLS,
  android: CELLS.filter(cell => cell !== 'cold-cold'),
  web: ['warm'],
};

export const SCHEMA = 'agentlane-bench/1';
export const MIN_PUBLISHED_SAMPLES = 16;

export interface Sample {
  /** The timed span, from the timer's start to the op's successful answer. */
  ms: number;
  ok: boolean;
  startedAt: string;
  /** Parts of the timed span (and untimed preparation, prefixed "untimed "), in milliseconds. */
  phases: Record<string, number>;
  /** Reads made before the op because the app's anchor wasn't on screen yet; they are inside the timed span. */
  gateReads: number;
  responseBytes?: number;
  /** The 1-minute load average when the sample began. */
  load1?: number;
  error?: string;
}

export interface Series {
  sim: string;
  samples: Sample[];
  summary: Summary | null;
  failures: number;
}

export interface Batch {
  id: string;
  cell: Cell;
  op: Op;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** How long the batch waited for the load to drop below the limit before it started. */
  loadWaitMs: number;
  load: { start: LoadSample; end: LoadSample };
  verdict: LoadVerdict;
  /** A later attempt of the same cell and op replaced this one in the summary. */
  superseded: boolean;
  series: Series[];
  aborted?: string;
}

export interface TargetInfo {
  sim: string;
  folder: string;
  lane: string;
  /** Absent in results from before the bench drove emulators: those are iOS. */
  platform?: BenchPlatform;
  /** The simulator's UDID, the emulator's adb serial, or the browser's driver session. */
  udid: string;
  deviceName: string;
  deviceType: string;
  runtime: string;
  metroPort: number | null;
  apiPort: number | null;
  /** The web app's port, on a browser lane. */
  webPort?: number | null;
}

export interface HostInfo {
  model: string;
  chip: string;
  cores: number;
  memoryGb: number;
  macos: string;
  xcode: string;
  runtimes: string[];
  node: string;
}

export interface ToolkitInfo {
  version: string;
  commit: string | null;
  dirty: boolean | null;
}

export interface MaestroInfo {
  version: string;
  binary: string | null;
  override: boolean;
  /** sha256 of the pinned release zip, which the install verified before unpacking. */
  releaseSha256: string;
  /** sha256 of the launcher script and of the CLI jar actually run. */
  binarySha256: string | null;
  jarSha256: string | null;
  reportedVersion: string | null;
}

export interface BenchOptions {
  platform?: BenchPlatform;
  samples: number;
  cells: Cell[];
  ops: Op[];
  maxLoad: number;
  loadWaitMs: number;
  rerunFlagged: boolean;
}

export interface BenchResult {
  schema: typeof SCHEMA;
  startedAt: string;
  finishedAt: string;
  command: string;
  options: BenchOptions;
  host: HostInfo;
  toolkit: ToolkitInfo;
  maestro: MaestroInfo;
  targets: TargetInfo[];
  batches: Batch[];
  notes: string[];
}
