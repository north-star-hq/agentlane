import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Batch, BenchResult, Cell, Op } from '../../src/bench/model.ts';
import { compareRuns, renderAgreement, renderMarkdown, reportStem, writeReport } from '../../src/bench/report.ts';
import { summarize, type LoadSample } from '../../src/bench/stats.ts';
import { tempDir } from '../support/fakes.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');

function load(load1: number): LoadSample {
  return { at: '2026-10-12T09:00:00.000Z', loadavg: [load1, 2, 3], pressure: 'normal', memoryFreePercent: 71, swapUsedMb: 2048 };
}

function batch(cell: Cell, op: Op, medians: Record<string, number[]>, extra: Partial<Batch> = {}): Batch {
  return {
    id: `${cell}/${op}#1`,
    cell,
    op,
    attempt: 1,
    startedAt: '2026-10-12T09:00:00.000Z',
    finishedAt: '2026-10-12T09:01:00.000Z',
    loadWaitMs: 0,
    load: { start: load(4), end: load(5) },
    verdict: { high: false, reasons: [] },
    superseded: false,
    series: Object.entries(medians).map(([sim, values]) => ({
      sim,
      samples: values.map(ms => ({ ms, ok: true, startedAt: 'x', phases: { op: ms }, gateReads: 0 })),
      summary: summarize(values),
      failures: 0,
    })),
    ...extra,
  };
}

function result(batches: Batch[], startedAt = '2026-10-12T09:00:00.123Z'): BenchResult {
  return {
    schema: 'agentlane-bench/1',
    startedAt,
    finishedAt: '2026-10-12T10:00:00.000Z',
    command: 'agentlane bench',
    options: { samples: 16, cells: ['warm'], ops: ['read'], maxLoad: 16, loadWaitMs: 300_000, rerunFlagged: true },
    host: {
      model: 'Mac16,5',
      chip: 'Apple M4 Max',
      cores: 16,
      memoryGb: 48,
      macos: '26.2 (25C56)',
      xcode: 'Xcode 26.6, Build version 17F113',
      runtimes: ['iOS 26.5 (23F77)'],
      node: 'v24.21.0',
    },
    toolkit: { version: '0.0.0', commit: 'abc123', dirty: false },
    maestro: {
      version: '2.11.0-agentenv.1',
      binary: '/x/bin/maestro',
      override: false,
      releaseSha256: '30f0',
      binarySha256: 'b1',
      jarSha256: 'j1',
      reportedVersion: '2.11.0-agentenv.1',
    },
    targets: [
      {
        sim: 'A',
        folder: '/w',
        lane: 'c1',
        udid: 'U1',
        deviceName: 'agentlane-pool-1',
        deviceType: 'iPhone 17',
        runtime: 'iOS 26.5',
        metroPort: 41100,
        apiPort: 41200,
      },
    ],
    batches,
    notes: ['One simulator only.'],
  };
}

