import { parseFlow, stepAtLine, type FlowStep } from './flow.ts';
import { look, type LookOptions, type LookResult } from './look.ts';
import { selectorsOfStep, type Selector, selectorYaml } from './selector.ts';
import { suggestSelectors, type Suggestion } from './suggest.ts';
import type { ScreenRead } from './tree.ts';

export type FailureKind = 'invalid-flow' | 'selector-miss' | 'assertion' | 'timeout' | 'device-error' | 'unknown';
export type ReachedDevice = 'yes' | 'no' | 'unknown';

export interface RunFailure {
  kind: FailureKind;
  message: string;
  step: { index: number; total: number; command: string; yaml: string } | undefined;
  /** Steps before the failing one, all of which ran. Undefined when the failing step isn't known. */
  completedSteps: number | undefined;
  /** Whether the failing step's own action reached the device. */
  reachedDevice: ReachedDevice;
  reachedDeviceBecause: string;
  selector: Selector | undefined;
  screen: LookResult | undefined;
  suggestions: Suggestion[];
}

export interface FailureInput {
  /** The flow YAML that was run. */
  flow: string;
  /** Maestro's error text, as the `run` tool or `maestro test` returned it. */
  error: string;
  /** A read taken after the failure. */
  screen?: ScreenRead;
  /** The failing step's index, when the caller ran the flow step by step and knows it. */
  failedStep?: number;
  look?: LookOptions;
}

const PREFIXES = [/^Failed to run flow:\s*/, /^kotlin\.Unit\s+/, /^java\.lang\.IllegalStateException:\s*/];

export function cleanMessage(error: string): string {
  let message = error.trim();
  for (const prefix of PREFIXES) message = message.replace(prefix, '');
  return message;
}

const FILE_POSITION = /\.ya?ml:(\d+):(\d+)/;
const INVALID_FLOW =
  /^(Parsing Failed|Invalid Command|Config Section Required|Incorrect Format|Unknown Property|Missing required)/;
const DEVICE_ERROR = /An error was encountered processing the command|Simulator device failed to/;

function kindOf(message: string): FailureKind {
  if (INVALID_FLOW.test(message) || (FILE_POSITION.test(message) && !message.startsWith('Element not found')))
    return 'invalid-flow';
  if (message.startsWith('Element not found:')) return 'selector-miss';
  if (message.startsWith('Assertion is false:')) return 'assertion';
  if (DEVICE_ERROR.test(message)) return 'device-error';
  return 'unknown';
}

function selectorFromMessage(message: string): Selector | undefined {
  const notFound = /^Element not found: (.*)$/s.exec(message)?.[1];
  if (notFound !== undefined) {
    const selector: Selector = {};
    const index = /, Index: (\d+)$/.exec(notFound);
    const body = index ? notFound.slice(0, index.index) : notFound;
    if (index?.[1] !== undefined) selector.index = Number(index[1]);
    const id = /(?:^|, )Id matching regex: (.*?)(?=, Text matching regex: |$)/s.exec(body)?.[1];
    const text = /(?:^|, )Text matching regex: (.*?)(?=, Id matching regex: |$)/s.exec(body)?.[1];
    if (id !== undefined) selector.id = id;
    if (text !== undefined) selector.text = text;
    return selector.id !== undefined || selector.text !== undefined ? selector : undefined;
  }
  const asserted = /^Assertion is false: "(.*?)"(?:, id: (.*?))? is (?:not )?visible$/s.exec(message);
  if (asserted) {
    const selector: Selector = { text: asserted[1] ?? '' };
    if (asserted[2] !== undefined) selector.id = asserted[2];
    return selector;
  }
  const idOnly = /^Assertion is false: id: (.*?) is (?:not )?visible$/s.exec(message)?.[1];
  return idOnly === undefined ? undefined : { id: idOnly };
}

function sameSelector(a: Selector, b: Selector): boolean {
  return a.id === b.id && a.text === b.text;
}

