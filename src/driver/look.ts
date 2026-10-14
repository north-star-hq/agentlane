import { elementsOf, type Element } from './elements.ts';
import { area, formatBounds, INTERACTIVE_ROLES, type ReadableScreen, type Rect, type ScreenRead } from './tree.ts';

export interface LookOptions {
  interactiveOnly?: boolean;
  /** An id, or a label matched in full and ignoring case, naming the element whose subtree to show. */
  within?: string;
  /** How many levels of shown elements to print, counted from the top of what is shown. */
  depth?: number;
  bounds?: boolean;
}

export interface Sparseness {
  sparse: boolean;
  content: number;
  largestBlank: number;
  reason: string | undefined;
}

export interface LookResult {
  text: string;
  lines: string[];
  shown: number;
  onScreen: number;
  interactive: number | undefined;
  offScreen: Record<'above' | 'below' | 'left' | 'right', number>;
  sparseness: Sparseness | undefined;
  attachScreenshot: boolean;
}

const STATUS_BAR_SHARE = 0.07;
const CONTAINER_SHARE = 0.25;
export const SPARSE_MIN_CONTENT = 6;
export const SPARSE_BLANK_SHARE = 0.4;
export const SPARSE_BLANK_MAX_CONTENT = 15;
const LABEL_LIMIT = 120;

function quote(text: string): string {
  const shown = text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT)}…` : text;
  return JSON.stringify(shown);
}

function idToken(id: string): string {
  return /^[\w.:/-]+$/.test(id) ? id : JSON.stringify(id);
}

export function describeElement(element: Pick<Element, 'node'>, withBounds = false): string {
  const { node } = element;
  const parts: string[] = [];
  if (node.role !== undefined) parts.push(`[${node.role}]`);
  if (node.id) parts.push(`id=${idToken(node.id)}`);
  const main = node.label || node.text || node.hint;
  if (main) parts.push(quote(main));
  if (node.text && node.text !== main) parts.push(`text=${quote(node.text)}`);
  if (node.value && node.value !== main && node.value !== node.text) parts.push(`value=${quote(node.value)}`);
  if (node.hint && node.hint !== main) parts.push(`hint=${quote(node.hint)}`);
  if (!node.enabled) parts.push('disabled');
  for (const flag of ['checked', 'selected', 'focused'] as const) if (node[flag]) parts.push(flag);
  if (withBounds && node.bounds) parts.push(formatBounds(node.bounds));
  return parts.join(' ');
}

function nameOf(element: Element): string {
  return element.node.label || element.node.text || element.node.id || element.node.hint;
}

function matchesWithin(element: Element, within: string): boolean {
  if (element.node.id === within) return true;
  const target = within.toLowerCase();
  return [element.node.label, element.node.text].some(value => value.toLowerCase() === target);
}

function isStatusBar(element: Element, read: ReadableScreen): boolean {
  const bounds = element.node.bounds;
  if (element.role === 'statusbar') return true;
  const band = read.screen.y1 + (read.screen.y2 - read.screen.y1) * STATUS_BAR_SHARE;
  return bounds !== undefined && bounds.y2 <= band;
}

/**
 * The elements that count as content: on screen, below the status bar, and smaller than a quarter of the screen
 * (sheets and scroll views that span the screen are containers, not content). Also returns the status bar band.
 */
export function contentElements(
  read: ReadableScreen,
  elements: Element[] = elementsOf(read),
): { statusBar: Rect; top: number; elements: Element[] } {
  const screenArea = area(read.screen);
  const top = read.screen.y1 + (read.screen.y2 - read.screen.y1) * STATUS_BAR_SHARE;
  const height = read.screen.y2 - top;
  const content = elements.filter(element => {
    const bounds = element.node.bounds;
    if (element.placement !== 'on' || !bounds || isStatusBar(element, read)) return false;
    return area(bounds) < screenArea * CONTAINER_SHARE && bounds.y2 - bounds.y1 < height / 2;
  });
  return { statusBar: { x1: read.screen.x1, y1: read.screen.y1, x2: read.screen.x2, y2: top }, top, elements: content };
}

/**
 * Whether a read shows too little to trust. A read is sparse when it has fewer than SPARSE_MIN_CONTENT content
 * elements, or when it has fewer than SPARSE_BLANK_MAX_CONTENT and the tallest horizontal band holding no content is
 * at least SPARSE_BLANK_SHARE of the screen's height: that is where a sheet body or a map drew pixels the
 * accessibility tree doesn't describe.
 */
export function sparsenessOf(read: ReadableScreen, elements: Element[] = elementsOf(read)): Sparseness {
  const { top, elements: content } = contentElements(read, elements);
  const height = read.screen.y2 - top;
  const spans: [number, number][] = [];
  for (const element of content) {
    const bounds = element.node.bounds;
    if (bounds) spans.push([Math.max(top, bounds.y1), Math.min(read.screen.y2, bounds.y2)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let largest = 0;
  let cursor = top;
  for (const [start, end] of spans) {
    largest = Math.max(largest, start - cursor);
    cursor = Math.max(cursor, end);
  }
  largest = Math.max(largest, read.screen.y2 - cursor);
  const largestBlank = height > 0 ? largest / height : 1;
  let reason: string | undefined;
  if (spans.length < SPARSE_MIN_CONTENT) {
    reason = `only ${String(spans.length)} element${spans.length === 1 ? '' : 's'} below the status bar`;
  } else if (spans.length < SPARSE_BLANK_MAX_CONTENT && largestBlank >= SPARSE_BLANK_SHARE) {
    reason = `${String(Math.round(largestBlank * 100))}% of the screen's height has no readable element`;
  }
  return { sparse: reason !== undefined, content: spans.length, largestBlank, reason };
}