test('the report names the conditions and shows each batch with its median, p90 and load', () => {
  const md = renderMarkdown(result([batch('warm', 'read', { A: [140, 150, 160], B: [130, 140, 150] })]), 'bench-x.json');
  assert.match(md, /^# agentlane bench, 2026-10-12/);
  assert.match(md, /\| Host \| Mac16,5, Apple M4 Max, 16 cores, 48 GB \|/);
  assert.match(md, /\| Xcode \| Xcode 26\.6, Build version 17F113 \|/);
  assert.match(md, /commit abc123/);
  assert.match(md, /release zip sha256 30f0; CLI jar sha256 j1/);
  assert.match(md, /\| warm \| read \| A \| 3 \| 0\.150 \| 0\.158 \| 0\.140–0\.160 \| 0 \| {2}\| 4\.0 → 5\.0 \| {2}\|/);
  assert.match(md, /\| warm \| read \| B \| 3 \| 0\.140 \|/);
  assert.match(md, /\| warm\/read#1 \| 4\.0 2\.0 3\.0 \| 5\.0 2\.0 3\.0 \| normal, 71% free, swap 2\.0 GB \|/);
  assert.match(md, /- One simulator only\./);
  assert.doesNotMatch(md, /Batches run under high load/);
});

test('a batch under high load is flagged in the table and listed, never mixed in silently', () => {
  const flagged = batch(
    'cold',
    'tap',
    { A: [5000] },
    { verdict: { high: true, reasons: ['1-min load 40.0 at the start (limit 16.0)'] } },
  );
  const md = renderMarkdown(result([flagged]), 'bench-x.json');
  assert.match(md, /\| cold \| tap \| A \| 1 \|.*\| HIGH LOAD: 1-min load 40\.0 at the start \(limit 16\.0\) \|/);
  assert.match(md, /## Batches run under high load[\s\S]*- cold\/tap#1: 1-min load 40\.0/);
});

test('a replaced attempt leaves the summary and is listed on its own', () => {
  const old = batch('warm', 'read', { A: [900] }, { superseded: true, verdict: { high: true, reasons: ['busy'] } });
  const fresh = batch('warm', 'read', { A: [120] }, { id: 'warm/read#2', attempt: 2 });
  const md = renderMarkdown(result([old, fresh]), 'bench-x.json');
  const [summary = '', replaced = ''] = md.split('## Replaced attempts');
  assert.match(summary, /\| warm \| read \| A \| 1 \| 0\.120 \|/);
  assert.doesNotMatch(summary, /0\.900/);
  assert.match(replaced, /\| warm \| read \| A \| 1 \| 0\.900 \|/);
});

test('writeReport writes a dated Markdown file and the JSON next to it', () => {
  const dir = path.join(tempDir('bench-report'), 'out');
  const r = result([batch('warm', 'read', { A: [100, 110] })]);
  const files = writeReport(dir, r);
  assert.equal(reportStem(r.startedAt), 'bench-2026-10-12T090000Z');
  assert.equal(files.markdown, path.join(dir, 'bench-2026-10-12T090000Z.md'));
  assert.equal(files.json, path.join(dir, 'bench-2026-10-12T090000Z.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), r);
  assert.match(fs.readFileSync(files.markdown, 'utf8'), /Raw timings: `bench-2026-10-12T090000Z\.json`/);
});

test('compareRuns checks each warm median against the tolerance', () => {
  const a = result([batch('warm', 'read', { A: [100], B: [100] }), batch('cold', 'read', { A: [5000] })]);
  const b = result(
    [batch('warm', 'read', { A: [115], B: [130] }), batch('cold', 'read', { A: [9000] })],
    '2026-10-13T09:30:00.000Z',
  );
  const rows = compareRuns(a, b, 0.2);
  assert.deepEqual(
    rows.map(r => [r.cell, r.sim, r.within]),
    [
      ['warm', 'A', true],
      ['warm', 'B', false],
    ],
  );
  const text = renderAgreement(rows, a, b, 0.2);
  assert.match(text, /24\.5 h apart/);
  assert.match(text, /\| warm \| read \| B \| 0\.100 \| 0\.130 \| 30\.0% \| NO \|/);
});

test('bench compare on the CLI exits 0 when the runs agree and 1 when they do not', () => {
  const dir = tempDir('bench-compare');
  const write = (name: string, r: BenchResult) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(r));
    return file;
  };
  const a = write('a.json', result([batch('warm', 'read', { A: [100] })]));
  const near = write('b.json', result([batch('warm', 'read', { A: [110] })]));
  const far = write('c.json', result([batch('warm', 'read', { A: [200] })]));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: path.join(dir, 'state') };
  const agree = spawnSync(process.execPath, [CLI, 'bench', 'compare', a, near], { encoding: 'utf8', env });
  assert.equal(agree.status, 0, agree.stderr);
  assert.match(agree.stdout, /10\.0% \| yes/);
  const disagree = spawnSync(process.execPath, [CLI, 'bench', 'compare', a, far], { encoding: 'utf8', env });
  assert.equal(disagree.status, 1);
  assert.match(disagree.stdout, /100\.0% \| NO/);
  const notResult = write('d.json', { schema: 'other' } as unknown as BenchResult);
  const refused = spawnSync(process.execPath, [CLI, 'bench', 'compare', a, notResult], { encoding: 'utf8', env });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /is not a bench result/);
});

test('bench refuses a folder that is not the example app, and bad options, before touching any simulator', () => {
  const dir = tempDir('bench-cli');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: path.join(dir, 'state') };
  const elsewhere = spawnSync(process.execPath, [CLI, 'bench', '--worktree', dir], { encoding: 'utf8', env });
  assert.equal(elsewhere.status, 2);
  assert.match(elsewhere.stderr, /no agentlane\.json in .* or above it/);
  const cells = spawnSync(process.execPath, [CLI, 'bench', '--cells', 'warm,lukewarm'], { encoding: 'utf8', env });
  assert.equal(cells.status, 2);
  assert.match(cells.stderr, /--cells warm,lukewarm names lukewarm/);
  const samples = spawnSync(process.execPath, [CLI, 'bench', '--samples', '2.5'], { encoding: 'utf8', env });
  assert.equal(samples.status, 2);
  assert.match(samples.stderr, /--samples 2\.5 is not a positive whole number/);
  assert.equal(fs.existsSync(env.AGENTLANE_STATE_DIR), false);
});

test('bench --platform web takes the warm cell with read, screenshot, click and flow, and refuses device cells and ops before claiming', () => {
  const dir = tempDir('bench-web-cli');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTLANE_STATE_DIR: path.join(dir, 'state') };
  const example = path.join(ROOT, 'examples', 'expo-app');
  const bench = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'bench', '--worktree', example, '--platform', 'web', ...args], { encoding: 'utf8', env });
  const cold = bench('--cells', 'warm,cold');
  assert.equal(cold.status, 2);
  assert.match(cold.stderr, /--platform web has no cold cell: a browser lane is measured warm/);
  const tap = bench('--ops', 'read,tap');
  assert.equal(tap.status, 2);
  assert.match(tap.stderr, /--platform web has no tap op/);
  const click = spawnSync(process.execPath, [CLI, 'bench', '--worktree', example, '--ops', 'click'], { encoding: 'utf8', env });
  assert.equal(click.status, 2);
  assert.match(click.stderr, /--platform ios has no click op/);
  assert.equal(fs.existsSync(env.AGENTLANE_STATE_DIR), false);
});
