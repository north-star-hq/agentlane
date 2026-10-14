import { stringify } from 'yaml';
import { parseFlow, type Flow, type FlowStep } from './flow.ts';
import { selectorsOfStep, type Selector } from './selector.ts';

export interface PreparedFlow {
  source: string;
  flow: Flow;
  appId: string | undefined;
  headerAdded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Gives a bare command list the `appId` header Maestro requires, from the caller or the session's last flow. */
export function prepareFlow(yaml: string, appId: string | undefined): PreparedFlow {
  const flow = parseFlow(yaml);
  if (flow.error !== undefined || flow.config !== undefined || appId === undefined) {
    return { source: yaml, flow, appId: flow.appId, headerAdded: false };
  }
  const source = `${stringify({ appId })}---\n${yaml}`;
  return { source, flow: parseFlow(source), appId, headerAdded: true };
}

function headerOf(flow: Flow): string {
  return `${stringify(flow.config ?? {})}---\n`;
}

const QUICK_COMMANDS = new Set(['tapOn', 'doubleTapOn', 'longPressOn']);

/** A tap that neither waits for the screen to settle nor taps again when nothing seems to change. */
export function quickBody(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const [command] = Object.keys(body);
  if (command === undefined || !QUICK_COMMANDS.has(command)) return body;
  let target = body[command];
  if (typeof target === 'string') target = { text: target };
  if (!isRecord(target)) return body;
  return { [command]: { ...target, waitToSettleTimeoutMs: target.waitToSettleTimeoutMs ?? 0, retryTapIfNoChange: false } };
}

export function flowYaml(flow: Flow, steps: readonly FlowStep[], quick: boolean): string {
  return `${headerOf(flow)}${stringify(steps.map(step => (quick ? quickBody(step.body) : step.body)))}`;
}

// Maestro keeps script outputs, copied text, recordings and loop state inside one `run` call, so only commands that
// use none of them behave the same when each runs in a call of its own.
const STATELESS_COMMANDS = new Set([
  'addMedia',
  'assertNotVisible',
  'assertVisible',
  'back',
  'clearKeychain',
  'clearState',
  'doubleTapOn',
  'eraseText',
  'extendedWaitUntil',
  'hideKeyboard',
  'inputRandomEmail',
  'inputRandomNumber',
  'inputRandomPersonName',
  'inputRandomText',
  'inputText',
  'killApp',
  'launchApp',
  'longPressOn',
  'openLink',
  'pressKey',
  'scroll',
  'scrollUntilVisible',
  'setAirplaneMode',
  'setLocation',
  'setOrientation',
  'setPermissions',
  'stopApp',
  'swipe',
  'takeScreenshot',
  'tapOn',
  'toggleAirplaneMode',
  'waitForAnimationToEnd',
]);

/** Whether the flow can run one step per Maestro call, so a failure names its step and absence checks read the screen. */
export function splittable(flow: Flow): boolean {
  if (flow.error !== undefined || flow.steps.length < 2) return false;
  const config = flow.config ?? {};
  if ('onFlowStart' in config || 'onFlowComplete' in config) return false;
  return flow.steps.every(step => STATELESS_COMMANDS.has(step.command) && !/\boutput\.|copiedText/.test(step.source));
}

export function absenceSelectors(step: FlowStep): Selector[] {
  return selectorsOfStep(step)
    .filter(entry => entry.expect === 'absent')
    .map(entry => entry.selector);
}

const READ_ONLY_COMMANDS = new Set([
  'assertVisible',
  'assertNotVisible',
  'assertTrue',
  'extendedWaitUntil',
  'takeScreenshot',
  'waitForAnimationToEnd',
]);

/**
 * The absence steps of a flow run in one Maestro call whose screen is still the one after the flow: those followed only
 * by steps that read the screen. An earlier absence step was judged on a screen that is gone.
 */
export function finalAbsenceSteps(steps: readonly FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const step of steps.toReversed()) {
    if (!READ_ONLY_COMMANDS.has(step.command)) break;
    if (absenceSelectors(step).length > 0) out.unshift(step);
  }
  return out;
}
