import path from 'node:path';
import { systemClock } from '../clock.ts';
import { createXcrunTools } from '../devices/xcrun.ts';
import { CONFIG_FILE, TOOL } from '../name.ts';
import type { ProcessTable } from '../processes.ts';
import { findProjectConfig, loadProjectConfig } from '../project/config.ts';
import { UsageError } from '../registry/refusal.ts';
import { collectHost, collectMaestro, collectToolkit, sampleLoad } from './host.ts';
import { closeTarget, openTarget, planFor, releaseFolder, TARGET_APP, type LiveDeps, type LiveTarget } from './live.ts';
import {
  CELLS,
  MIN_PUBLISHED_SAMPLES,
  OPS,
  PLATFORM_CELLS,
  PLATFORM_OPS,
  SCHEMA,
  type BenchOptions,
  type BenchPlatform,
  type BenchResult,
} from './model.ts';
import { writeReport } from './report.ts';
import { runBatches } from './schedule.ts';

export interface BenchRequest extends BenchOptions {
  platform: BenchPlatform;
  folders: string[];
  out: string;
  setup: boolean;
  command: string;
}

export interface BenchDeps {
  env: NodeJS.ProcessEnv;
  processes: ProcessTable;
  log: (line: string) => void;
  stopped: () => boolean;
}

function requireExampleApp(folder: string, platform: BenchPlatform): void {
  const file = findProjectConfig(folder);
  if (!file) throw new UsageError(`no ${CONFIG_FILE} in ${folder} or above it`, `run ${TOOL} bench in examples/expo-app`);
  const config = loadProjectConfig(file);
  if (platform === 'web' && !config.web) {
    throw new UsageError(`${file} declares no web app`, `run ${TOOL} bench --platform web in examples/expo-app`);
  }
  if (config.app?.bundleId !== TARGET_APP.bundleId) {
    throw new UsageError(
      `${file} is for ${config.app?.bundleId ?? 'a web app only'}; the bench drives the example app, ${TARGET_APP.bundleId}`,
      `run ${TOOL} bench in examples/expo-app, or pass --worktree <checkout>/examples/expo-app`,
    );
  }
}

export async function runBench(
  request: BenchRequest,
  deps: BenchDeps,
): Promise<{ result: BenchResult; markdown: string; json: string }> {
  for (const folder of request.folders) requireExampleApp(folder, request.platform);
  const cells = PLATFORM_CELLS[request.platform];
  const ops = PLATFORM_OPS[request.platform];
  if (request.platform === 'android' && request.cells.includes('cold-cold')) {
    throw new UsageError(
      'cold-cold shuts the device down between samples, and an emulator lane boots its emulator only when it is claimed',
      `leave out cold-cold on Android: --cells ${cells.join(',')}`,
    );
  }
  const otherCells = request.cells.filter(cell => !cells.includes(cell));
  if (otherCells.length > 0) {
    throw new UsageError(
      `--platform ${request.platform} has no ${otherCells.join(', ')} cell: a browser lane is measured warm, where the browser and the page are up`,
      `pass --cells ${cells.join(',')}`,
    );
  }
  const otherOps = request.ops.filter(op => !ops.includes(op));
  if (otherOps.length > 0) {
    throw new UsageError(`--platform ${request.platform} has no ${otherOps.join(', ')} op`, `pick from ${ops.join(',')}`);
  }
  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  if (request.samples < MIN_PUBLISHED_SAMPLES)
    notes.push(
      `${String(request.samples)} samples per cell is below the ${String(MIN_PUBLISHED_SAMPLES)} the method asks for publication.`,
    );
  const noun = request.platform === 'android' ? 'emulator' : request.platform === 'web' ? 'browser' : 'simulator';
  if (request.folders.length < 2)
    notes.push(`One ${noun} only: no --pair folder was given, so the warm cells did not alternate two ${noun}s.`);
  deps.log('collecting the host, toolkit and Maestro details');
  const host = collectHost();
  const toolkit = collectToolkit();
  const maestro = await collectMaestro(deps.env);
  if (toolkit.dirty) notes.push('The toolkit checkout had uncommitted changes to tracked files.');
  const live: LiveDeps = {
    env: deps.env,
    processes: deps.processes,
    platform: request.platform,
    sim: createXcrunTools(),
    log: deps.log,
  };
  const targets: LiveTarget[] = [];
  let batches: BenchResult['batches'];
  try {
    for (const [index, folder] of request.folders.entries()) {
      try {
        targets.push(await openTarget(index === 0 ? 'A' : 'B', path.resolve(folder), live, request.setup));
      } catch (error) {
        deps.log(`releasing ${folder} after a failed start: ${await releaseFolder(path.resolve(folder), live)}`);
        throw error;
      }
    }
    const [first] = targets;
    if (!first) throw new Error(`no ${noun} was brought up`);
    const plans = CELLS.filter(cell => request.cells.includes(cell)).flatMap(cell =>
      OPS.filter(op => request.ops.includes(op)).map(op => planFor(cell, op, cell === 'warm' ? targets : [first], live)),
    );
    batches = await runBatches(plans, {
      load: sampleLoad,
      clock: systemClock,
      log: deps.log,
      samples: request.samples,
      maxLoad: request.maxLoad,
      loadWaitMs: request.loadWaitMs,
      rerunFlagged: request.rerunFlagged,
      stopped: deps.stopped,
    });
    if (deps.stopped()) notes.push('Stopped early by a signal; the batches that ran are reported.');
  } finally {
    for (const target of targets) {
      try {
        notes.push(...(await closeTarget(target, live)));
      } catch (error) {
        notes.push(`${target.info.sim}: cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const result: BenchResult = {
    schema: SCHEMA,
    startedAt,
    finishedAt: new Date().toISOString(),
    command: request.command,
    options: {
      platform: request.platform,
      samples: request.samples,
      cells: request.cells,
      ops: request.ops,
      maxLoad: request.maxLoad,
      loadWaitMs: request.loadWaitMs,
      rerunFlagged: request.rerunFlagged,
    },
    host,
    toolkit,
    maestro,
    targets: targets.map(t => t.info),
    batches,
    notes,
  };
  return { result, ...writeReport(request.out, result) };
}