/**
 * An untyped view (`other`) with an id and a label, smaller than a container and holding no control: React Native's
 * Pressable without an accessibilityRole reads this way, so interactive-only keeps it.
 */
function tappableOther(element: Element, screenArea: number): boolean {
  const { node } = element;
  if (element.role !== 'other' || node.id === '' || (node.label === '' && node.text === '') || !node.bounds) return false;
  if (area(node.bounds) >= screenArea * CONTAINER_SHARE) return false;
  return !node.children.some(function control(child): boolean {
    return (child.role !== undefined && INTERACTIVE_ROLES.has(child.role)) || child.children.some(control);
  });
}

function offScreenLine(offScreen: Element[]): string | undefined {
  if (offScreen.length === 0) return undefined;
  const parts: string[] = [];
  for (const side of ['above', 'below', 'left', 'right'] as const) {
    const group = offScreen.filter(element => element.placement === side);
    if (group.length === 0) continue;
    const ranked = [
      ...group.filter(element => element.interactive !== false),
      ...group.filter(element => element.interactive === false),
    ];
    const names = [...new Set(ranked.map(nameOf).filter(Boolean))];
    const listed = names.slice(0, 5).map(name => quote(name));
    const rest = names.length - listed.length;
    parts.push(
      `${String(group.length)} ${side}${listed.length ? ` (${listed.join(', ')}${rest > 0 ? ` +${String(rest)}` : ''})` : ''}`,
    );
  }
  return `Off-screen: ${parts.join('; ')}.`;
}

export function unreadableLook(reason: string): LookResult {
  return {
    text: `Unreadable screen: ${reason.replace(/\.?$/, '.')} A screenshot is attached; tap by point.`,
    lines: [],
    shown: 0,
    onScreen: 0,
    interactive: undefined,
    offScreen: { above: 0, below: 0, left: 0, right: 0 },
    sparseness: undefined,
    attachScreenshot: true,
  };
}

/** `sparseness` replaces the tree's own verdict, for a caller that has re-judged it with a screenshot. */
export function look(read: ScreenRead, options: LookOptions = {}, sparseness?: Sparseness): LookResult {
  if (!read.readable) return unreadableLook(read.reason);
  const all = elementsOf(read);
  sparseness ??= sparsenessOf(read, all);
  const notes: string[] = [];

  let scope = all;
  if (options.within !== undefined) {
    const within = options.within;
    const root = all.find(element => matchesWithin(element, within));
    if (root) {
      const inside = new Set<number>([root.index]);
      for (const element of all) if (element.parent !== undefined && inside.has(element.parent)) inside.add(element.index);
      scope = all.filter(element => inside.has(element.index));
    } else {
      notes.push(`Nothing on screen has the id or label ${JSON.stringify(within)}; showing the whole screen.`);
    }
  }

  const screenArea = area(read.screen);
  const wanted = (element: Element) => element.interactive === true || tappableOther(element, screenArea);
  let interactiveOnly = options.interactiveOnly === true;
  if (interactiveOnly && !read.typed) {
    interactiveOnly = false;
    notes.push('This read carries no element types, so interactive-only shows every element.');
  }
  const onScreen = scope.filter(element => element.placement === 'on');
  const picked = onScreen.filter(element => !interactiveOnly || wanted(element));
  const pickedSet = new Set(picked.map(element => element.index));

  const depthOf = new Map<number, number>();
  const shownDepth = (element: Element): number => {
    let parent = element.parent;
    while (parent !== undefined && !pickedSet.has(parent)) parent = all[parent]?.parent;
    return parent === undefined ? 0 : (depthOf.get(parent) ?? 0) + 1;
  };
  const lines: string[] = [];
  for (const element of picked) {
    const depth = shownDepth(element);
    depthOf.set(element.index, depth);
    if (options.depth !== undefined && depth >= options.depth) continue;
    lines.push(`${'  '.repeat(depth)}${describeElement(element, options.bounds === true)}`);
  }

  const offScreenElements = scope.filter(element => element.placement !== 'on' && (!interactiveOnly || wanted(element)));
  const offScreen = { above: 0, below: 0, left: 0, right: 0 };
  for (const element of offScreenElements) if (element.placement !== 'on') offScreen[element.placement] += 1;

  const attachScreenshot = sparseness.sparse && options.within === undefined;
  const tail: string[] = [];
  const offLine = offScreenLine(offScreenElements);
  if (offLine) tail.push(offLine);
  if (attachScreenshot && sparseness.reason) {
    tail.push(`This read is nearly empty (${sparseness.reason}): a screenshot is attached; tap what it shows by point.`);
  }
  if (lines.length === 0)
    notes.push(interactiveOnly ? 'Nothing interactive is on screen.' : 'Nothing on screen has an id, a label or text.');
  return {
    text: [...notes, ...lines, ...tail].join('\n'),
    lines,
    shown: lines.length,
    onScreen: onScreen.length,
    interactive: read.typed ? onScreen.filter(wanted).length : undefined,
    offScreen,
    sparseness,
    attachScreenshot,
  };
}
