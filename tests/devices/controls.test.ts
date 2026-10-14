import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createXcrunControls, isPrivacyService } from '../../src/devices/controls.ts';
import { DeviceCommandError, type Exec } from '../../src/devices/xcrun.ts';

const UDID = 'FC2D4835-7AE5-4CEC-B354-DFE87A10A760';

function scripted(outputs: Record<string, string> = {}, failing = new Set<string>()) {
  const calls: { command: string; args: readonly string[]; input: string | undefined }[] = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args, input: options?.input });
    const key = args.slice(0, 2).join(' ');
    if (failing.has(key)) return Promise.resolve({ code: 1, stdout: '', stderr: 'boom' });
    return Promise.resolve({ code: 0, stdout: outputs[key] ?? '', stderr: '' });
  };
  return { exec, calls };
}

test('each control is one simctl call on the given simulator, with stdin where simctl reads it', async () => {
  const { exec, calls } = scripted({ 'simctl pbpaste': 'hello' });
  const controls = createXcrunControls({ exec });
  await controls.clearLocation(UDID);
  await controls.privacy(UDID, 'grant', 'photos', 'com.example.expoapp');
  await controls.privacy(UDID, 'reset', 'all');
  await controls.push(UDID, 'com.example.expoapp', '{"aps":{"alert":"hi"}}');
  await controls.writeClipboard(UDID, 'hello');
  assert.equal(await controls.readClipboard(UDID), 'hello');
  assert.deepEqual(
    calls.map(call => [call.command, ...call.args].join(' ')),
    [
      `xcrun simctl location ${UDID} clear`,
      `xcrun simctl privacy ${UDID} grant photos com.example.expoapp`,
      `xcrun simctl privacy ${UDID} reset all`,
      `xcrun simctl push ${UDID} com.example.expoapp -`,
      `xcrun simctl pbcopy ${UDID}`,
      `xcrun simctl pbpaste ${UDID}`,
    ],
  );
  assert.equal(calls[3]?.input, '{"aps":{"alert":"hi"}}');
  assert.equal(calls[4]?.input, 'hello');
});

test('a failing control throws with the command and its output', async () => {
  const { exec } = scripted({}, new Set(['simctl privacy']));
  await assert.rejects(createXcrunControls({ exec }).privacy(UDID, 'revoke', 'camera' as never, 'x.y'), (error: unknown) => {
    assert.ok(error instanceof DeviceCommandError);
    assert.match(error.message, /privacy .* exited 1: boom/);
    return true;
  });
});

test('privacy services are the ones simctl knows', () => {
  assert.equal(isPrivacyService('location-always'), true);
  assert.equal(isPrivacyService('camera'), false);
});