function locateStep(steps: FlowStep[], kind: FailureKind, message: string, selector: Selector | undefined): FlowStep | undefined {
  const position = FILE_POSITION.exec(message);
  if (kind === 'invalid-flow') return undefined;
  if (position) return undefined;
  let candidates: FlowStep[] = [];
  if (selector) {
    candidates = steps.filter(step => selectorsOfStep(step).some(entry => sameSelector(entry.selector, selector)));
    if (kind === 'assertion') {
      const absent = message.endsWith(' is not visible');
      candidates = candidates.filter(step =>
        selectorsOfStep(step).some(entry => sameSelector(entry.selector, selector) && (entry.expect === 'absent') === absent),
      );
    }
  } else if (message.startsWith('Assertion is false:')) {
    candidates = steps.filter(step => step.command === 'assertTrue');
  } else if (kind === 'device-error') {
    const launch = message.includes('failed to launch') ? ['launchApp'] : message.includes('failed to open') ? ['openLink'] : [];
    candidates = steps.filter(step => launch.includes(step.command));
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

const REACHED: Record<FailureKind, [ReachedDevice, string]> = {
  'invalid-flow': ['no', 'Maestro rejects a flow it cannot parse before running any step.'],
  'selector-miss': ['no', 'Maestro looks the element up before acting, and it never found one.'],
  assertion: ['no', 'An assertion only reads the screen.'],
  timeout: ['no', 'A wait only reads the screen.'],
  'device-error': ['yes', 'The simulator received the command and refused it.'],
  unknown: ['unknown', "Maestro's error doesn't say how far the step got."],
};

/** Turns a failed `run` into a structured failure: kind, failing step, reached-device, fresh screen, suggestions. */
export function buildFailure(input: FailureInput): RunFailure {
  const message = cleanMessage(input.error);
  const flow = parseFlow(input.flow);
  let kind = kindOf(message);
  if (kind === 'unknown' && flow.error !== undefined) kind = 'invalid-flow';

  let selector = selectorFromMessage(message);
  let step: FlowStep | undefined;
  if (input.failedStep !== undefined) {
    step = flow.steps[input.failedStep];
  } else if (kind === 'invalid-flow') {
    const line = FILE_POSITION.exec(message)?.[1];
    if (line !== undefined && Number(line) > 0) {
      const found = stepAtLine(flow, Number(line));
      if (found && Number(line) >= found.startLine) step = found;
    }
  } else {
    step = locateStep(flow.steps, kind, message, selector);
  }
  if (!step && flow.steps.length === 1 && input.failedStep === undefined) step = flow.steps[0];
  if (kind === 'assertion' && step?.command === 'extendedWaitUntil') kind = 'timeout';
  if (step && !selector && kind !== 'invalid-flow') {
    selector = selectorsOfStep(step)[0]?.selector;
  }

  const [reachedDevice, reachedDeviceBecause] = REACHED[kind];
  const missed =
    (kind === 'selector-miss' || kind === 'timeout' || (kind === 'assertion' && !message.endsWith(' is not visible'))) &&
    selector;
  const screen = input.screen ? look(input.screen, input.look) : undefined;
  return {
    kind,
    message,
    step: step && {
      index: step.index,
      total: flow.steps.length,
      command: step.command,
      yaml: step.source,
    },
    completedSteps: kind === 'invalid-flow' ? 0 : step?.index,
    reachedDevice,
    reachedDeviceBecause,
    selector,
    screen,
    suggestions: missed && input.screen ? suggestSelectors(input.screen, missed) : [],
  };
}

export function renderFailure(failure: RunFailure): string {
  const lines: string[] = [];
  const where = failure.step
    ? `step ${String(failure.step.index + 1)} of ${String(failure.step.total)} (${failure.step.yaml.replace(/^- /, '').replaceAll('\n', ' ').replace(/\s+/g, ' ')})`
    : 'an unknown step';
  lines.push(`Run failed (${failure.kind}) at ${where}: ${failure.message}`);
  const ran =
    failure.completedSteps === undefined
      ? 'Earlier steps may have run.'
      : `${String(failure.completedSteps)} earlier step${failure.completedSteps === 1 ? '' : 's'} ran.`;
  lines.push(`Reached the device: ${failure.reachedDevice}. ${failure.reachedDeviceBecause} ${ran}`);
  if (failure.suggestions.length > 0) {
    lines.push(`Selectors on screen like ${failure.selector ? selectorYaml(failure.selector) : 'the missed one'}:`);
    for (const suggestion of failure.suggestions) {
      lines.push(`  ${suggestion.yaml}  ${suggestion.element}  (${suggestion.basis})`);
    }
  }
  if (failure.screen) lines.push('Screen now:', failure.screen.text);
  return lines.join('\n');
}
