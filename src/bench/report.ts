import fs from 'node:fs';
import path from 'node:path';
import { CELLS, OPS, type Batch, type BenchResult, type Cell, type Op } from './model.ts';
import { median, relativeDifference, type LoadSample } from './stats.ts';

const s = (ms: number) => (ms / 1000).toFixed(3);

function loadText(sample: LoadSample): string {
  return sample.loadavg.map(x => x.toFixed(1)).join(' ');
}

function memoryText(sample: LoadSample): string {
  const free = sample.memoryFreePercent === null ? '?' : `${String(sample.memoryFreePercent)}% free`;
  const swap = sample.swapUsedMb === null ? '' : `, swap ${(sample.swapUsedMb / 1024).toFixed(1)} GB`;
  return `${sample.pressure}, ${free}${swap}`;
}

export function reportStem(startedAt: string): string {
  return `bench-${startedAt.replace(/:/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

function cellOrder(b: Batch): number {
  return CELLS.indexOf(b.cell) * 100 + OPS.indexOf(b.op) * 10 + b.attempt;
}

function row(b: Batch): string[] {
  const flag = b.aborted ? `aborted: ${b.aborted}` : b.verdict.high ? `HIGH LOAD: ${b.verdict.reasons.join('; ')}` : '';
  return b.series.map(series => {
    const sum = series.summary;
    const outliers = sum && sum.outliers.length > 0 ? sum.outliers.map(s).join(', ') : '';
    return [
      b.cell,
      b.op,
      series.sim,
      sum ? String(sum.n) : '0',
      sum ? s(sum.median) : '-',
      sum ? s(sum.p90) : '-',
      sum ? `${s(sum.min)}–${s(sum.max)}` : '-',
      String(series.failures),
      outliers,
      `${b.load.start.loadavg[0].toFixed(1)} → ${b.load.end.loadavg[0].toFixed(1)}`,
      flag,
    ].join(' | ');
  });
}

function table(batches: readonly Batch[]): string[] {
  return [
    '| cell | op | sim | n | median s | p90 s | min–max s | failed | outliers s | load 1-min start → end | flag |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...[...batches].sort((a, b) => cellOrder(a) - cellOrder(b)).flatMap(b => row(b).map(r => `| ${r} |`)),
  ];
}

function phaseMedians(b: Batch): string {
  const keys = new Set<string>();
  const samples = b.series.flatMap(x => x.samples.filter(sample => sample.ok));
  for (const sample of samples) for (const key of Object.keys(sample.phases)) keys.add(key);
  const parts: string[] = [];
  for (const key of keys) {
    const values = samples.map(sample => sample.phases[key]).filter((v): v is number => v !== undefined);
    if (values.length === 0) continue;
    parts.push(`${key} ${s(median(values))}`);
  }
  const gates = samples.reduce((sum, sample) => sum + sample.gateReads, 0);
  return `${parts.join(', ')}${gates > 0 ? `; ${String(gates)} gate reads over ${String(samples.length)} samples` : ''}`;
}

export function renderMarkdown(result: BenchResult, jsonName: string): string {
  const chosen = result.batches.filter(b => !b.superseded);
  const replaced = result.batches.filter(b => b.superseded);
  const flagged = chosen.filter(b => b.verdict.high);
  const { host, toolkit, maestro } = result;
  const lines = [
    `# agentlane bench, ${result.startedAt.slice(0, 10)}`,
    '',
    `Run ${result.startedAt} → ${result.finishedAt}. Raw timings: \`${jsonName}\`. Method: \`bench/README.md\` in the package.`,
    '',
    '## Conditions',
    '',
    '| | |',
    '|---|---|',
    `| Host | ${host.model}, ${host.chip}, ${String(host.cores)} cores, ${String(host.memoryGb)} GB |`,
    `| macOS | ${host.macos} |`,
    `| Xcode | ${host.xcode} |`,
    `| ${{ ios: 'Simulators', android: 'Emulators', web: 'Browsers' }[result.options.platform ?? 'ios']} | ${result.targets.map(t => `${t.sim}: ${t.deviceName} (${t.deviceType}, ${t.runtime}, ${t.udid})`).join('; ')} |`,
    `| Installed runtimes | ${host.runtimes.join(', ')} |`,
    `| Toolkit | ${toolkit.version}, commit ${toolkit.commit ?? 'unknown'}${toolkit.dirty ? ' (uncommitted changes)' : ''} |`,
    `| Maestro | ${maestro.version}${maestro.override ? ' (AGENTLANE_MAESTRO override)' : ''}, reports \`${maestro.reportedVersion ?? 'unknown'}\`; release zip sha256 ${maestro.releaseSha256}; CLI jar sha256 ${maestro.jarSha256 ?? 'unknown'} |`,
    `| Node | ${host.node} |`,
    `| Samples per cell | ${String(result.options.samples)}; load limit ${result.options.maxLoad.toFixed(1)} (1-min load average) |`,
    '',
    '## Summary',
    '',
    'Wall-clock seconds the caller waits, from the timer start the method names for each cell to the successful answer. Failed samples are excluded from the figures and counted.',
    '',
    ...table(chosen),
    '',
  ];
  lines.push('## Load and memory per batch', '');
  lines.push(
    '| batch | load start (1/5/15 min) | load end | memory start | memory end | waited for load s |',
    '|---|---|---|---|---|---|',
  );
  for (const b of [...chosen].sort((x, y) => cellOrder(x) - cellOrder(y))) {
    lines.push(
      `| ${b.id} | ${loadText(b.load.start)} | ${loadText(b.load.end)} | ${memoryText(b.load.start)} | ${memoryText(b.load.end)} | ${s(b.loadWaitMs)} |`,
    );
  }
  lines.push('', '## Phases (medians of successful samples)', '');
  for (const b of [...chosen].sort((x, y) => cellOrder(x) - cellOrder(y))) lines.push(`- ${b.id}: ${phaseMedians(b)}`);
  lines.push('');
  if (flagged.length > 0) {
    lines.push(
      '## Batches run under high load',
      '',
      "These ran with the load or memory pressure over the limit, and no rerun got under it. Treat their figures as upper bounds, not as the toolkit's speed.",
      '',
      ...flagged.map(b => `- ${b.id}: ${b.verdict.reasons.join('; ')}`),
      '',
    );
  }
  if (replaced.length > 0) {
    lines.push(
      '## Replaced attempts',
      '',
      'Earlier attempts a rerun replaced in the summary; their samples are in the JSON.',
      '',
      ...table(replaced),
      '',
    );
  }
  if (result.notes.length > 0) lines.push('## Notes', '', ...result.notes.map(n => `- ${n}`), '');
  return lines.join('\n');
}

