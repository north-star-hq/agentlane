import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAbsent, readIn } from '../../src/driver/absence.ts';
import { parseFlow } from '../../src/driver/flow.ts';
import { selectorsOfStep } from '../../src/driver/selector.ts';
import { parseInspectScreen } from '../../src/driver/tree.ts';
import { read } from './fixtures.ts';

test('an absence check passes on a complete read without the element', () => {
  for (const form of ['runner', 'inspect'] as const) {
    const verdict = checkAbsent(read('settings', form), { text: 'Bluetooth' });
    assert.equal(verdict.passed, true, verdict.reason);
  }
});

test('an absence check fails on a nearly empty read and says why', () => {
  const verdict = checkAbsent(read('safari-canvas'), { text: 'Row 3' });
  assert.equal(verdict.passed, false);
  assert.equal(
    verdict.reason,
    `Can't prove { text: "Row 3" } is absent: the read is nearly empty (90% of the screen's height has no readable element) and no read in this run held this text, so it may be drawn where the tree describes nothing. Check a screenshot, or select the element by id.`,
  );
});

test('on a nearly empty read, an id absence passes, since an id exists only in the tree', () => {
  const verdict = checkAbsent(read('safari-canvas'), { id: 'mode-tray' });
  assert.equal(verdict.passed, true, verdict.reason);
});

test('on a nearly empty read, a text absence passes when an earlier read in the run held the text', () => {
  const earlier = checkAbsent(
    read('safari-canvas'),
    { text: 'General' },
    { readBefore: readIn([read('settings')], { text: 'General' }) },
  );
  assert.equal(earlier.passed, true, earlier.reason);
  assert.equal(readIn([read('settings')], { text: 'Row 3' }), false);
});

test('an absence check fails on an unreadable read', () => {
  const verdict = checkAbsent(parseInspectScreen('Failed to inspect screen: Connection refused'), { id: 'x' });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /^Can't prove \{ id: "x" \} is absent: the screen read failed/);
});

test('an absence check fails when the element is on screen, matched the way Maestro matches', () => {
  const byText = checkAbsent(read('settings'), { text: 'general' });
  assert.equal(byText.passed, false);
  assert.ok(byText.matches.includes('[button] id=com.apple.settings.general "General"'), byText.matches.join('\n'));
  const byId = checkAbsent(read('settings'), { id: 'com\\.apple\\.settings\\..*' });
  assert.equal(byId.passed, false);
  const childText = checkAbsent(read('settings'), { text: 'Apple Account' });
  assert.equal(childText.passed, false, 'a text node inside a button with a longer label still matches');
});

test('the selectors of a flow say which steps want an element absent', () => {
  const flow = parseFlow(
    'appId: com.apple.Preferences\n---\n- assertNotVisible: "Bluetooth"\n- extendedWaitUntil:\n    notVisible:\n      id: spinner\n- tapOn: General\n',
  );
  assert.deepEqual(
    flow.steps.map(step => selectorsOfStep(step)),
    [
      [{ selector: { text: 'Bluetooth' }, expect: 'absent' }],
      [{ selector: { id: 'spinner' }, expect: 'absent' }],
      [{ selector: { text: 'General' }, expect: 'present' }],
    ],
  );
});
