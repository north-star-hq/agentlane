import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { callEngine, engineStatus, stopEngine } from '../../src/driver/client.ts';
import { messageOf } from '../../src/driver/errors.ts';
import { enginePaths } from '../../src/driver/paths.ts';
import { lockHolder } from '../../src/driver/lock.ts';
import { alive, driverWorld, until, type DriverWorld } from '../support/driver-world.ts';

async function withWorld(options: Parameters<typeof driverWorld>[0], body: (world: DriverWorld) => Promise<void>): Promise<void> {
  const world = await driverWorld(options);
  try {
    await body(world);
  } finally {
    await world.close();
  }
}

const calls = (world: DriverWorld, name?: string) =>
  world.events().filter(event => event.event === 'call' && (name === undefined || event.name === name));
const childPids = (world: DriverWorld, kind: 'xcodebuild' | 'runner') =>
  world
    .events()
    .filter(event => event.event === kind)
    .map(event => event.child as number);

test('the first look starts one engine with one Maestro, given the lane token and only the claimed simulator', () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    assert.match(first.text ?? '', /id=com\.apple\.settings\.general "General"/);
    const second = await callEngine(world.target(), { op: 'look', args: { interactiveOnly: true } });
    assert.equal(second.pid, first.pid);
    const spawns = world.spawns();
    assert.equal(spawns.length, 1);
    const [spawned] = spawns;
    const paths = enginePaths(world.stateDir, world.lane.id);
    assert.deepEqual(spawned?.argv, ['mcp', '--no-viewer', '--working-dir', paths.work]);
    assert.equal(spawned.token, world.lane.token);
    assert.equal(spawned.javaHome, world.toolchain.javaHome);
    assert.equal(spawned.pathHead, path.join(paths.work, 'bin'));
    for (const call of calls(world)) assert.equal((call.args as { device_id: string }).device_id, world.lane.device?.id);
    await until(
      () => world.registry().find(world.lane.owner, world.worktree)?.lastAction === 'look',
      3000,
      'the lane to be touched',
    );
  }));

test('concurrent first calls start a single engine and a single Maestro', () =>
  withWorld({}, async world => {
    const responses = await Promise.all([
      callEngine(world.target(), { op: 'look', args: {} }),
      callEngine(world.target(), { op: 'screenshot', args: {} }),
      callEngine(world.target(), { op: 'look', args: {} }),
      callEngine(world.target(), { op: 'look', args: {} }),
    ]);
    assert.ok(responses.every(response => response.ok));
    assert.equal(new Set(responses.map(response => response.pid)).size, 1);
    assert.equal(world.spawns().length, 1);
  }));

test('a Maestro that dies under a read is restarted once and the read retried', () =>
  withWorld({ env: { FAKE_DIE_AFTER: '1' } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const second = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(second.ok, true, second.error);
    assert.match(second.text ?? '', /^Maestro's session was rebuilt for this call\./);
    assert.equal(world.spawns().length, 2);
  }));

test('a Maestro that fails again after its restart surfaces a structured session failure', () =>
  withWorld({ env: { FAKE_UNREACHABLE_AFTER: '0' } }, async world => {
    const response = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(response.ok, false);
    assert.equal(response.sessionFailure?.kind, 'unreachable');
    assert.equal(response.sessionFailure.attempts.length, 2);
    assert.match(response.error ?? '', /failed again after a restart/);
    assert.equal(world.spawns().length, 2);
  }));

test("when the XCTest runner dies, Maestro's whole process group goes, and the next call starts fresh", () =>
  withWorld({}, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const [maestro] = world.spawns();
    const [xcodebuild] = childPids(world, 'xcodebuild');
    const [runner] = childPids(world, 'runner');
    assert.ok(maestro && xcodebuild && runner);
    await until(
      async () => (await engineStatus(world.stateDir, world.lane))?.status?.runnerPid === runner,
      3000,
      'the runner to be watched',
    );
    process.kill(runner, 'SIGKILL');
    await until(() => !alive(maestro.pid) && !alive(xcodebuild), 3000, 'Maestro and its xcodebuild to be killed');
    const next = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(next.ok, true, next.error);
    assert.match(next.text ?? '', /rebuilt/);
    assert.equal(world.spawns().length, 2);
  }));

