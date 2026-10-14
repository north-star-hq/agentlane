import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeLoad, median, quantile, relativeDifference, summarize, type LoadSample } from '../../src/bench/stats.ts';
import { parseFreePercent, parseSwapUsedMb } from '../../src/bench/host.ts';

function load(load1: number, pressure: LoadSample['pressure'] = 'normal'): LoadSample {
  return { at: '2026-10-12T09:00:00.000Z', loadavg: [load1, load1, load1], pressure, memoryFreePercent: 70, swapUsedMb: 0 };
}

test('the median of an odd count is the middle value, of an even count the mean of the middle two', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
});

test('p90 interpolates between the closest ranks', () => {
  const values = Array.from({ length: 16 }, (_, i) => (i + 1) * 100);
  assert.equal(quantile(values, 0.9), 1450);
  assert.equal(quantile(values, 0), 100);
  assert.equal(quantile(values, 1), 1600);
  assert.equal(quantile([10, 20], 0.9), 19);
});

test('quantile refuses no values and a p outside 0..1', () => {
  assert.throws(() => quantile([], 0.5), /no values/);
  assert.throws(() => quantile([1], 1.5), /not a quantile/);
});

test('summarize gives n, median, p90, min, max and mean, and nothing for no samples', () => {
  const s = summarize([120, 140, 130, 150, 110]);
  assert.ok(s);
  assert.deepEqual(
    { n: s.n, median: s.median, min: s.min, max: s.max, mean: s.mean },
    { n: 5, median: 130, min: 110, max: 150, mean: 130 },
  );
  assert.equal(Math.round(s.p90), 146);
  assert.deepEqual(s.outliers, []);
  assert.equal(summarize([]), null);
});

test('a far-out sample is flagged as an outlier and still counted in the figures', () => {
  const values = [140, 141, 139, 142, 140, 138, 141, 140, 139, 142, 140, 141, 139, 140, 141, 900];
  const s = summarize(values);
  assert.ok(s);
  assert.deepEqual(s.outliers, [900]);
  assert.equal(s.n, 16);
  assert.equal(s.max, 900);
  assert.equal(s.median, 140);
});

test('a batch is flagged when the 1-minute load reaches the limit at its start or end', () => {
  assert.deepEqual(judgeLoad(load(4), load(5), 16), { high: false, reasons: [] });
  const atStart = judgeLoad(load(16), load(3), 16);
  assert.equal(atStart.high, true);
  assert.match(atStart.reasons.join(), /1-min load 16\.0 at the start \(limit 16\.0\)/);
  const atEnd = judgeLoad(load(3), load(40.25), 16);
  assert.equal(atEnd.high, true);
  assert.match(atEnd.reasons.join(), /40\.3 at the end/);
});

test('a batch that boots simulators is judged on its start load, since its own boots raise the end load', () => {
  assert.equal(judgeLoad(load(5), load(75), 16, true).high, false);
  assert.match(judgeLoad(load(20), load(75), 16, true).reasons.join(), /^1-min load 20\.0 at the start/);
  assert.equal(judgeLoad(load(5), load(5, 'critical'), 16, true).high, true);
});

test('a batch is flagged under memory pressure even when the load is low', () => {
  const verdict = judgeLoad(load(2, 'warn'), load(2, 'critical'), 16);
  assert.equal(verdict.high, true);
  assert.deepEqual(verdict.reasons, ['memory pressure warn at the start', 'memory pressure critical at the end']);
  assert.equal(judgeLoad(load(2, 'unknown'), load(2), 16).high, false);
});

test('relative difference is measured against the first run', () => {
  assert.equal(relativeDifference(100, 120), 0.2);
  assert.equal(relativeDifference(100, 80), 0.2);
  assert.equal(relativeDifference(0, 0), 0);
  assert.equal(relativeDifference(0, 1), Number.POSITIVE_INFINITY);
});

test('memory figures parse from memory_pressure -Q and vm.swapusage', () => {
  assert.equal(parseFreePercent('The system has ...\nSystem-wide memory free percentage: 78%\n'), 78);
  assert.equal(parseFreePercent(null), null);
  assert.equal(parseSwapUsedMb('total = 19456.00M  used = 18138.94M  free = 1317.06M  (encrypted)'), 18138.94);
  assert.equal(parseSwapUsedMb('garbage'), null);
});
