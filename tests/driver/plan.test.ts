import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFlow } from '../../src/driver/flow.ts';
import { absenceSelectors, finalAbsenceSteps, flowYaml, prepareFlow, quickBody, splittable } from '../../src/driver/plan.ts';
import { flowError } from '../../src/driver/session.ts';

test('a bare command list gets the appId header; a flow with one keeps it', () => {
  const bare = prepareFlow('- tapOn: General\n', 'com.apple.Preferences');
  assert.equal(bare.headerAdded, true);
  assert.equal(bare.source, 'appId: com.apple.Preferences\n---\n- tapOn: General\n');
  assert.equal(bare.flow.steps.length, 1);
  const full = prepareFlow('appId: com.example.expoapp\n---\n- tapOn: General\n', 'com.apple.Preferences');
  assert.equal(full.headerAdded, false);
  assert.equal(full.appId, 'com.example.expoapp');
  const unknown = prepareFlow('- tapOn: General\n', undefined);
  assert.equal(unknown.source, '- tapOn: General\n');
  assert.equal(unknown.appId, undefined);
});

test('the quick form adds no-settle options to taps only, and turns a text tap into a selector', () => {
  assert.deepEqual(quickBody({ tapOn: 'General' }), {
    tapOn: { text: 'General', waitToSettleTimeoutMs: 0, retryTapIfNoChange: false },
  });
  assert.deepEqual(quickBody({ longPressOn: { id: 'x', waitToSettleTimeoutMs: 500 } }), {
    longPressOn: { id: 'x', waitToSettleTimeoutMs: 500, retryTapIfNoChange: false },
  });
  assert.deepEqual(quickBody({ assertVisible: 'General' }), { assertVisible: 'General' });
  assert.equal(quickBody('back'), 'back');
});

test('flowYaml writes the header and the chosen steps', () => {
  const flow = parseFlow('appId: a.b\n---\n- tapOn: X\n- back\n');
  const [first, second] = flow.steps;
  assert.ok(first && second);
  assert.equal(flowYaml(flow, [second], false), 'appId: a.b\n---\n- back\n');
  assert.equal(
    flowYaml(flow, flow.steps, true),
    'appId: a.b\n---\n- tapOn:\n    text: X\n    waitToSettleTimeoutMs: 0\n    retryTapIfNoChange: false\n- back\n',
  );
});

test('only flows of stateless commands run one step per call', () => {
  assert.equal(splittable(parseFlow('appId: a\n---\n- tapOn: X\n- assertVisible: Y\n')), true);
  assert.equal(splittable(parseFlow('appId: a\n---\n- tapOn: X\n')), false, 'one step is already one call');
  assert.equal(splittable(parseFlow('appId: a\n---\n- copyTextFrom: X\n- pasteText\n')), false);
  assert.equal(splittable(parseFlow('appId: a\n---\n- runScript: s.js\n- tapOn: X\n')), false);
  assert.equal(splittable(parseFlow('appId: a\n---\n- inputText: ${output.name}\n- tapOn: X\n')), false);
  assert.equal(splittable(parseFlow('appId: a\nonFlowStart:\n  - tapOn: Y\n---\n- tapOn: X\n- back\n')), false);
  assert.equal(splittable(parseFlow('appId: a\n---\n- repeat:\n    times: 2\n    commands:\n      - tapOn: X\n- back\n')), false);
});

test('absence steps name the selectors that must be gone', () => {
  const flow = parseFlow(
    'appId: a\n---\n- assertNotVisible: Spinner\n- extendedWaitUntil:\n    notVisible:\n      id: loading\n- assertVisible: Done\n',
  );
  assert.deepEqual(flow.steps.map(absenceSelectors), [[{ text: 'Spinner' }], [{ id: 'loading' }], []]);
});

test("flowError takes a file run's per-flow errors and leaves inline errors alone", () => {
  const reply = JSON.stringify({ success: false, results: [{ success: false, error: 'Assertion is false: id: x is visible' }] });
  assert.equal(flowError(reply), 'Assertion is false: id: x is visible');
  assert.equal(
    flowError('Failed to run flow: Element not found: Text matching regex: X'),
    'Failed to run flow: Element not found: Text matching regex: X',
  );
});

test('of a flow run in one call, only the absence steps after its last action are judged on the screen it ends on', () => {
  const flow = parseFlow(
    'appId: a\n---\n- assertNotVisible: Early\n- tapOn: Go\n- assertNotVisible:\n    id: late\n- takeScreenshot: x\n- extendedWaitUntil:\n    notVisible: Last\n',
  );
  assert.deepEqual(
    finalAbsenceSteps(flow.steps).map(step => step.index),
    [2, 4],
  );
});