test('run returns what changed on screen, and its passing steps become a flow that record save writes', () =>
  withWorld({ taps: { 'com.apple.settings.general': 'settings-general' } }, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.apple.Preferences\n---\n- tapOn:\n    id: com.apple.settings.general\n' },
    });
    assert.equal(response.ok, true, response.text);
    assert.match(response.text ?? '', /^Passed 1 step in [\d.]+ s\.\nScreen changed: /);
    assert.match(response.text ?? '', /\+ \[?\w*\]? ?id=About "About"|\+ .*"About"/);
    const second = await callEngine(world.target(), { op: 'run', args: { yaml: '- assertVisible: About\n' } });
    assert.equal(second.ok, true, second.text);
    const ran = calls(world, 'run').map(call => (call.args as { yaml: string }).yaml);
    assert.match(ran[1] ?? '', /^appId: com\.apple\.Preferences\n---\n/);
    const file = path.join(world.root, 'recorded.yaml');
    const saved = await callEngine(world.target(), { op: 'record', args: { action: 'save', file } });
    assert.equal(saved.ok, true, saved.text);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      'appId: com.apple.Preferences\n---\n- tapOn:\n    id: com.apple.settings.general\n- assertVisible: About\n',
    );
  }));

test("a restarted engine takes the app for YAML without a header from the lane's recorded steps", () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: '- assertVisible: General\n', appId: 'com.apple.Preferences' },
    });
    assert.equal(first.ok, true, first.text);
    await stopEngine(world.stateDir, world.lane, 8000);
    const second = await callEngine(world.target(), { op: 'run', args: { yaml: '- assertVisible: General\n' } });
    assert.equal(second.ok, true, second.text);
    assert.notEqual(second.pid, first.pid);
    const ran = calls(world, 'run').map(call => (call.args as { yaml: string }).yaml);
    assert.match(ran.at(-1) ?? '', /^appId: com\.apple\.Preferences\n---\n/);
  }));

test('a failed step comes back structured: kind, step, reached-device, the screen now and selectors to try', () =>
  withWorld({}, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: {
        yaml: 'appId: com.apple.Preferences\n---\n- assertVisible: General\n- tapOn:\n    id: missing-general\n- assertVisible: About\n',
      },
    });
    assert.equal(response.ok, false);
    const failure = response.failure;
    assert.ok(failure);
    assert.equal(failure.kind, 'selector-miss');
    assert.equal(failure.step?.index, 1);
    assert.equal(failure.step.total, 3);
    assert.equal(failure.completedSteps, 1);
    assert.equal(failure.reachedDevice, 'no');
    assert.ok(failure.suggestions.length >= 1);
    assert.match(failure.screen?.text ?? '', /General/);
    assert.match(response.text ?? '', /^Run failed \(selector-miss\) at step 2 of 3/);
    assert.equal(calls(world, 'run').length, 2, 'the flow ran one step per call and stopped at the failure');
    const shown = await callEngine(world.target(), { op: 'record', args: { action: 'show' } });
    assert.equal(shown.text, 'appId: com.apple.Preferences\n---\n- assertVisible: General\n');
  }));

test('an absence check on a nearly empty screen fails, though Maestro passed it', () =>
  withWorld({ start: 'canvas-page' }, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.apple.mobilesafari\n---\n- assertNotVisible: Row 3\n' },
    });
    assert.equal(response.ok, false, response.text);
    assert.equal(response.failure?.kind, 'assertion');
    assert.equal(response.failure.reachedDevice, 'no');
    assert.match(
      response.failure.message,
      /^Maestro passed this step, but can't prove \{ text: "Row 3" \} is absent: the read is nearly empty/,
    );
    assert.ok(response.image, 'the failure carries a screenshot of the unreadable screen');
  }));

