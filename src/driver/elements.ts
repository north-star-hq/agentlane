import { INTERACTIVE_ROLES, intersects, type ReadableScreen, type Rect, type Role, type UiNode } from './tree.ts';

export type Placement = 'on' | 'above' | 'below' | 'left' | 'right';

export interface Element {
  index: number;
  parent: number | undefined;
  node: UiNode;
  role: Role | undefined;
  interactive: boolean | undefined;
  placement: Placement;
}

function described(node: UiNode): boolean {
  return Boolean(node.id || node.label || node.text || node.value || node.hint);
}

function hasSize(bounds: Rect | undefined): boolean {
  return bounds === undefined || (bounds.x2 > bounds.x1 && bounds.y2 > bounds.y1);
}

function placementOf(bounds: Rect | undefined, screen: Rect): Placement {
  if (!bounds || intersects(bounds, screen)) return 'on';
  if (bounds.y2 <= screen.y1) return 'above';
  if (bounds.y1 >= screen.y2) return 'below';
  return bounds.x2 <= screen.x1 ? 'left' : 'right';
}

function hasInteractiveDescendant(node: UiNode): boolean {
  return node.children.some(
    child => (child.role !== undefined && INTERACTIVE_ROLES.has(child.role)) || hasInteractiveDescendant(child),
  );
}

function sameContent(a: UiNode, b: UiNode): boolean {
  return a.id === b.id && a.label === b.label && a.text === b.text && a.value === b.value && a.hint === b.hint;
}

function repeatsAncestor(node: UiNode, ancestor: UiNode | undefined): boolean {
  if (!ancestor) return false;
  if (sameContent(node, ancestor)) return true;
  if (node.id || (node.role !== undefined && INTERACTIVE_ROLES.has(node.role))) return false;
  const own = [node.label, node.text, node.value, node.hint].filter(Boolean);
  const theirs = [ancestor.label, ancestor.text, ancestor.value, ancestor.hint].join('\n');
  return own.length > 0 && own.every(part => theirs.includes(part));
}

/**
 * The elements a person would name on this screen, in document order: nodes with an id, a label, text, a value or a
 * hint, plus unlabelled interactive leaves. Zero-size nodes and children that only repeat their parent are dropped.
 */
export function elementsOf(read: ReadableScreen): Element[] {
  const out: Element[] = [];
  const seen = new Set<string>();
  const walk = (node: UiNode, parent: number | undefined) => {
    let next = parent;
    const interactive = node.role === undefined ? undefined : INTERACTIVE_ROLES.has(node.role);
    const parentElement = parent === undefined ? undefined : out[parent];
    if (parentElement && interactive === true && parentElement.interactive === false && sameContent(node, parentElement.node)) {
      parentElement.role = node.role;
      parentElement.interactive = true;
    }
    const keep =
      hasSize(node.bounds) &&
      (described(node) || (interactive === true && !hasInteractiveDescendant(node))) &&
      !repeatsAncestor(node, parentElement?.node);
    const signature = JSON.stringify([node.role, node.id, node.label, node.text, node.value, node.hint, node.bounds]);
    if (keep && !seen.has(signature)) {
      seen.add(signature);
      next = out.length;
      out.push({
        index: out.length,
        parent,
        node,
        role: node.role,
        interactive,
        placement: placementOf(node.bounds, read.screen),
      });
    }
    for (const child of node.children) walk(child, next);
  };
  walk(read.root, undefined);
  return out;
}
