import { elementsOf, type Element } from './elements.ts';
import { describeElement } from './look.ts';
import { escapeRegex, type Selector, selectorYaml } from './selector.ts';
import type { ScreenRead } from './tree.ts';

export interface Suggestion {
  selector: Selector;
  yaml: string;
  element: string;
  score: number;
  basis: string;
}

export const SUGGESTION_MIN_SCORE = 0.6;
const WEAK_SUGGESTIONS = 3;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function compare(query: string, candidate: string): { score: number; basis: string } | undefined {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q || !c) return undefined;
  if (q === c) return { score: 1, basis: 'same string' };
  if (c.startsWith(q)) return { score: 0.9, basis: 'starts the longer string; Maestro matches whole strings' };
  if (c.includes(q)) return { score: 0.8, basis: 'inside the longer string; Maestro matches whole strings' };
  const distance = editDistance(q, c);
  const score = 1 - distance / Math.max(q.length, c.length);
  const queryWords = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const candidateWords = new Set(c.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const shared = queryWords.filter(word => candidateWords.has(word));
  const overlap = queryWords.length > 0 ? (0.9 * shared.length) / queryWords.length : 0;
  if (overlap > score) return { score: overlap, basis: `shares ${shared.map(word => JSON.stringify(word)).join(', ')}` };
  return { score, basis: `${String(distance)} edit${distance === 1 ? '' : 's'} away` };
}

/**
 * Ranked replacements for a selector that missed, taken from the fresh screen: ids and labels that equal, contain or
 * nearly spell the missed id or text. A missed id is also compared with labels, and a missed text with ids.
 */
export function suggestSelectors(read: ScreenRead, missed: Selector, limit = 3): Suggestion[] {
  if (!read.readable) return [];
  const query = missed.id ?? missed.text;
  if (query === undefined) return [];
  const found = new Map<string, Suggestion & { order: number; weak: boolean }>();
  const consider = (element: Element, field: 'id' | 'text', value: string) => {
    const match = compare(query, value);
    if (!match) return;
    const weak = match.score < SUGGESTION_MIN_SCORE;
    if (weak && (element.interactive === false || (field === 'id') !== (missed.id !== undefined))) return;
    const selector: Selector = field === 'id' ? { id: escapeRegex(value) } : { text: escapeRegex(value) };
    const yaml = selectorYaml(selector);
    const offScreen = element.placement === 'on' ? '' : `; off-screen ${element.placement}, scroll first`;
    const sameField = (field === 'id') === (missed.id !== undefined);
    const rank =
      match.score + (sameField ? 0.02 : 0) + (element.interactive === true ? 0.01 : 0) - (element.placement === 'on' ? 0 : 0.05);
    const existing = found.get(yaml);
    if (existing && existing.order >= rank) return;
    found.set(yaml, {
      selector,
      yaml,
      element: describeElement(element),
      score: Math.round(match.score * 100) / 100,
      basis: `${weak ? 'no close match; nearest ' : ''}${field === 'id' ? 'id' : 'label'} ${match.basis}${offScreen}`,
      order: rank,
      weak,
    });
  };
  for (const element of elementsOf(read)) {
    const { node } = element;
    if (node.id) consider(element, 'id', node.id);
    for (const value of new Set([node.label, node.text, node.hint])) if (value) consider(element, 'text', value);
  }
  const ranked = [...found.values()].sort((a, b) => b.order - a.order);
  const strong = ranked.filter(suggestion => !suggestion.weak);
  return (strong.length > 0 ? strong.slice(0, limit) : ranked.slice(0, Math.min(limit, WEAK_SUGGESTIONS))).map(
    ({ selector, yaml, element, score, basis }) => ({ selector, yaml, element, score, basis }),
  );
}
