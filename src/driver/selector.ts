import type { FlowStep } from './flow.ts';
import type { UiNode } from './tree.ts';

export interface Selector {
  id?: string;
  text?: string;
  index?: number;
}

const ELEMENT_COMMANDS = new Set([
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'assertVisible',
  'assertNotVisible',
  'copyTextFrom',
  'scrollUntilVisible',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectorFrom(value: unknown): Selector | undefined {
  if (typeof value === 'string') return { text: value };
  if (!isRecord(value)) return undefined;
  const selector: Selector = {};
  if (typeof value.id === 'string') selector.id = value.id;
  if (typeof value.text === 'string') selector.text = value.text;
  if (typeof value.index === 'number' || typeof value.index === 'string') selector.index = Number(value.index);
  return selector.id !== undefined || selector.text !== undefined ? selector : undefined;
}

export interface StepSelector {
  selector: Selector;
  expect: 'present' | 'absent';
}

/** The element selectors a Maestro step names, and whether the step wants the element present or absent. */
export function selectorsOfStep(step: Pick<FlowStep, 'command' | 'body'>): StepSelector[] {
  if (!isRecord(step.body)) return [];
  const argument = step.body[step.command];
  if (step.command === 'extendedWaitUntil' && isRecord(argument)) {
    const out: StepSelector[] = [];
    const visible = selectorFrom(argument.visible);
    if (visible) out.push({ selector: visible, expect: 'present' });
    const notVisible = selectorFrom(argument.notVisible);
    if (notVisible) out.push({ selector: notVisible, expect: 'absent' });
    return out;
  }
  if (!ELEMENT_COMMANDS.has(step.command)) return [];
  const target = step.command === 'scrollUntilVisible' && isRecord(argument) ? argument.element : argument;
  const selector = selectorFrom(target);
  if (!selector) return [];
  return [{ selector, expect: step.command === 'assertNotVisible' ? 'absent' : 'present' }];
}

function fullMatch(pattern: string, value: string): boolean {
  if (!value) return false;
  const stripped = value.replaceAll('\n', ' ');
  if (pattern === value || pattern === stripped) return true;
  let regex: RegExp;
  try {
    regex = new RegExp(`^(?:${pattern})$`, 'is');
  } catch {
    return false;
  }
  return regex.test(value) || regex.test(stripped);
}

/** Maestro's iOS matching: `id` against the identifier, `text` against the label, the text and the hint. */
export function matchesSelector(node: UiNode, selector: Selector): boolean {
  if (selector.id !== undefined) {
    const id = selector.id;
    if (!fullMatch(id, node.id) && !fullMatch(id, node.id.slice(node.id.lastIndexOf('/') + 1))) return false;
  }
  if (selector.text !== undefined) {
    const text = selector.text;
    if (![node.text, node.hint, node.label].some(value => fullMatch(text, value))) return false;
  }
  return selector.id !== undefined || selector.text !== undefined;
}

export function selectorYaml(selector: Selector): string {
  const parts: string[] = [];
  if (selector.id !== undefined) parts.push(`id: ${JSON.stringify(selector.id)}`);
  if (selector.text !== undefined) parts.push(`text: ${JSON.stringify(selector.text)}`);
  if (selector.index !== undefined) parts.push(`index: ${String(selector.index)}`);
  return `{ ${parts.join(', ')} }`;
}

export function escapeRegex(text: string): string {
  return text.replace(/[\\^$*+?()[\]{}|]/g, '\\$&');
}
