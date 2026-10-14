import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildFailure } from '../../src/driver/failure.ts';
import { parseFlow, writeFlow } from '../../src/driver/flow.ts';

test('a flow splits into its config and steps with their lines', () => {
  const flow = parseFlow('appId: com.apple.Preferences\n---\n- launchApp\n- tapOn:\n    id: com.apple.settings.general\n');
  assert.equal(flow.appId, 'com.apple.Preferences');
  assert.equal(flow.error, undefined);
  assert.deepEqual(
    flow.steps.map(step => [step.command, step.startLine, step.endLine]),
    [
      ['launchApp', 3, 3],
      ['tapOn', 4, 5],
    ],
  );
});

test('YAML that does not parse still yields its steps by their top-level dashes', () => {
  const flow = parseFlow('appId: x\n---\n- launchApp\n- tapOn: [General\n- back\n');
  assert.notEqual(flow.error, undefined);
  assert.deepEqual(
    flow.steps.map(step => [step.command, step.startLine]),
    [
      ['launchApp', 3],
      ['tapOn', 4],
      ['back', 5],
    ],
  );
});

test("writeFlow joins the passing steps of a session's runs under one appId header", () => {
  const recording = writeFlow([
    { yaml: 'appId: com.apple.Preferences\n---\n- launchApp\n' },
    { yaml: 'appId: com.apple.Preferences\n---\n- tapOn:\n    id: com.apple.settings.general\n- tapOn: Abuot\n', passed: 1 },
    { yaml: '- assertVisible: About\n' },
  ]);
  assert.equal(
    recording.flow,
    'appId: com.apple.Preferences\n---\n- launchApp\n- tapOn:\n    id: com.apple.settings.general\n- assertVisible: About\n',
  );
  assert.deepEqual(parseFlow(recording.flow).steps.length, 3);
});

test('writeFlow keeps the config of the first run and refuses runs against two apps', () => {
  const recording = writeFlow([{ yaml: 'appId: a.b\nname: Probe\n---\n- launchApp\n' }]);
  assert.equal(recording.flow, 'appId: a.b\nname: Probe\n---\n- launchApp\n');
  assert.throws(
    () => writeFlow([{ yaml: 'appId: a.b\n---\n- launchApp\n' }, { yaml: 'appId: c.d\n---\n- launchApp\n' }]),
    /two apps, a\.b and c\.d/,
  );
  assert.throws(() => writeFlow([{ yaml: '- launchApp\n' }]), /none was given/);
  assert.equal(writeFlow([{ yaml: '- launchApp\n' }], 'a.b').appId, 'a.b');
  assert.throws(() => writeFlow([{ yaml: 'appId: a.b\n---\n- tapOn: [x\n' }]), /not valid flow YAML/);
  assert.throws(() => writeFlow([{ yaml: 'appId: a.b\n---\n- tapOn: x\n', passed: 0 }]), /no passing steps/);
});

test('the recorded Settings probe is the flow that passed under maestro test', () => {
  const runs = [
    'appId: com.apple.Preferences\n---\n- launchApp\n- waitForAnimationToEnd\n',
    'appId: com.apple.Preferences\n---\n- tapOn:\n    id: com.apple.settings.general\n- tapOn: "Abuot"\n',
    'appId: com.apple.Preferences\n---\n- assertVisible: About\n- assertNotVisible: Bluetooth\n',
  ];
  const failure = buildFailure({
    flow: runs[1] ?? '',
    error: 'Failed to run flow: Element not found: Text matching regex: Abuot',
  });
  const recording = writeFlow([
    { yaml: runs[0] ?? '' },
    { yaml: runs[1] ?? '', passed: failure.completedSteps ?? 0 },
    { yaml: runs[2] ?? '' },
  ]);
  const committed = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'fixtures', 'recorded-settings.yaml'), 'utf8');
  assert.equal(recording.flow, committed);
});