test('an id absence passes on a nearly empty screen over a drawn backdrop, since an id exists only in the tree', () =>
  withWorld({ start: 'example-sheet' }, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: {
        yaml: 'appId: com.example.expoapp\n---\n- assertVisible:\n    id: sheet-title\n- assertNotVisible:\n    id: home-open-sheet\n',
      },
    });
    assert.equal(response.ok, true, response.text);
  }));

test('a text absence passes on a nearly empty screen when the run read the text before it went', () =>
  withWorld({ start: 'example-sheet', taps: { 'sheet-close': 'canvas-page' } }, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.example.expoapp\n---\n- tapOn:\n    id: sheet-close\n- assertNotVisible: A bottom sheet\n' },
    });
    assert.equal(response.ok, true, response.text);
  }));

const ONE_CALL_FLOW = (early: string, late: string) =>
  `appId: com.apple.mobilesafari\n---\n- assertNotVisible: ${early}\n- runFlow:\n    when:\n      platform: iOS\n    commands:\n      - tapOn:\n          id: go-canvas\n${late}- takeScreenshot: end\n`;

test('a flow run in one call has its final absence step judged, and the refusal names that step and its selector', () =>
  withWorld({ taps: { 'go-canvas': 'canvas-page' } }, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: ONE_CALL_FLOW('Bluetooth Settings', '- assertNotVisible: Row 3\n') },
    });
    assert.equal(response.ok, false, response.text);
    assert.equal(calls(world, 'run').length, 1);
    assert.equal(response.failure?.step?.index, 2);
    assert.match(response.text ?? '', /^Run failed \(assertion\) at step 3 of 4 \(assertNotVisible: Row 3\)/);
    assert.match(response.failure.message, /can't prove \{ text: "Row 3" \} is absent/);
  }));

test('a flow run in one call does not judge an absence step on a screen a later step replaced', () =>
  withWorld({ taps: { 'go-canvas': 'canvas-page' } }, async world => {
    const response = await callEngine(world.target(), { op: 'run', args: { yaml: ONE_CALL_FLOW('Row 3', '') } });
    assert.equal(response.ok, true, response.text);
  }));

test(
  'on a short page the screenshot shows the empty part is blank, so look attaches no screenshot and absence can pass',
  { skip: process.platform !== 'darwin' && 'the pixel check runs sips, which ships with macOS' },
  () =>
    withWorld({ start: 'short-page' }, async world => {
      const looked = await callEngine(world.target(), { op: 'look', args: {} });
      assert.equal(looked.ok, true, looked.error);
      assert.equal(looked.image, undefined);
      assert.doesNotMatch(looked.text ?? '', /nearly empty/);
      const response = await callEngine(world.target(), {
        op: 'run',
        args: { yaml: 'appId: com.apple.mobilesafari\n---\n- assertNotVisible: Finished\n' },
      });
      assert.equal(response.ok, true, response.text);
    }),
);

test('look on a sheet over a drawn backdrop attaches a screenshot', () =>
  withWorld({ start: 'example-sheet' }, async world => {
    const looked = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(looked.ok, true, looked.error);
    assert.ok(looked.image);
    assert.match(looked.text ?? '', /nearly empty/);
  }));

test('an absence check on a complete screen passes', () =>
  withWorld({ start: 'settings' }, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.apple.Preferences\n---\n- assertNotVisible: Bluetooth Settings\n' },
    });
    assert.equal(response.ok, true, response.text);
  }));

