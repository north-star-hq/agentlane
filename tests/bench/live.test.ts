import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserCommand, relaunchYaml } from '../../src/bench/live.ts';

test("the bench's relaunch puts the example app on its own Metro and API on either platform", () => {
  assert.equal(
    relaunchYaml(41118, 41218),
    "- launchApp:\n    stopApp: true\n    arguments:\n      '--initialUrl': http://localhost:41118\n      apiBaseUrl: http://localhost:41218\n",
  );
  assert.equal(
    relaunchYaml(41118, 41218, 'android'),
    '- launchApp:\n    stopApp: true\n    arguments:\n      apiBaseUrl: http://localhost:41218\n- extendedWaitUntil:\n    visible: DEVELOPMENT SERVERS\n    timeout: 15000\n- openLink: expoexample://expo-development-client/?url=http%3A%2F%2Flocalhost%3A41118\n',
  );
  assert.equal(
    relaunchYaml(41118, null, 'android'),
    '- launchApp:\n    stopApp: true\n- extendedWaitUntil:\n    visible: DEVELOPMENT SERVERS\n    timeout: 15000\n- openLink: expoexample://expo-development-client/?url=http%3A%2F%2Flocalhost%3A41118\n',
  );
});

test("the bench's browser click and flow are the playwright-cli calls an agent makes under exec", () => {
  assert.deepEqual(browserCommand('click', 'unused'), ['exec', '--', 'playwright-cli', 'click', "getByTestId('sort-shortest')"]);
  const flow = browserCommand('flow', 'Bench place "1"');
  assert.deepEqual(flow.slice(0, 4), ['exec', '--', 'playwright-cli', 'run-code']);
  assert.equal(
    flow[4],
    [
      'async page => {',
      `  await page.getByTestId('add-name').fill("Bench place \\"1\\"");`,
      "  await page.getByTestId('add-submit').click();",
      `  await page.getByTestId('places').getByText("Bench place \\"1\\"", { exact: true }).waitFor();`,
      '}',
    ].join('\n'),
  );
});
