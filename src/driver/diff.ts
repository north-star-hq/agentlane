import { elementsOf, type Element } from './elements.ts';
import { describeElement } from './look.ts';
import type { ReadableScreen, Rect, ScreenRead, UiNode } from './tree.ts';

export interface Change {
  before: string;
  after: string;
  fields: string[];
}

export interface ScreenDiff {
  appeared: string[];
  disappeared: string[];
  changed: Change[];
  moved: number;
  ignored: string[];
  unreadable: string | undefined;
}

/** Elements seen changing between two reads taken with no action between them. */
export type VolatileSet = ReadonlySet<string>;

const TOGGLE_ROLES = new Set(['switch', 'checkbox', 'slider', 'stepper', 'picker', 'segmented', 'tab']);
const FLAGS = ['enabled', 'focused', 'selected', 'checked'] as const;
const TEXT_FIELDS = ['label', 'text', 'value', 'hint'] as const;
const NUMERIC_ONLY = /^[\d\s:.,%+\-−–/]+$/;
const ANCHOR_GRID = 8;

function center(rect: Rect | undefined): [number, number] {
  return rect ? [(rect.x1 + rect.x2) / 2, (rect.y1 + rect.y2) / 2] : [0, 0];
}

function distance(a: Element, b: Element): number {
  const [ax, ay] = center(a.node.bounds);
  const [bx, by] = center(b.node.bounds);
  return Math.hypot(ax - bx, ay - by);
}

function sameBounds(a: UiNode, b: UiNode): boolean {
  const x = a.bounds;
  const y = b.bounds;
  return x === undefined || y === undefined ? x === y : x.x1 === y.x1 && x.y1 === y.y1 && x.x2 === y.x2 && x.y2 === y.y2;
}

function identity(node: UiNode): string {
  return JSON.stringify([node.role, node.id, node.label, node.text, node.value, node.hint]);
}

function anchor(element: Element): string {
  if (element.node.id) return `${element.role ?? ''}|#${element.node.id}`;
  const [x, y] = center(element.node.bounds);
  return `${element.role ?? ''}|${element.node.id}|${String(Math.round(x / ANCHOR_GRID))},${String(Math.round(y / ANCHOR_GRID))}`;
}

function numericShape(text: string): string {
  return text.replace(/\d+/g, '#');
}

function changedFields(a: UiNode, b: UiNode): string[] {
  return [...TEXT_FIELDS, ...FLAGS].filter(field => a[field] !== b[field]);
}

function isDigitChange(before: Element, after: Element, fields: string[]): boolean {
  if (before.role !== undefined && TOGGLE_ROLES.has(before.role)) return false;
  return fields.every(
    field =>
      (TEXT_FIELDS as readonly string[]).includes(field) &&
      numericShape(before.node[field as (typeof TEXT_FIELDS)[number]]) ===
        numericShape(after.node[field as (typeof TEXT_FIELDS)[number]]),
  );
}

function isNumericNode(element: Element): boolean {
  if (element.node.id) return false;
  const texts = [element.node.label, element.node.text, element.node.value].filter(Boolean);
  return texts.length > 0 && texts.every(text => NUMERIC_ONLY.test(text));
}

function onScreen(read: ReadableScreen): Element[] {
  return elementsOf(read).filter(element => element.placement === 'on');
}

interface Pairing {
  pairs: [Element, Element][];
  before: Element[];
  after: Element[];
}

function pairBy(
  before: Element[],
  after: Element[],
  key: (element: Element) => string | undefined,
  pairs: [Element, Element][],
): Pairing {
  const pool = new Map<string, Element[]>();
  for (const element of after) {
    const k = key(element);
    if (k === undefined) continue;
    const list = pool.get(k) ?? [];
    list.push(element);
    pool.set(k, list);
  }
  const taken = new Set<Element>();
  const leftBefore: Element[] = [];
  for (const element of before) {
    const k = key(element);
    const candidates = (k === undefined ? undefined : pool.get(k))?.filter(candidate => !taken.has(candidate));
    if (!candidates || candidates.length === 0) {
      leftBefore.push(element);
      continue;
    }
    const best = candidates.reduce((a, b) => (distance(element, a) <= distance(element, b) ? a : b));
    taken.add(best);
    pairs.push([element, best]);
  }
  return { pairs, before: leftBefore, after: after.filter(element => !taken.has(element)) };
}

function pairElements(before: Element[], after: Element[]): Pairing {
  const pairs: [Element, Element][] = [];
  let state: Pairing = { pairs, before, after };
  state = pairBy(state.before, state.after, element => `${identity(element.node)}@${JSON.stringify(element.node.bounds)}`, pairs);
  state = pairBy(state.before, state.after, element => identity(element.node), pairs);
  state = pairBy(
    state.before,
    state.after,
    element => (element.node.id ? `${element.role ?? ''}|${element.node.id}` : undefined),
    pairs,
  );
  state = pairBy(
    state.before,
    state.after,
    element => (element.node.id ? undefined : `${element.role ?? ''}|${JSON.stringify(element.node.bounds)}`),
    pairs,
  );
  state = pairBy(
    state.before,
    state.after,
    element =>
      element.node.id || !element.node.bounds
        ? undefined
        : `${element.role ?? ''}|${String(element.node.bounds.x1)},${String(element.node.bounds.y1)}`,
    pairs,
  );
  return state;
}