test('the quick form taps without settling, and the recorded flow keeps the plain step', () =>
  withWorld({}, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: {
        yaml: '- tapOn: General\n- tapOn:\n    id: com.apple.settings.general\n',
        appId: 'com.apple.Preferences',
        quick: true,
      },
    });
    assert.equal(response.ok, true, response.text);
    const sent = calls(world, 'run').map(call => (call.args as { yaml: string }).yaml);
    assert.deepEqual(sent, [
      'appId: com.apple.Preferences\n---\n- tapOn:\n    text: General\n    waitToSettleTimeoutMs: 0\n    retryTapIfNoChange: false\n',
      'appId: com.apple.Preferences\n---\n- tapOn:\n    id: com.apple.settings.general\n    waitToSettleTimeoutMs: 0\n    retryTapIfNoChange: false\n',
    ]);
    const shown = await callEngine(world.target(), { op: 'record', args: { action: 'show' } });
    assert.equal(
      shown.text,
      'appId: com.apple.Preferences\n---\n- tapOn: General\n- tapOn:\n    id: com.apple.settings.general\n',
    );
  }));

test('releasing the lane stops the engine, and its Maestro, xcodebuild and runner with it', () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true);
    const [maestro] = world.spawns();
    const [xcodebuild] = childPids(world, 'xcodebuild');
    const [runner] = childPids(world, 'runner');
    assert.ok(maestro && xcodebuild && runner);
    world.registry().release({ id: world.lane.id, token: world.lane.token }, world.lane.owner);
    const paths = enginePaths(world.stateDir, world.lane.id);
    await until(
      () => ![first.pid, maestro.pid, xcodebuild, runner].some(alive),
      8000,
      'the engine, Maestro, xcodebuild and the runner to be gone',
    );
    assert.equal(fs.existsSync(paths.socket), false);
    assert.equal(lockHolder(paths.lock), undefined);
    assert.equal(fs.existsSync(paths.work), false, "Maestro's working folder goes with the engine");
    assert.match(fs.readFileSync(paths.log, 'utf8'), /\] stopped\n/);
  }));

test("a flow's takeScreenshot is kept with the lane's logs, named in run's output, and outlives the release", () =>
  withWorld({}, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.apple.Preferences\n---\n- takeScreenshot: probe-shot\n- takeScreenshot: nested/second\n' },
    });
    assert.equal(response.ok, true, response.text);
    const paths = enginePaths(world.stateDir, world.lane.id);
    const kept = [path.join(paths.shots, 'nested', 'second.png'), path.join(paths.shots, 'probe-shot.png')];
    assert.equal(paths.shots, path.join(world.stateDir, 'lanes', world.lane.id, 'shots'));
    assert.deepEqual(response.data?.screenshots, kept);
    assert.match(
      response.text ?? '',
      new RegExp(`\nScreenshots \\(kept after release\\): ${kept.join(', ').replaceAll('.', '\\.')}$`),
    );
    const again = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.apple.Preferences\n---\n- takeScreenshot: probe-shot\n- assertVisible: General\n' },
    });
    assert.deepEqual(again.data?.screenshots, [path.join(paths.shots, 'probe-shot-2.png')], 'a repeated name keeps both');
    world.registry().release({ id: world.lane.id, token: world.lane.token }, world.lane.owner);
    await until(() => !fs.existsSync(paths.work), 8000, "Maestro's working folder to go with the engine");
    for (const file of [...kept, path.join(paths.shots, 'probe-shot-2.png')]) assert.equal(fs.existsSync(file), true, file);
  }));

test("the engine stops once the lane's owner is proven dead", () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    world.owner.kill('SIGKILL');
    await until(() => !alive(first.pid), 8000, 'the engine to stop');
    assert.match(
      fs.readFileSync(enginePaths(world.stateDir, world.lane.id).log, 'utf8'),
      /stopping: the lane's owner \(pid \d+\) is dead/,
    );
  }));

