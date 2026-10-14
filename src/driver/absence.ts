import { elementsOf } from './elements.ts';
import { describeElement, sparsenessOf, type Sparseness } from './look.ts';
import { matchesSelector, type Selector, selectorYaml } from './selector.ts';
import { intersects, type Rect, type ScreenRead, type UiNode } from './tree.ts';

function onScreenNodes(node: UiNode, screen: Rect, out: UiNode[] = []): UiNode[] {
  const { bounds } = node;
  if (bounds && bounds.x2 > bounds.x1 && bounds.y2 > bounds.y1 && intersects(bounds, screen)) out.push(node);
  for (const child of node.children) onScreenNodes(child, screen, out);
  return out;
}

export interface AbsenceVerdict {
  passed: boolean;
  reason: string;
  matches: string[];
}

export interface AbsenceContext {
  /** Replaces the tree's own verdict, for a caller that has re-judged it with a screenshot. */
  sparseness?: Sparseness;
  /** The element was in the accessibility tree earlier in the run. */
  readBefore?: boolean;
}

/**
 * Whether the accessibility tree alone can show the selector's element gone, however little else it holds. An id
 * exists only in the tree, and an element the tree held earlier is one the tree describes, so only text never read
 * can be drawn on screen where the tree describes nothing.
 */
export function treeBound(selector: Selector, readBefore: boolean): boolean {
  return selector.id !== undefined || readBefore;
}

/** Whether any of the reads has an on-screen node the selector matches. */
export function readIn(reads: readonly ScreenRead[], selector: Selector): boolean {
  return reads.some(read => read.readable && onScreenNodes(read.root, read.screen).some(node => matchesSelector(node, selector)));
}

/**
 * An absence check that passes when the read is readable and nothing on screen matches, and, on a nearly empty read,
 * only for a tree-bound selector.
 */
export function checkAbsent(read: ScreenRead, selector: Selector, context: AbsenceContext = {}): AbsenceVerdict {
  const target = selectorYaml(selector);
  if (!read.readable) {
    return { passed: false, reason: `Can't prove ${target} is absent: the screen read failed (${read.reason}).`, matches: [] };
  }
  const matches = onScreenNodes(read.root, read.screen)
    .filter(node => matchesSelector(node, selector))
    .map(node => describeElement({ node }));
  if (matches.length > 0) {
    return { passed: false, reason: `${target} is still on screen.`, matches };
  }
  const verdict = context.sparseness ?? sparsenessOf(read, elementsOf(read));
  if (!verdict.sparse) return { passed: true, reason: `${target} is absent from a complete read.`, matches: [] };
  if (selector.id !== undefined) {
    return { passed: true, reason: `${target} is absent from the tree, the only place an id is.`, matches: [] };
  }
  if (context.readBefore === true) {
    return { passed: true, reason: `${target} is absent from the tree, which held it earlier in the run.`, matches: [] };
  }
  return {
    passed: false,
    reason: `Can't prove ${target} is absent: the read is nearly empty (${verdict.reason ?? 'sparse'}) and no read in this run held this text, so it may be drawn where the tree describes nothing. Check a screenshot, or select the element by id.`,
    matches: [],
  };
}
