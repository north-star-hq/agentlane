import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyHygiene,
  checkHygiene,
  DEFAULT_APPEARANCE,
  DEFAULT_FIXTURE_LOCATION,
  DeviceStateError,
  HygieneError,
  STATUS_BAR_PIN_FIELDS,
  type HygieneReport,
} from '../../src/devices/index.ts';
import { FakeSim, UDID } from './fake.ts';

const TEL_AVIV = { latitude: 32.07, longitude: 34.78 };

function step(report: HygieneReport, name: string) {
  const found = report.steps.find(entry => entry.step === name);
  assert.ok(found, `no ${name} step`);
  return found;
}

test('applyHygiene sets the default location, keyboard, keyboard intro, status bar and appearance and reads each back', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();
  device.appearance = 'dark';

  const report = await applyHygiene(sim, UDID);

  assert.equal(report.changed, true);
  assert.deepEqual(
    report.steps.map(entry => [entry.step, entry.changed, entry.ok]),
    [
      ['location', true, true],
      ['keyboard', true, true],
      ['keyboard-intro', true, true],
      ['status-bar', true, true],
      ['appearance', true, true],
    ],
  );
  assert.deepEqual(device.location?.coordinate, DEFAULT_FIXTURE_LOCATION);
  assert.equal(sim.hostKeyboard.get(UDID), false);
  assert.equal(device.keyboardIntroShown, true);
  for (const [key, value] of Object.entries(STATUS_BAR_PIN_FIELDS)) assert.equal(device.statusBar[key], value);
  assert.equal(device.appearance, DEFAULT_APPEARANCE);
  assert.equal(step(report, 'location').before, 'nothing');
  assert.equal(step(report, 'location').after, '37.3349,-122.009');
  assert.equal(step(report, 'keyboard').before, 'no per-device setting (inherits the host)');
  assert.equal(step(report, 'keyboard-intro').before, 'slide-to-type intro not shown yet');
  assert.equal(step(report, 'keyboard-intro').after, 'slide-to-type intro marked shown');
  assert.equal(step(report, 'appearance').before, 'dark');
});

test('applyHygiene takes the fixture location and appearance from its options', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();

  const report = await applyHygiene(sim, UDID, { location: TEL_AVIV, appearance: 'dark' });

  assert.deepEqual(device.location?.coordinate, TEL_AVIV);
  assert.equal(device.appearance, 'dark');
  assert.equal(step(report, 'location').wanted, '32.07,34.78');
  assert.equal(step(report, 'appearance').wanted, 'dark');
});

test('a second applyHygiene changes nothing', async () => {
  const sim = new FakeSim();
  sim.addDevice();
  await applyHygiene(sim, UDID, { location: TEL_AVIV });
  sim.calls.length = 0;

  const report = await applyHygiene(sim, UDID, { location: TEL_AVIV });

  assert.equal(report.changed, false);
  assert.ok(report.steps.every(entry => entry.ok && !entry.changed));
  assert.deepEqual(sim.mutations(), []);
});

test('only the steps that drifted are re-applied', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();
  await applyHygiene(sim, UDID);
  device.statusBar = {};
  sim.hostKeyboard.set(UDID, true);
  sim.calls.length = 0;

  const report = await applyHygiene(sim, UDID);

  assert.deepEqual(
    report.steps.filter(entry => entry.changed).map(entry => entry.step),
    ['keyboard', 'status-bar'],
  );
  assert.equal(step(report, 'keyboard').before, 'hardware keyboard connected');
  assert.deepEqual(
    sim.mutations().map(call => call.split(' ')[0]),
    ['writeHardwareKeyboard', 'overrideStatusBar'],
  );
});

test('the location read-back polls until locationd reports the new fix', async () => {
  const sim = new FakeSim();
  sim.addDevice();
  sim.locationLagMs = 2500;

  const report = await applyHygiene(sim, UDID, { locationPollMs: 1000 });

  assert.equal(step(report, 'location').ok, true);
  assert.equal(sim.calls.filter(call => call === 'sleep 1000').length, 3);
});

