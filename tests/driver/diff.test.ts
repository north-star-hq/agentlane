import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffScreens, isEmptyDiff, renderDiff, volatileBetween } from '../../src/driver/diff.ts';
import { emptyNode, parseInspectScreen, type ReadableScreen, type UiNode } from '../../src/driver/tree.ts';
import { read } from './fixtures.ts';

test('two reads of a page whose timer and progress text tick, with no action between, diff to nothing', () => {
  for (const form of ['runner', 'inspect'] as const) {
    const diff = diffScreens(read('progress-1', form), read('progress-2', form));
    assert.ok(isEmptyDiff(diff), renderDiff(diff));
    assert.equal(renderDiff(diff), 'No change on screen.');
    assert.equal(diff.ignored.length, 2, diff.ignored.join('\n'));
    const elapsed = diff.ignored.find(line => line.includes('"Elapsed '));
    const [before, after] = (elapsed ?? '').split(' → ');
    assert.ok(before && after && before !== after, elapsed);
  }
});

test('a real tap on the same page reports the text it changed and nothing from the ticking timer', () => {
  const diff = diffScreens(read('progress-2'), read('progress-3'));
  assert.equal(renderDiff(diff), 'Screen changed: 1 changed.\n~ [text] "Idle" focused → [text] "Started" focused');
  assert.equal(diff.ignored.length, 2);
});

test('tapping General in Settings reports the new page and what left', () => {
  const diff = diffScreens(read('settings'), read('settings-general'));
  assert.ok(diff.appeared.includes('[cell] id=About "About"'), diff.appeared.join('\n'));
  assert.ok(diff.appeared.includes('[button] id=BackButton "Settings"'));
  assert.ok(diff.disappeared.includes('[button] id=com.apple.settings.general "General"'));
  const text = renderDiff(diff);
  assert.match(text, /^Screen changed: \d+ appeared, \d+ gone/);
  assert.match(text, /^- \d+ more gone$/m);
});

function screenOf(...children: Partial<UiNode>[]): ReadableScreen {
  const screen = { x1: 0, y1: 0, x2: 400, y2: 800 };
  return {
    readable: true,
    source: 'runner',
    typed: true,
    screen,
    root: { ...emptyNode(), role: 'app', bounds: screen, children: children.map(child => ({ ...emptyNode(), ...child })) },
  };
}

test('a switch turning on is a change even though only a digit moved', () => {
  const off = screenOf({
    role: 'switch',
    id: 'wifi',
    label: 'Wi-Fi',
    value: '0',
    bounds: { x1: 300, y1: 100, x2: 350, y2: 130 },
  });
  const on = screenOf({
    role: 'switch',
    id: 'wifi',
    label: 'Wi-Fi',
    value: '1',
    checked: true,
    bounds: { x1: 300, y1: 100, x2: 350, y2: 130 },
  });
  const diff = diffScreens(off, on);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.changed[0]?.fields, ['value', 'checked']);
});

test('rolling digits coming and going are noise; a new labelled element is not', () => {
  const before = screenOf({ role: 'text', label: '3', bounds: { x1: 10, y1: 10, x2: 20, y2: 30 } });
  const after = screenOf(
    { role: 'text', label: '4', bounds: { x1: 10, y1: 40, x2: 20, y2: 60 } },
    { role: 'button', id: 'done', label: 'Done', bounds: { x1: 10, y1: 100, x2: 90, y2: 140 } },
  );
  const diff = diffScreens(before, after);
  assert.deepEqual(diff.appeared, ['[button] id=done "Done"']);
  assert.deepEqual(diff.disappeared, []);
  assert.equal(diff.ignored.length, 2);
});

test('elements seen changing between two idle reads are ignored after an action, even when words change', () => {
  const quiet1 = screenOf({ role: 'text', id: 'status', label: 'Syncing', bounds: { x1: 0, y1: 0, x2: 100, y2: 20 } });
  const quiet2 = screenOf({ role: 'text', id: 'status', label: 'Uploading', bounds: { x1: 0, y1: 0, x2: 100, y2: 20 } });
  const volatile = volatileBetween(quiet1, quiet2);
  const acted = screenOf(
    { role: 'text', id: 'status', label: 'Indexing', bounds: { x1: 0, y1: 0, x2: 100, y2: 20 } },
    { role: 'text', label: 'Saved', bounds: { x1: 0, y1: 200, x2: 100, y2: 220 } },
  );
  assert.deepEqual(diffScreens(quiet2, acted).changed.length, 1);
  const diff = diffScreens(quiet2, acted, volatile);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.appeared, ['[text] "Saved"']);
});

test('scrolling reports moves, not changes', () => {
  const top = screenOf({ role: 'cell', id: 'row', label: 'Row', bounds: { x1: 0, y1: 300, x2: 400, y2: 340 } });
  const scrolled = screenOf({ role: 'cell', id: 'row', label: 'Row', bounds: { x1: 0, y1: 100, x2: 400, y2: 140 } });
  const diff = diffScreens(top, scrolled);
  assert.equal(renderDiff(diff), 'No element changed; 1 moved.');
});

test('an unreadable read after the action says so instead of listing everything as gone', () => {
  const diff = diffScreens(read('settings'), parseInspectScreen('Failed to inspect screen: timeout'));
  assert.match(renderDiff(diff), /^The screen after the action couldn't be read: /);
  assert.deepEqual(diff.disappeared, []);
});

test('a counter with an id that changes only in its digits is a change, until it is seen ticking with no action', () => {
  const ticker = (seconds: number) => ({
    role: 'text' as const,
    id: 'home-ticker',
    label: `Open for ${String(seconds)} s`,
    bounds: { x1: 10, y1: 10, x2: seconds < 10 ? 120 : 128, y2: 30 },
  });
  const taps = (count: number) => ({
    role: 'text' as const,
    id: 'home-tap-count',
    label: `Taps: ${String(count)}`,
    bounds: { x1: 10, y1: 60, x2: 90, y2: 80 },
  });
  const before = screenOf(ticker(9), taps(0));
  const after = screenOf(ticker(10), taps(1));
  const unseen = diffScreens(before, after);
  assert.deepEqual(
    unseen.changed.map(change => change.after),
    ['[text] id=home-ticker "Open for 10 s"', '[text] id=home-tap-count "Taps: 1"'],
  );
  const volatile = volatileBetween(screenOf(ticker(7), taps(0)), screenOf(ticker(8), taps(0)), { digitsOnly: true });
  const seen = diffScreens(before, after, volatile);
  assert.equal(
    renderDiff(seen),
    'Screen changed: 1 changed.\n~ [text] id=home-tap-count "Taps: 0" → [text] id=home-tap-count "Taps: 1"',
  );
});

test('learning only digit changes leaves content that arrived between idle reads visible after an action', () => {
  const loading = screenOf({ role: 'text', id: 'status', label: 'Loading', bounds: { x1: 0, y1: 0, x2: 100, y2: 20 } });
  const loaded = screenOf(
    { role: 'text', id: 'status', label: 'Loaded', bounds: { x1: 0, y1: 0, x2: 100, y2: 20 } },
    { role: 'cell', id: 'item-1', label: 'Harbor', bounds: { x1: 0, y1: 40, x2: 400, y2: 80 } },
  );
  assert.deepEqual([...volatileBetween(loading, loaded, { digitsOnly: true })], []);
});
