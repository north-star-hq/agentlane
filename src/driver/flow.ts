import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, stringify } from 'yaml';

export interface FlowStep {
  index: number;
  command: string;
  body: unknown;
  source: string;
  startLine: number;
  endLine: number;
}

export interface Flow {
  appId: string | undefined;
  config: Record<string, unknown> | undefined;
  steps: FlowStep[];
  error: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandName(body: unknown): string {
  if (typeof body === 'string') return body;
  if (isRecord(body)) return Object.keys(body)[0] ?? '';
  return '';
}

function stepsByLine(source: string): FlowStep[] {
  const lines = source.split('\n');
  const separator = lines.findLastIndex(line => /^---\s*$/.test(line));
  const steps: FlowStep[] = [];
  for (let i = separator + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!/^-(\s|$)/.test(line)) continue;
    const previous = steps.at(-1);
    if (previous) previous.endLine = i;
    const command = /^-\s*([A-Za-z]+)/.exec(line)?.[1] ?? '';
    steps.push({ index: steps.length, command, body: undefined, source: line, startLine: i + 1, endLine: i + 1 });
  }
  const last = steps.at(-1);
  if (last) last.endLine = lines.length;
  for (const step of steps)
    step.source = lines
      .slice(step.startLine - 1, step.endLine)
      .join('\n')
      .trimEnd();
  return steps;
}

/**
 * Splits Maestro flow YAML into its config header and its steps, with each step's line range in the source.
 * A flow with only a command list (no `---`) has no config. YAML that doesn't parse still yields steps, found by
 * their top-level `-` lines, so an error's line number can name the step.
 */
export function parseFlow(source: string): Flow {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(source, { lineCounter });
  const list = Array.isArray(docs) ? docs : [docs];
  const commandsDoc = list.at(-1);
  const configDoc = list.length > 1 ? list[0] : undefined;
  const config = configDoc?.toJS() as unknown;
  const appId = isRecord(config) && typeof config.appId === 'string' ? config.appId : undefined;
  const errors = list.flatMap(doc => doc.errors.map(error => error.message));
  if (errors.length > 0 || !commandsDoc || !isSeq(commandsDoc.contents)) {
    return {
      appId,
      config: isRecord(config) ? config : undefined,
      steps: stepsByLine(source),
      error: errors[0] ?? 'The flow has no list of commands.',
    };
  }
  const steps = commandsDoc.contents.items.map((item, index): FlowStep => {
    const range = isScalar(item) || isMap(item) || isSeq(item) ? item.range : undefined;
    const body: unknown = isScalar(item) || isMap(item) || isSeq(item) ? item.toJSON() : item;
    const startLine = range ? lineCounter.linePos(range[0]).line : 0;
    const endLine = range ? lineCounter.linePos(Math.max(range[0], range[1] - 1)).line : 0;
    return { index, command: commandName(body), body, source: stringify([body]).trimEnd(), startLine, endLine };
  });
  return { appId, config: isRecord(config) ? config : undefined, steps, error: undefined };
}

export function stepAtLine(flow: Flow, line: number): FlowStep | undefined {
  return (
    flow.steps.find(step => step.startLine <= line && line <= step.endLine) ?? flow.steps.findLast(step => step.startLine <= line)
  );
}

export interface RecordedRun {
  yaml: string;
  /** How many of the run's steps passed; every step when omitted. */
  passed?: number;
}

export interface Recording {
  appId: string;
  steps: unknown[];
  flow: string;
}

/** Writes the passing steps of a session's runs as one Maestro flow file that runs under `maestro test`. */
export function writeFlow(runs: RecordedRun[], appId?: string): Recording {
  const steps: unknown[] = [];
  let flowAppId = appId;
  let config: Record<string, unknown> | undefined;
  for (const run of runs) {
    const flow = parseFlow(run.yaml);
    if (flow.error !== undefined) throw new Error(`A recorded run is not valid flow YAML: ${flow.error}`);
    if (flow.appId !== undefined) {
      if (flowAppId !== undefined && flowAppId !== flow.appId) {
        throw new Error(`Recorded runs name two apps, ${flowAppId} and ${flow.appId}; a flow file has one appId.`);
      }
      flowAppId = flow.appId;
      config ??= flow.config;
    }
    steps.push(...flow.steps.slice(0, run.passed ?? flow.steps.length).map(step => step.body));
  }
  if (flowAppId === undefined) throw new Error('No recorded run names an appId, and none was given.');
  if (steps.length === 0) throw new Error('There are no passing steps to record.');
  const header = { appId: flowAppId, ...config };
  return { appId: flowAppId, steps, flow: `${stringify(header)}---\n${stringify(steps)}` };
}