test('a status bar override that does not read back fails loudly and the other steps still run', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();
  sim.faults.add('status-bar');

  const error = await applyHygiene(sim, UDID).then(
    () => assert.fail('expected a HygieneError'),
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof HygieneError);
  assert.match(error.message, /status-bar reads back no overrides, not Time 09:41/);
  assert.equal(step(error.report, 'status-bar').ok, false);
  assert.equal(step(error.report, 'appearance').ok, true);
  assert.equal(device.location?.coordinate.latitude, DEFAULT_FIXTURE_LOCATION.latitude);
});

test('a location set the simulator drops reads back nothing a few times, is set again, and takes', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();
  sim.lostLocationSets = 2;

  const report = await applyHygiene(sim, UDID);

  assert.equal(step(report, 'location').ok, true);
  assert.equal(step(report, 'location').after, '37.3349,-122.009');
  assert.deepEqual(device.location?.coordinate, DEFAULT_FIXTURE_LOCATION);
  assert.equal(sim.calls.filter(call => call.startsWith('setLocation')).length, 3);
  assert.equal(sim.calls.filter(call => call.startsWith('readLocation')).length, 1 + 8 + 8 + 1);
});

test('a location that never reads back fails once every set and read is spent, naming them, with no real waiting', async () => {
  const sim = new FakeSim();
  sim.addDevice();
  sim.faults.add('location');

  const error = await applyHygiene(sim, UDID, {
    locationReadAttempts: 4,
    locationPollMs: 250,
    locationSetAttempts: 2,
  }).catch((caught: unknown) => caught);

  assert.ok(error instanceof HygieneError);
  assert.match(error.message, /location reads back nothing, not 37\.3349,-122\.009 after setting it 2 times over 2 s/);
  assert.equal(sim.calls.filter(call => call.startsWith('setLocation')).length, 2);
  assert.equal(sim.calls.filter(call => call === 'sleep 250').length, 8);
  assert.equal(step(error.report, 'keyboard').ok, true);
});

test('keyboard and appearance writes that do not take are reported per step', async () => {
  const sim = new FakeSim();
  sim.addDevice().appearance = 'dark';
  sim.faults.add('keyboard');
  sim.faults.add('appearance');

  const error = await applyHygiene(sim, UDID).catch((caught: unknown) => caught);

  assert.ok(error instanceof HygieneError);
  assert.deepEqual(
    error.report.steps.filter(entry => !entry.ok).map(entry => [entry.step, entry.after]),
    [
      ['keyboard', 'no per-device setting (inherits the host)'],
      ['appearance', 'dark'],
    ],
  );
});

test('a keyboard intro mark that does not read back fails, naming the step, and an erased simulator gets it again', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();
  sim.faults.add('keyboard-intro');

  const error = await applyHygiene(sim, UDID).catch((caught: unknown) => caught);

  assert.ok(error instanceof HygieneError);
  assert.deepEqual(
    error.report.steps.filter(entry => !entry.ok).map(entry => entry.step),
    ['keyboard-intro'],
  );
  assert.match(
    error.message,
    /keyboard-intro reads back slide-to-type intro not shown yet, not slide-to-type intro marked shown/,
  );

  sim.faults.clear();
  await applyHygiene(sim, UDID);
  delete device.keyboardIntroShown;
  sim.calls.length = 0;

  const report = await applyHygiene(sim, UDID);

  assert.deepEqual(
    report.steps.filter(entry => entry.changed).map(entry => entry.step),
    ['keyboard-intro'],
  );
  assert.deepEqual(sim.mutations(), [`writeKeyboardIntroShown ${UDID} true`]);
});

test('a command that throws is recorded as that step failing', async () => {
  const sim = new FakeSim();
  sim.addDevice().appearance = 'dark';
  sim.failing.set('setAppearance', new Error('simctl ui exited 1'));

  const error = await applyHygiene(sim, UDID).catch((caught: unknown) => caught);

  assert.ok(error instanceof HygieneError);
  const appearance = step(error.report, 'appearance');
  assert.equal(appearance.ok, false);
  assert.equal(appearance.error, 'simctl ui exited 1');
  assert.match(error.message, /appearance reads back unread, not light \(simctl ui exited 1\)/);
});