export function writeReport(dir: string, result: BenchResult): { markdown: string; json: string } {
  fs.mkdirSync(dir, { recursive: true });
  const stem = reportStem(result.startedAt);
  const json = path.join(dir, `${stem}.json`);
  const markdown = path.join(dir, `${stem}.md`);
  fs.writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(markdown, renderMarkdown(result, path.basename(json)));
  return { markdown, json };
}

export interface Agreement {
  cell: Cell;
  op: Op;
  sim: string;
  a: number;
  b: number;
  difference: number;
  within: boolean;
  flagged: boolean;
}

/** Compares the medians of two runs, cell by cell, against a tolerance (0.2 is the plan's 20%). */
export function compareRuns(a: BenchResult, b: BenchResult, tolerance: number, cells: readonly Cell[] = ['warm']): Agreement[] {
  const out: Agreement[] = [];
  const pick = (r: BenchResult, cell: Cell, op: Op) => r.batches.find(x => x.cell === cell && x.op === op && !x.superseded);
  for (const cell of cells) {
    for (const op of OPS) {
      const left = pick(a, cell, op);
      const right = pick(b, cell, op);
      if (!left || !right) continue;
      for (const series of left.series) {
        const other = right.series.find(x => x.sim === series.sim);
        if (!series.summary || !other?.summary) continue;
        const difference = relativeDifference(series.summary.median, other.summary.median);
        out.push({
          cell,
          op,
          sim: series.sim,
          a: series.summary.median,
          b: other.summary.median,
          difference,
          within: difference <= tolerance,
          flagged: left.verdict.high || right.verdict.high,
        });
      }
    }
  }
  return out;
}

export function renderAgreement(rows: readonly Agreement[], a: BenchResult, b: BenchResult, tolerance: number): string {
  const hours = (Date.parse(b.startedAt) - Date.parse(a.startedAt)) / 3_600_000;
  const lines = [
    `Run A ${a.startedAt} (commit ${a.toolkit.commit ?? '?'}), run B ${b.startedAt} (commit ${b.toolkit.commit ?? '?'}): ${hours.toFixed(1)} h apart.`,
    '',
    `| cell | op | sim | A median s | B median s | difference | within ${String(Math.round(tolerance * 100))}% |`,
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      r =>
        `| ${r.cell} | ${r.op} | ${r.sim} | ${s(r.a)} | ${s(r.b)} | ${(r.difference * 100).toFixed(1)}% | ${r.within ? 'yes' : 'NO'}${r.flagged ? ' (high load in a run)' : ''} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
