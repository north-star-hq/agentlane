import type { Clock } from '../clock.ts';
import type { Batch, Cell, Op, Sample, Series } from './model.ts';
import { judgeLoad, summarize, type LoadSample } from './stats.ts';

export interface BatchPlan {
  cell: Cell;
  op: Op;
  /** The simulators this batch drives; with two, their calls alternate. */
  sims: string[];
  /** The batch boots simulators itself, which raises the load it ends with. */
  selfLoading?: boolean;
  /** Untimed: bring the simulators into the cell's state once, before the first sample. */
  prepare(): Promise<void>;
  /** One sample on one simulator, including any untimed per-sample preparation. */
  sample(sim: string, index: number): Promise<Sample>;
}

export interface ScheduleDeps {
  load: () => LoadSample;
  clock: Clock;
  log: (line: string) => void;
  samples: number;
  maxLoad: number;
  loadWaitMs: number;
  loadPollMs?: number;
  rerunFlagged: boolean;
  /** Stop starting new samples (a signal arrived). */
  stopped?: () => boolean;
}

export const MAX_CONSECUTIVE_FAILURES = 3;

async function waitForLoad(deps: ScheduleDeps): Promise<{ waitedMs: number; below: boolean }> {
  const started = deps.clock.now();
  const poll = deps.loadPollMs ?? 5000;
  let logged = false;
  for (;;) {
    const now = deps.load();
    const load1 = now.loadavg[0];
    const pressed = now.pressure === 'warn' || now.pressure === 'critical';
    if (load1 < deps.maxLoad && !pressed) return { waitedMs: deps.clock.now() - started, below: true };
    const waited = deps.clock.now() - started;
    if (waited >= deps.loadWaitMs) return { waitedMs: waited, below: false };
    if (!logged) {
      const why = pressed
        ? `memory pressure is ${now.pressure}`
        : `load ${load1.toFixed(1)} is at or above ${deps.maxLoad.toFixed(1)}`;
      deps.log(`${why}; waiting up to ${String(Math.round(deps.loadWaitMs / 1000))} s`);
      logged = true;
    }
    if (deps.stopped?.()) return { waitedMs: waited, below: false };
    await deps.clock.sleep(Math.min(poll, deps.loadWaitMs - waited));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedSample(clock: Clock, error: unknown): Sample {
  return { ms: 0, ok: false, startedAt: new Date(clock.now()).toISOString(), phases: {}, gateReads: 0, error: messageOf(error) };
}

function seriesOf(sim: string, samples: Sample[]): Series {
  const ok = samples.filter(s => s.ok).map(s => s.ms);
  return { sim, samples, summary: summarize(ok), failures: samples.length - ok.length };
}

async function runBatch(plan: BatchPlan, attempt: number, deps: ScheduleDeps): Promise<Batch> {
  const { waitedMs } = await waitForLoad(deps);
  const id = `${plan.cell}/${plan.op}#${String(attempt)}`;
  const samples = new Map<string, Sample[]>(plan.sims.map(sim => [sim, []]));
  let aborted: string | undefined;
  const startedAt = new Date(deps.clock.now()).toISOString();
  try {
    await plan.prepare();
  } catch (error) {
    aborted = `preparing the batch failed: ${messageOf(error)}`;
  }
  const start = deps.load();
  const streak = new Map<string, number>(plan.sims.map(sim => [sim, 0]));
  for (let index = 0; index < deps.samples && !aborted; index++) {
    for (const sim of plan.sims) {
      if (deps.stopped?.()) {
        aborted = 'stopped by a signal';
        break;
      }
      const load1 = deps.load().loadavg[0];
      let sample: Sample;
      try {
        sample = await plan.sample(sim, index);
      } catch (error) {
        sample = failedSample(deps.clock, error);
      }
      sample.load1 = load1;
      samples.get(sim)?.push(sample);
      const run = sample.ok ? 0 : (streak.get(sim) ?? 0) + 1;
      streak.set(sim, run);
      if (run >= MAX_CONSECUTIVE_FAILURES) {
        aborted = `${String(run)} samples in a row failed on ${sim}; last: ${sample.error ?? 'no error text'}`;
        break;
      }
    }
  }
  const end = deps.load();
  const batch: Batch = {
    id,
    cell: plan.cell,
    op: plan.op,
    attempt,
    startedAt,
    finishedAt: new Date(deps.clock.now()).toISOString(),
    loadWaitMs: waitedMs,
    load: { start, end },
    verdict: judgeLoad(start, end, deps.maxLoad, plan.selfLoading),
    superseded: false,
    series: plan.sims.map(sim => seriesOf(sim, samples.get(sim) ?? [])),
    ...(aborted ? { aborted } : {}),
  };
  const medians = batch.series
    .map(s => `${s.sim} ${s.summary ? `${(s.summary.median / 1000).toFixed(3)} s` : 'none'}`)
    .join(', ');
  deps.log(
    `${id}: median ${medians}; load ${start.loadavg[0].toFixed(1)} → ${end.loadavg[0].toFixed(1)}${batch.verdict.high ? ' (HIGH LOAD)' : ''}${aborted ? `; aborted: ${aborted}` : ''}`,
  );
  return batch;
}

/** Marks every attempt but the chosen one per cell and op: the last attempt not under high load, else the last. */
export function markSuperseded(batches: Batch[]): void {
  const groups = new Map<string, Batch[]>();
  for (const b of batches) {
    const key = `${b.cell}/${b.op}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  for (const group of groups.values()) {
    const usable = group.filter(b => !b.aborted);
    const chosen = usable.filter(b => !b.verdict.high).at(-1) ?? usable.at(-1) ?? group.at(-1);
    for (const b of group) b.superseded = b !== chosen;
  }
}

/**
 * Runs each plan as one batch. A batch waits (up to loadWaitMs) for the load to drop below the limit before it starts;
 * a batch that still ran under high load is flagged, and with rerunFlagged it runs once more at the end if the load
 * has dropped by then. Every attempt is kept; the summary uses the chosen one.
 */
export async function runBatches(plans: readonly BatchPlan[], deps: ScheduleDeps): Promise<Batch[]> {
  const batches: Batch[] = [];
  for (const plan of plans) {
    if (deps.stopped?.()) break;
    batches.push(await runBatch(plan, 1, deps));
  }
  if (deps.rerunFlagged) {
    for (const plan of plans) {
      if (deps.stopped?.()) break;
      const first = batches.find(b => b.cell === plan.cell && b.op === plan.op);
      if (!first?.verdict.high) continue;
      const { below } = await waitForLoad(deps);
      if (!below) {
        deps.log(`${first.id}: not rerun, the load or memory pressure is still over the limit`);
        continue;
      }
      batches.push(await runBatch(plan, 2, deps));
    }
  }
  markSuperseded(batches);
  return batches;
}
