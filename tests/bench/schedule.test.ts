import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clock } from '../../src/clock.ts';
import type { Cell, Op, Sample } from '../../src/bench/model.ts';
import { MAX_CONSECUTIVE_FAILURES, runBatches, type BatchPlan, type ScheduleDeps } from '../../src/bench/schedule.ts';
import type { LoadSample } from '../../src/bench/stats.ts';

class SteppingClock implements Clock {
  t = Date.UTC(2026, 9, 12, 9, 0, 0);
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    this.t += ms;
    return Promise.resolve();
  }
}

function loadAt(load1: number, pressure: LoadSample['pressure'] = 'normal'): LoadSample {
  return { at: 'x', loadavg: [load1, load1, load1], pressure, memoryFreePercent: 80, swapUsedMb: 0 };
}

function ok(ms: number): Sample {
  return { ms, ok: true, startedAt: 'x', phases: { op: ms }, gateReads: 0 };
}

function plan(
  cell: Cell,
  op: Op,
  sims: string[],
  sample: (sim: string, index: number) => Sample | Promise<Sample>,
): BatchPlan & { prepared: number } {
  const p = {
    cell,
    op,
    sims,
    prepared: 0,
    prepare: () => {
      p.prepared += 1;
      return Promise.resolve();
    },
    sample: (sim: string, index: number) => Promise.resolve(sample(sim, index)),
  };
  return p;
}

function deps(loads: () => number, overrides: Partial<ScheduleDeps> = {}): ScheduleDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    load: () => loadAt(loads()),
    clock: new SteppingClock(),
    log: line => lines.push(line),
    samples: 4,
    maxLoad: 16,
    loadWaitMs: 60_000,
    loadPollMs: 5000,
    rerunFlagged: true,
    lines,
    ...overrides,
  };
}

test('two simulators alternate within a batch, and each gets its own series and summary', async () => {
  const order: string[] = [];
  const p = plan('warm', 'read', ['A', 'B'], (sim, i) => {
    order.push(`${sim}${String(i)}`);
    return ok(sim === 'A' ? 100 + i : 200 + i);
  });
  const [batch] = await runBatches(
    [p],
    deps(() => 3),
  );
  assert.deepEqual(order, ['A0', 'B0', 'A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
  assert.equal(p.prepared, 1);
  assert.ok(batch);
  assert.equal(batch.verdict.high, false);
  assert.deepEqual(
    batch.series.map(s => [s.sim, s.summary?.n, s.summary?.median]),
    [
      ['A', 4, 101.5],
      ['B', 4, 201.5],
    ],
  );
});

test('a batch waits for the load to drop under the limit before it starts', async () => {
  const readings = [30, 30, 30, 4];
  const d = deps(() => readings.shift() ?? 4);
  const [batch] = await runBatches([plan('warm', 'read', ['A'], () => ok(100))], d);
  assert.ok(batch);
  assert.equal(batch.loadWaitMs, 15_000);
  assert.equal(batch.verdict.high, false);
  assert.match(d.lines.join('\n'), /load 30\.0 is at or above 16\.0; waiting up to 60 s/);
});

test('a batch also waits out memory pressure, and runs flagged when it never eases', async () => {
  const pressures: LoadSample['pressure'][] = ['warn', 'warn', 'normal'];
  const d = deps(() => 2);
  d.load = () => loadAt(2, pressures.shift() ?? 'normal');
  const [eased] = await runBatches([plan('warm', 'read', ['A'], () => ok(100))], d);
  assert.equal(eased?.loadWaitMs, 10_000);
  assert.equal(eased.verdict.high, false);
  assert.match(d.lines.join('\n'), /memory pressure is warn; waiting up to 60 s/);

  const stuck = deps(() => 2, { loadWaitMs: 10_000, rerunFlagged: false });
  stuck.load = () => loadAt(2, 'critical');
  const [pressed] = await runBatches([plan('warm', 'read', ['A'], () => ok(100))], stuck);
  assert.equal(pressed?.verdict.high, true);
  assert.deepEqual(pressed.verdict.reasons, ['memory pressure critical at the start', 'memory pressure critical at the end']);
});

test('a batch run under high load is flagged, rerun once when the load drops, and the rerun replaces it in the summary', async () => {
  let load = 40;
  let calls = 0;
  const p = plan('warm', 'read', ['A'], () => {
    calls += 1;
    if (calls === 4) load = 3;
    return ok(calls <= 4 ? 900 : 120);
  });
  const batches = await runBatches(
    [p],
    deps(() => load),
  );
  assert.equal(batches.length, 2);
  const [first, second] = batches;
  assert.ok(first && second);
  assert.equal(first.verdict.high, true);
  assert.match(first.verdict.reasons.join(), /1-min load 40\.0 at the start/);
  assert.equal(first.superseded, true);
  assert.equal(second.attempt, 2);
  assert.equal(second.verdict.high, false);
  assert.equal(second.superseded, false);
  assert.equal(second.series[0]?.summary?.median, 120);
});

test('a flagged batch whose load never drops keeps its flag, is not rerun, and stays in the summary', async () => {
  const d = deps(() => 50, { loadWaitMs: 10_000 });
  const batches = await runBatches([plan('cold', 'tap', ['A'], () => ok(5000))], d);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.verdict.high, true);
  assert.equal(batches[0].superseded, false);
  assert.match(d.lines.join('\n'), /not rerun, the load or memory pressure is still over the limit/);
});

test('with rerunFlagged off a flagged batch is reported as it ran', async () => {
  let load = 40;
  const batches = await runBatches(
    [
      plan('warm', 'read', ['A'], () => {
        load = 2;
        return ok(100);
      }),
    ],
    deps(() => load, { rerunFlagged: false, loadWaitMs: 0 }),
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.verdict.high, true);
});

test('failed samples are counted, kept out of the figures, and a run of failures aborts the batch', async () => {
  let i = 0;
  const p = plan('cold', 'read', ['A'], () => {
    i += 1;
    if (i === 2) return { ...ok(0), ok: false, error: 'flaky' };
    if (i >= 4) throw new Error('the driver is gone');
    return ok(100);
  });
  const [batch] = await runBatches(
    [p],
    deps(() => 1, { samples: 16 }),
  );
  assert.ok(batch);
  const series = batch.series[0];
  assert.ok(series);
  assert.equal(series.summary?.n, 2);
  assert.equal(series.failures, 1 + MAX_CONSECUTIVE_FAILURES);
  assert.match(batch.aborted ?? '', /3 samples in a row failed on A; last: the driver is gone/);
});

test('a failed preparation aborts the batch without samples', async () => {
  const p = plan('warm', 'tap', ['A'], () => ok(1));
  p.prepare = () => Promise.reject(new Error('no home screen'));
  const [batch] = await runBatches(
    [p],
    deps(() => 1),
  );
  assert.match(batch?.aborted ?? '', /preparing the batch failed: no home screen/);
  assert.equal(batch?.series[0]?.samples.length, 0);
});

test('a signal stops new samples and the batches that ran are kept', async () => {
  let stop = false;
  const p = plan('warm', 'read', ['A'], (_sim, index) => {
    if (index === 1) stop = true;
    return ok(100);
  });
  const batches = await runBatches(
    [p, plan('cold', 'read', ['A'], () => ok(1))],
    deps(() => 1, { stopped: () => stop }),
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.aborted, 'stopped by a signal');
  assert.equal(batches[0].series[0]?.samples.length, 2);
});
