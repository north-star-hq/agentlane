import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFailure, renderFailure, type FailureKind, type ReachedDevice } from '../../src/driver/failure.ts';
import { read, runFailures } from './fixtures.ts';

interface Expected {
  kind: FailureKind;
  step: number | undefined;
  reached: ReachedDevice;
  suggestion?: string;
}

const EXPECTED: Record<string, Expected> = {
  'missing-id': { kind: 'selector-miss', step: 0, reached: 'no', suggestion: '{ id: "com.apple.settings.general" }' },
  'missing-text': { kind: 'selector-miss', step: 0, reached: 'no', suggestion: '{ text: "General" }' },
  'missing-text-index': { kind: 'selector-miss', step: 0, reached: 'no', suggestion: '{ text: "General" }' },
  'assert-visible': { kind: 'assertion', step: 0, reached: 'no', suggestion: '{ text: "Action Button" }' },
  'assert-visible-id': { kind: 'assertion', step: 0, reached: 'no' },
  'assert-not-visible': { kind: 'assertion', step: 0, reached: 'no' },
  'invalid-yaml': { kind: 'invalid-flow', step: 0, reached: 'no' },
  'unknown-command': { kind: 'invalid-flow', step: 0, reached: 'no' },
  'no-header': { kind: 'invalid-flow', step: 0, reached: 'no' },
  timeout: { kind: 'timeout', step: 0, reached: 'no' },
  'assert-true': { kind: 'assertion', step: 0, reached: 'no' },
  'launch-missing-app': { kind: 'device-error', step: 0, reached: 'yes' },
  'open-link-refused': { kind: 'device-error', step: 0, reached: 'yes' },
  'second-step': { kind: 'selector-miss', step: 1, reached: 'no', suggestion: '{ text: "About" }' },
};

test('every captured Maestro run failure maps to a kind, a step and a reached-device answer', () => {
  const fixtures = runFailures();
  assert.deepEqual(fixtures.map(fixture => fixture.name).sort(), Object.keys(EXPECTED).sort());
  for (const fixture of fixtures) {
    const expected = EXPECTED[fixture.name];
    assert.ok(expected);
    const failure = buildFailure({ flow: fixture.flow, error: fixture.error, screen: read(fixture.screen) });
    assert.equal(failure.kind, expected.kind, fixture.name);
    assert.equal(failure.step?.index, expected.step, fixture.name);
    assert.equal(failure.reachedDevice, expected.reached, fixture.name);
    assert.ok(failure.screen && failure.screen.lines.length > 0, fixture.name);
    if (expected.suggestion !== undefined) {
      assert.equal(failure.suggestions[0]?.yaml, expected.suggestion, `${fixture.name}: ${JSON.stringify(failure.suggestions)}`);
    }
  }
});

test('a selector miss after a passing step says which step, that the earlier one ran, and what to use instead', () => {
  const fixture = runFailures().find(entry => entry.name === 'second-step');
  assert.ok(fixture);
  const failure = buildFailure({
    flow: fixture.flow,
    error: fixture.error,
    screen: read('settings-general'),
    look: { interactiveOnly: true },
  });
  assert.equal(failure.completedSteps, 1);
  assert.deepEqual(failure.selector, { text: 'Abuot' });
  const text = renderFailure(failure);
  const lines = text.split('\n');
  assert.equal(
    lines[0],
    'Run failed (selector-miss) at step 2 of 2 (tapOn: Abuot): Element not found: Text matching regex: Abuot',
  );
  assert.equal(
    lines[1],
    'Reached the device: no. Maestro looks the element up before acting, and it never found one. 1 earlier step ran.',
  );
  assert.equal(lines[3], '  { text: "About" }  [cell] id=About "About"  (label 2 edits away)');
  assert.ok(lines.includes('Screen now:'));
  assert.ok(lines.includes('[cell] id=About "About"'));
});

test('an invalid flow names the step on the line Maestro reported', () => {
  const failure = buildFailure({
    flow: 'appId: com.apple.Preferences\n---\n- launchApp\n- tapOn: [General\n',
    error: 'Failed to run flow: Parsing Failed at /tmp/maestro-flow1.yaml:4:18',
  });
  assert.equal(failure.kind, 'invalid-flow');
  assert.equal(failure.step?.index, 1);
  assert.equal(failure.completedSteps, 0);
});

test('a step the caller ran on its own is named even when the message matches several steps', () => {
  const flow = 'appId: com.apple.Preferences\n---\n- tapOn: "Genral"\n- tapOn: "Genral"\n';
  const error = 'Failed to run flow: Element not found: Text matching regex: Genral';
  assert.equal(buildFailure({ flow, error }).step, undefined);
  assert.equal(buildFailure({ flow, error }).completedSteps, undefined);
  assert.equal(buildFailure({ flow, error, failedStep: 1 }).step?.index, 1);
});

test("an error Maestro doesn't classify is unknown, and so is whether it reached the device", () => {
  const failure = buildFailure({
    flow: 'appId: com.apple.Preferences\n---\n- swipe:\n    direction: UP\n',
    error: 'Failed to run flow: java.net.SocketTimeoutException: timeout',
  });
  assert.equal(failure.kind, 'unknown');
  assert.equal(failure.reachedDevice, 'unknown');
  assert.equal(failure.message, 'java.net.SocketTimeoutException: timeout');
  assert.equal(failure.step?.index, 0);
});