test('a request with another token is refused without reaching Maestro', () =>
  withWorld({}, async world => {
    await callEngine(world.target(), { op: 'look', args: {} });
    const before = calls(world).length;
    const forged = await callEngine(
      { ...world.target(), lane: { ...world.lane, token: 'not-the-token' } },
      { op: 'look', args: {} },
    );
    assert.equal(forged.ok, false);
    assert.match(forged.error ?? '', /this driver serves lane/);
    assert.equal(calls(world).length, before);
  }));

test('an engine for a lane that has ended exits at once, and the caller is told why', () =>
  withWorld({}, async world => {
    world.registry().release({ id: world.lane.id, token: world.lane.token }, world.lane.owner);
    await assert.rejects(callEngine(world.target(), { op: 'look', args: {} }), /exited while starting[\s\S]*is not held/);
    assert.equal(world.spawns().length, 0);
  }));

test('after an idle moment the engine knows the ticking text, so a tap reports only the counter it changed', () =>
  withWorld({ start: 'example-home', tuning: { idleSampleMs: 50 } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    await until(() => calls(world, 'inspect_screen').length >= 2, 3000, 'the idle read');
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.example.expoapp\n---\n- tapOn:\n    id: home-increment\n' },
    });
    assert.equal(response.ok, true, response.text);
    assert.match(
      response.text ?? '',
      /\nScreen changed: 1 changed\.\n~ \[text\] id=home-tap-count "Taps: 0" → \[text\] id=home-tap-count "Taps: 1"$/,
    );
  }));

test('without an idle read first, the ticking text has not been seen ticking and shows as a change', () =>
  withWorld({ start: 'example-home' }, async world => {
    const response = await callEngine(world.target(), {
      op: 'run',
      args: { yaml: 'appId: com.example.expoapp\n---\n- tapOn:\n    id: home-increment\n' },
    });
    assert.equal(response.ok, true, response.text);
    assert.match(response.text ?? '', /home-ticker/);
    assert.match(response.text ?? '', /"Taps: 1"/);
  }));

const adbLines = (world: DriverWorld) =>
  fs.existsSync(world.adbLog) ? fs.readFileSync(world.adbLog, 'utf8').split('\n').filter(Boolean) : [];

test("on Android the engine drives the claimed emulator by its adb serial, with the SDK's adb rather than the stub", () =>
  withWorld({ platform: 'android' }, async world => {
    const serial = world.lane.device?.serial ?? '';
    assert.match(serial, /^emulator-\d+$/);
    const response = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(response.ok, true, response.error);
    for (const call of calls(world)) assert.equal((call.args as { device_id: string }).device_id, serial);
    const [spawned] = world.spawns();
    const paths = enginePaths(world.stateDir, world.lane.id);
    assert.equal(spawned?.pathHead, path.join(world.toolchain.javaHome, 'bin'));
    assert.ok(
      String(spawned.path)
        .split(path.delimiter)
        .includes(path.join(String(spawned.androidHome), 'platform-tools')),
    );
    assert.equal(fs.existsSync(path.join(paths.work, 'bin', 'adb')), false, 'no adb stub for an emulator');
    const status = await engineStatus(world.stateDir, world.lane);
    assert.equal(status?.status?.device, serial);
    assert.equal(status.status.runnerPid, undefined);
  }));

test("a kill -9 of Maestro's JVM force-stops the driver it left on the emulator, and the next call works", () =>
  withWorld({ platform: 'android' }, async world => {
    const serial = world.lane.device?.serial ?? '';
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const [maestro] = world.spawns();
    assert.ok(maestro);
    process.kill(maestro.pid, 'SIGKILL');
    await until(
      () => adbLines(world).includes(`-s ${serial} shell am force-stop dev.mobile.maestro`),
      5000,
      'the force-stop on the emulator',
    );
    const next = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(next.ok, true, next.error);
    assert.match(next.text ?? '', /rebuilt/);
  }));