test('hygiene refuses a simulator that is not booted, naming the fix, and changes nothing', async () => {
  const sim = new FakeSim();
  sim.addDevice(UDID, 'Shutdown');

  await assert.rejects(applyHygiene(sim, UDID), (error: unknown) => {
    assert.ok(error instanceof DeviceStateError);
    assert.match(error.message, /is Shutdown, not Booted/);
    assert.match(error.fix ?? '', /xcrun simctl boot FC2D4835-7AE5-4CEC-B354-DFE87A10A760/);
    return true;
  });
  assert.deepEqual(sim.mutations(), []);
});

test('hygiene refuses an unknown or malformed UDID', async () => {
  const sim = new FakeSim();
  await assert.rejects(applyHygiene(sim, UDID), /no simulator has UDID/);
  await assert.rejects(applyHygiene(sim, 'booted'), /'booted' is not a simulator UDID/);
  assert.deepEqual(sim.calls, ['device FC2D4835-7AE5-4CEC-B354-DFE87A10A760']);
});

test('checkHygiene reports each setting without changing any', async () => {
  const sim = new FakeSim();
  sim.addDevice();

  const before = await checkHygiene(sim, UDID, { location: TEL_AVIV });
  assert.equal(before.ok, false);
  assert.deepEqual(
    before.steps.map(entry => [entry.step, entry.ok]),
    [
      ['location', false],
      ['keyboard', false],
      ['keyboard-intro', false],
      ['status-bar', false],
      ['appearance', true],
    ],
  );
  assert.deepEqual(sim.mutations(), []);

  await applyHygiene(sim, UDID, { location: TEL_AVIV });
  const after = await checkHygiene(sim, UDID, { location: TEL_AVIV });
  assert.equal(after.ok, true);
  assert.equal(after.steps[0]?.got, '32.07,34.78');
});

test('checkHygiene accepts a location last delivered minutes ago, which applyHygiene would set again', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();
  await applyHygiene(sim, UDID, { location: TEL_AVIV });
  await sim.sleep(60_000);
  if (device.location) device.location.heardAt = sim.now().getTime() - 60_000;

  const [heard] = (await checkHygiene(sim, UDID, { location: TEL_AVIV })).steps;
  assert.deepEqual([heard?.step, heard?.ok, heard?.got], ['location', true, '32.07,34.78']);

  if (device.location) device.location.heardAt = sim.now().getTime() - 600_000;
  const [silent] = (await checkHygiene(sim, UDID, { location: TEL_AVIV })).steps;
  assert.deepEqual([silent?.step, silent?.ok, silent?.got], ['location', false, 'nothing']);

  if (device.location) device.location.heardAt = sim.now().getTime() - 60_000;
  const report = await applyHygiene(sim, UDID, { location: TEL_AVIV });
  assert.equal(step(report, 'location').changed, true);
});

test('checkHygiene reports an unreadable setting instead of throwing', async () => {
  const sim = new FakeSim();
  sim.addDevice();
  sim.failing.set('readStatusBar', new Error('simctl status_bar exited 2'));

  const check = await checkHygiene(sim, UDID);

  const statusBar = check.steps.find(entry => entry.step === 'status-bar');
  assert.equal(statusBar?.ok, false);
  assert.equal(statusBar.got, 'unreadable (simctl status_bar exited 2)');
});

test('a location within tolerance of the fixture counts as set', async () => {
  const sim = new FakeSim();
  const device = sim.addDevice();
  device.location = { coordinate: { latitude: 32.07000001, longitude: 34.78 }, visibleAt: 0 };

  const report = await applyHygiene(sim, UDID, { location: TEL_AVIV });

  assert.equal(step(report, 'location').changed, false);
});
