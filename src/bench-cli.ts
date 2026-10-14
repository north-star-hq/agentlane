import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CELLS,
  MIN_PUBLISHED_SAMPLES,
  OPS,
  PLATFORM_CELLS,
  PLATFORM_OPS,
  SCHEMA,
  type BenchResult,
  type Cell,
  type Op,
} from './bench/model.ts';
import { compareRuns, renderAgreement } from './bench/report.ts';
import { runBench } from './bench/run.ts';
import { TOOL } from './name.ts';
import type { ProcessTable } from './processes.ts';
import { stateDir } from './registry/paths.ts';
import { NotClaimed, Refusal, UsageError } from './registry/refusal.ts';
import { groupUsage, helpOf, type UsageGroup } from './usage.ts';

export const BENCH_COMMANDS = ['bench'] as const;

export const BENCH_HELP: UsageGroup<(typeof BENCH_COMMANDS)[number]> = {
  title: 'Benchmark (the method: bench/README.md in the package):',
  entries: {
    bench: `  bench      Measure the toolkit on examples/expo-app: cold-cold, cold, warm, relaunch and first interaction,
             each with read, screenshot, quick tap, tap and a short flow; on the web app's browser lane, warm
             read, screenshot, click and flow. Writes a dated Markdown report and its JSON.
               --worktree <dir>   the example app's folder (default: this folder)
               --platform <name>  ios (default), android or web; android has no cold-cold cell, web only warm
               --pair <dir>       the example app in a second checkout; the warm cells then alternate two devices
               --samples <n>      calls per cell and simulator (default ${String(MIN_PUBLISHED_SAMPLES)})
               --cells <list>     some of ${CELLS.join(',')} (default: all the platform has)
               --ops <list>       some of ${OPS.join(',')} (default: all the platform has)
               --max-load <n>     the 1-min load average that flags a batch (default: the core count)
               --load-wait <s>    how long a batch waits for the load to drop under that (default 300)
               --no-rerun         keep flagged batches as they are instead of rerunning them once at the end
               --no-setup         skip the setup hook in the first up
               --out <dir>        where the report goes (default: <state dir>/bench)
             bench compare <a.json> <b.json>: the two runs' medians side by side.
               --tolerance <f>    the agreement limit (default 0.2)
               --cells <list>     the cells to compare (default warm)
`,
  },
};

export const BENCH_USAGE = groupUsage(BENCH_HELP);

export interface BenchCliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  argv: readonly string[];
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  processes: ProcessTable;
  onSignal?: (handler: () => void) => () => void;
}

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;

function listOf<T extends string>(raw: string | undefined, all: readonly T[], flag: string): T[] {
  if (raw === undefined) return [...all];
  const picked = raw
    .split(',')
    .map(x => x.trim())
    .filter(x => x !== '');
  const unknown = picked.filter(x => !(all as readonly string[]).includes(x));
  if (unknown.length > 0 || picked.length === 0)
    throw new UsageError(`${flag} ${raw} names ${unknown.join(', ') || 'nothing'}`, `pick from ${all.join(',')}`);
  return picked as T[];
}

function positiveNumber(raw: string, flag: string, integer: boolean): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)))
    throw new UsageError(
      `${flag} ${raw} is not a positive ${integer ? 'whole number' : 'number'}`,
      `pass ${flag} ${integer ? '16' : '8'}`,
    );
  return value;
}

function readResult(file: string): BenchResult {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { schema?: unknown };
  if (parsed.schema !== SCHEMA) throw new UsageError(`${file} is not a bench result`, 'pass the .json next to a report');
  return parsed as BenchResult;
}