test('when the lane ends, the engine kills Maestro without its own shutdown and leaves the emulator alone', () =>
  withWorld({ platform: 'android' }, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    world.registry().release({ id: world.lane.id, token: world.lane.token }, world.lane.owner);
    await until(() => !alive(first.pid), 8000, 'the engine to stop');
    assert.equal(
      world.events().some(event => event.event === 'stdin-closed'),
      false,
      "Maestro's own shutdown would uninstall the driver from under the emulator's next holder",
    );
    assert.deepEqual(
      adbLines(world).filter(line => line.includes('force-stop')),
      [],
      'the engine sends nothing to a device its lane no longer holds',
    );
  }));

test('a call after the lane ended is refused before it reaches Maestro', () =>
  withWorld({ platform: 'android', tuning: { lanePollMs: 60_000 } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const before = calls(world).length;
    world.registry().release({ id: world.lane.id, token: world.lane.token }, world.lane.owner);
    const after = await callEngine(world.target(), { op: 'run', args: { yaml: 'appId: x.y\n---\n- tapOn: Gmail\n' } });
    assert.equal(after.ok, false);
    assert.match(after.error ?? '', /no longer holds emulator-\d+, so the driver stopped without acting/);
    assert.equal(calls(world).length, before);
  }));

test('calls that race an engine shutting down for an ended lane are each refused with an answer, never a reset', () =>
  withWorld({ platform: 'android', tuning: { lanePollMs: 60_000 } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    await until(() => world.registry().find(world.lane.owner, world.worktree)?.lastAction === 'look', 3000, 'the touch');
    const before = calls(world).length;
    world.registry().release({ id: world.lane.id, token: world.lane.token }, world.lane.owner);
    const answers = await Promise.allSettled(
      Array.from({ length: 40 }, () => callEngine(world.target(), { op: 'look', args: {} })),
    );
    const problems = answers.flatMap(answer =>
      answer.status === 'rejected'
        ? /exited while starting[\s\S]*is not held/.test(messageOf(answer.reason))
          ? []
          : [`rejected: ${messageOf(answer.reason)}`]
        : answer.value.ok || !/no longer holds emulator-\d+, so the driver stopped without acting/.test(answer.value.error ?? '')
          ? [`answered: ${JSON.stringify(answer.value)}`]
          : [],
    );
    assert.deepEqual(problems, []);
    assert.equal(calls(world).length, before);
  }));

test('an asked-for stop on Android lets Maestro shut its session down, then force-stops the driver', () =>
  withWorld({ platform: 'android' }, async world => {
    const serial = world.lane.device?.serial ?? '';
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    assert.equal(await stopEngine(world.stateDir, world.lane), true);
    assert.equal(
      world.events().some(event => event.event === 'stdin-closed'),
      true,
    );
    assert.ok(adbLines(world).includes(`-s ${serial} shell am force-stop dev.mobile.maestro`), adbLines(world).join('\n'));
  }));

test('a read that meets an adb transport drop ("not connected") is sent once more', () =>
  withWorld({ platform: 'android', env: { FAKE_NOT_CONNECTED_ON: '2' } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const read = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(read.ok, true, read.error);
    assert.match(read.text ?? '', /^Maestro's session was rebuilt for this call\./);
    assert.equal(world.spawns().length, 1, 'the same Maestro, whose own rebuild heals the session');
  }));

test('a flow that meets an adb transport drop is not sent again, and fails with the reason', () =>
  withWorld({ platform: 'android', env: { FAKE_NOT_CONNECTED_ON: '2' } }, async world => {
    assert.equal((await callEngine(world.target(), { op: 'look', args: {} })).ok, true);
    const run = await callEngine(world.target(), { op: 'run', args: { yaml: 'appId: x.y\n---\n- tapOn: Gmail\n' } });
    assert.equal(run.ok, false);
    assert.match(run.text ?? '', /not sent again \(unreachable\)[\s\S]*is not connected/);
    assert.equal(calls(world, 'run').length, 1);
  }));
