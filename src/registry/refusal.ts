export const REFUSAL_CODES = [
  'pool-busy',
  'ports-exhausted',
  'held-by-live-owner',
  'owner-unknown',
  'lane-gone',
  'token-mismatch',
  'registry-busy',
  'resource-busy',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Holder {
  who: string;
  folder: string;
  since: string;
  detail?: string;
}

function formatRefusal(summary: string, holders: readonly Holder[], recovery: readonly string[]): string {
  const lines = [summary];
  for (const h of holders) {
    lines.push(`  held by ${h.who} in ${h.folder}, since ${h.since}${h.detail ? `; ${h.detail}` : ''}`);
  }
  lines.push('to recover:');
  for (const r of recovery) lines.push(`  ${r}`);
  return lines.join('\n');
}

export class Refusal extends Error {
  readonly code: RefusalCode;
  readonly summary: string;
  readonly holders: readonly Holder[];
  readonly recovery: readonly string[];

  constructor(code: RefusalCode, summary: string, holders: readonly Holder[], recovery: readonly string[]) {
    if (holders.length === 0 || recovery.length === 0) {
      throw new Error(`refusal '${code}' was raised without a holder or a recovery command`);
    }
    super(formatRefusal(summary, holders, recovery));
    this.name = 'Refusal';
    this.code = code;
    this.summary = summary;
    this.holders = holders;
    this.recovery = recovery;
  }
}

export class UsageError extends Error {
  readonly fix: string;

  constructor(problem: string, fix: string) {
    super(`${problem}\nto fix: ${fix}`);
    this.name = 'UsageError';
    this.fix = fix;
  }
}

export class NotClaimed extends Error {
  readonly recovery: string;

  constructor(problem: string, recovery: string) {
    super(`${problem}\nto recover: ${recovery}`);
    this.name = 'NotClaimed';
    this.recovery = recovery;
  }
}