export interface VolatileOptions {
  /** Only elements whose text changed in its digits alone: timers and counters, not content that arrived. */
  digitsOnly?: boolean;
}

/** The elements that changed between two reads with no action between them: a volatile set for `diffScreens`. */
export function volatileBetween(first: ScreenRead, second: ScreenRead, options: VolatileOptions = {}): VolatileSet {
  if (!first.readable || !second.readable) return new Set();
  const { pairs, before, after } = pairElements(onScreen(first), onScreen(second));
  const out = new Set<string>();
  for (const [a, b] of pairs) {
    const fields = changedFields(a.node, b.node);
    if (fields.length > 0 && (!options.digitsOnly || isDigitChange(a, b, fields))) out.add(anchor(a));
  }
  if (!options.digitsOnly) for (const element of [...before, ...after]) out.add(anchor(element));
  return out;
}

/**
 * What appeared, disappeared and changed between a read before an action and one after it. Elements are paired by
 * identical content first, then by id, then by role and position. Ignored: anything in `volatile`; an element without
 * an id whose text changes only in its digits (timers, progress); digit-only labels without an id coming and going.
 * An element with an id whose digits change (a tap counter, a badge) is a change unless it was seen ticking idle.
 */
export function diffScreens(before: ScreenRead, after: ScreenRead, volatile: VolatileSet = new Set()): ScreenDiff {
  const diff: ScreenDiff = { appeared: [], disappeared: [], changed: [], moved: 0, ignored: [], unreadable: undefined };
  if (!after.readable) {
    diff.unreadable = after.reason;
    return diff;
  }
  if (!before.readable) {
    diff.appeared = onScreen(after).map(element => describeElement(element));
    return diff;
  }
  const { pairs, before: gone, after: added } = pairElements(onScreen(before), onScreen(after));
  for (const [a, b] of pairs) {
    const fields = changedFields(a.node, b.node);
    if (fields.length === 0) {
      if (!sameBounds(a.node, b.node)) diff.moved += 1;
      continue;
    }
    const entry = { before: describeElement(a), after: describeElement(b), fields };
    const noise = volatile.has(anchor(a)) || volatile.has(anchor(b)) || (!a.node.id && isDigitChange(a, b, fields));
    if (noise) diff.ignored.push(`${entry.before} → ${entry.after}`);
    else diff.changed.push(entry);
  }
  for (const element of gone) {
    const line = describeElement(element);
    if (volatile.has(anchor(element)) || isNumericNode(element)) diff.ignored.push(`- ${line}`);
    else diff.disappeared.push(line);
  }
  for (const element of added) {
    const line = describeElement(element);
    if (volatile.has(anchor(element)) || isNumericNode(element)) diff.ignored.push(`+ ${line}`);
    else diff.appeared.push(line);
  }
  return diff;
}

export function isEmptyDiff(diff: ScreenDiff): boolean {
  return (
    diff.unreadable === undefined && diff.appeared.length === 0 && diff.disappeared.length === 0 && diff.changed.length === 0
  );
}

export interface RenderDiffOptions {
  maxAppeared?: number;
  maxDisappeared?: number;
}

export function renderDiff(diff: ScreenDiff, options: RenderDiffOptions = {}): string {
  if (diff.unreadable !== undefined) return `The screen after the action couldn't be read: ${diff.unreadable}`;
  if (isEmptyDiff(diff)) return diff.moved > 0 ? `No element changed; ${String(diff.moved)} moved.` : 'No change on screen.';
  const maxAppeared = options.maxAppeared ?? 40;
  const maxDisappeared = options.maxDisappeared ?? 8;
  const counts = [
    diff.appeared.length && `${String(diff.appeared.length)} appeared`,
    diff.disappeared.length && `${String(diff.disappeared.length)} gone`,
    diff.changed.length && `${String(diff.changed.length)} changed`,
    diff.moved && `${String(diff.moved)} moved`,
  ].filter(Boolean);
  const lines = [`Screen changed: ${counts.join(', ')}.`];
  for (const change of diff.changed) lines.push(`~ ${change.before} → ${change.after}`);
  for (const line of diff.appeared.slice(0, maxAppeared)) lines.push(`+ ${line}`);
  if (diff.appeared.length > maxAppeared) lines.push(`+ ${String(diff.appeared.length - maxAppeared)} more: call look`);
  for (const line of diff.disappeared.slice(0, maxDisappeared)) lines.push(`- ${line}`);
  if (diff.disappeared.length > maxDisappeared) lines.push(`- ${String(diff.disappeared.length - maxDisappeared)} more gone`);
  return lines.join('\n');
}
