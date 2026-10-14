export interface Summary {
  n: number;
  median: number;
  p90: number;
  min: number;
  max: number;
  mean: number;
  /** Samples above Q3 + 3 × IQR (Tukey's far-out fence). They stay in every other figure. */
  outliers: number[];
}

export const OUTLIER_IQR_MULTIPLE = 3;

/** The p-quantile (0 ≤ p ≤ 1) by linear interpolation between the closest ranks (Hyndman and Fan type 7, numpy's default). */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('no values');
  if (!(p >= 0 && p <= 1)) throw new Error(`${String(p)} is not a quantile`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (rank - low);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const fence = q3 + OUTLIER_IQR_MULTIPLE * (q3 - q1);
  return {
    n: values.length,
    median: median(values),
    p90: quantile(values, 0.9),
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    outliers: values.filter(v => v > fence),
  };
}

export type Pressure = 'normal' | 'warn' | 'critical' | 'unknown';

export interface LoadSample {
  at: string;
  /** os.loadavg(): 1, 5 and 15 minutes. */
  loadavg: [number, number, number];
  pressure: Pressure;
  memoryFreePercent: number | null;
  swapUsedMb: number | null;
}

export interface LoadVerdict {
  high: boolean;
  reasons: string[];
}

/**
 * A batch counts as run under high load when the 1-minute load average at its start or its end reached the limit, or
 * the kernel reported memory pressure above normal at either end. A batch that boots simulators itself raises the load
 * it ends with, so for it only the start load counts.
 */
export function judgeLoad(start: LoadSample, end: LoadSample, maxLoad: number, selfLoading = false): LoadVerdict {
  const reasons: string[] = [];
  for (const [when, sample] of [
    ['start', start],
    ['end', end],
  ] as const) {
    const load1 = sample.loadavg[0];
    if (load1 >= maxLoad && !(selfLoading && when === 'end'))
      reasons.push(`1-min load ${load1.toFixed(1)} at the ${when} (limit ${maxLoad.toFixed(1)})`);
    if (sample.pressure === 'warn' || sample.pressure === 'critical')
      reasons.push(`memory pressure ${sample.pressure} at the ${when}`);
  }
  return { high: reasons.length > 0, reasons };
}

/** The agreement check between two runs: |b − a| / a for each median, as a fraction. */
export function relativeDifference(a: number, b: number): number {
  if (a === 0) return b === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(b - a) / a;
}