function compare(args: string[], deps: BenchCliDeps): number {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { tolerance: { type: 'string', default: '0.2' }, cells: { type: 'string' } },
  });
  const [a, b, ...rest] = positionals;
  if (a === undefined || b === undefined || rest.length > 0)
    throw new UsageError('compare takes two result files', `${TOOL} bench compare <a.json> <b.json>`);
  const tolerance = positiveNumber(values.tolerance, '--tolerance', false);
  const cells: Cell[] = values.cells === undefined ? ['warm'] : listOf(values.cells, CELLS, '--cells');
  const left = readResult(path.resolve(deps.cwd, a));
  const right = readResult(path.resolve(deps.cwd, b));
  const rows = compareRuns(left, right, tolerance, cells);
  deps.stdout(renderAgreement(rows, left, right, tolerance));
  return rows.length > 0 && rows.every(r => r.within) ? 0 : EXIT_FAILED;
}

async function bench(args: string[], deps: BenchCliDeps): Promise<number> {
  if (args[0] === 'compare') return compare(args.slice(1), deps);
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      worktree: { type: 'string' },
      pair: { type: 'string' },
      platform: { type: 'string', default: 'ios' },
      samples: { type: 'string', default: String(MIN_PUBLISHED_SAMPLES) },
      cells: { type: 'string' },
      ops: { type: 'string' },
      'max-load': { type: 'string' },
      'load-wait': { type: 'string', default: '300' },
      'no-rerun': { type: 'boolean', default: false },
      'no-setup': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected ${positionals.join(' ')}`, `${TOOL} bench --help`);
  const platform = values.platform;
  if (platform !== 'ios' && platform !== 'android' && platform !== 'web')
    throw new UsageError(`--platform ${platform} is not a platform`, 'pass --platform ios, android or web');
  const folders = [path.resolve(deps.cwd, values.worktree ?? '.')];
  if (values.pair !== undefined) folders.push(path.resolve(deps.cwd, values.pair));
  const signal = { stopped: false };
  const unhook = deps.onSignal?.(() => {
    signal.stopped = true;
    deps.stderr(`${TOOL} bench: stopping after the current sample; the lanes are released and a partial report written\n`);
  });
  try {
    const { result, markdown, json } = await runBench(
      {
        platform,
        folders,
        out: values.out === undefined ? path.join(stateDir(deps.env), 'bench') : path.resolve(deps.cwd, values.out),
        setup: !values['no-setup'],
        command: [TOOL, ...deps.argv].join(' '),
        samples: positiveNumber(values.samples, '--samples', true),
        cells: values.cells === undefined ? [...PLATFORM_CELLS[platform]] : listOf(values.cells, CELLS, '--cells'),
        ops: values.ops === undefined ? [...PLATFORM_OPS[platform]] : listOf<Op>(values.ops, OPS, '--ops'),
        maxLoad: values['max-load'] === undefined ? os.cpus().length : positiveNumber(values['max-load'], '--max-load', false),
        loadWaitMs: positiveNumber(values['load-wait'], '--load-wait', false) * 1000,
        rerunFlagged: !values['no-rerun'],
      },
      {
        env: deps.env,
        processes: deps.processes,
        log: line => {
          deps.stderr(`${TOOL} bench: ${line}\n`);
        },
        stopped: () => signal.stopped,
      },
    );
    deps.stdout(`${markdown}\n${json}\n`);
    const broken = result.batches.filter(b => !b.superseded && (b.aborted !== undefined || b.series.some(s => s.failures > 0)));
    return broken.length === 0 && !signal.stopped ? 0 : EXIT_FAILED;
  } finally {
    unhook?.();
  }
}

export async function runBenchCommand(command: string, args: string[], deps: BenchCliDeps): Promise<number> {
  try {
    if (command !== 'bench') throw new UsageError(`'${command}' is not a bench command`, `run ${TOOL} --help`);
    return await bench(args, deps);
  } catch (error) {
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      deps.stderr(`${TOOL} ${command}: ${error.message}\n\n${helpOf(BENCH_HELP, command) ?? BENCH_USAGE}`);
      return EXIT_USAGE;
    }
    if (error instanceof UsageError) {
      deps.stderr(`${TOOL}: ${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof NotClaimed || error instanceof Refusal) {
      deps.stderr(`${TOOL}: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    deps.stderr(`${TOOL} bench: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILED;
  }
}
