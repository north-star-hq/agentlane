import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { agentBrowserShim, playwrightConfig, playwrightShim } from '../../src/browser/env.ts';
import { browserPaths } from '../../src/browser/paths.ts';
import { SUN_PATH_LIMIT } from '../../src/driver/paths.ts';
import { tempDir } from '../support/fakes.ts';

function shim(content: string): string {
  const dir = tempDir('browser-shim');
  const file = path.join(dir, 'shim');
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

function run(file: string, ...args: string[]) {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

test("the lane's playwright-cli runs the pinned CLI with every argument, and refuses kill-all and install-browser", () => {
  const file = shim(playwrightShim(['/bin/echo', 'pinned cli'], 'abcd1234'));
  assert.deepEqual(run(file, '-s=x', 'click', 'e3'), { code: 0, out: 'pinned cli -s=x click e3', err: '' });
  const killed = run(file, '--browser', 'chrome', 'kill-all');
  assert.equal(killed.code, 2);
  assert.match(
    killed.err,
    /kill-all stops every Playwright browser on this Mac, other lanes' too\. Run playwright-cli close-all/,
  );
  const install = run(file, 'install-browser', 'chromium');
  assert.equal(install.code, 2);
  assert.match(install.err, /agentlane browser install installs them/);
});

test("the lane's agent-browser refuses install and upgrade, and finds the pinned ffmpeg first on PATH", () => {
  const ffmpeg = tempDir('ffmpeg');
  fs.writeFileSync(path.join(ffmpeg, 'ffmpeg'), '#!/bin/sh\necho pinned ffmpeg\n', { mode: 0o755 });
  const file = shim(agentBrowserShim(['/bin/sh', '-c', 'ffmpeg; echo "$@"', 'agent-browser'], ffmpeg));
  assert.deepEqual(run(file, 'open', 'http://localhost:1/'), {
    code: 0,
    out: 'pinned ffmpeg\nopen http://localhost:1/',
    err: '',
  });
  for (const verb of ['install', 'upgrade']) {
    const refused = run(file, verb);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /pinned and installed by agentlane \(node_modules\/\.bin\/agentlane browser install\)/);
  }
});

test("playwright-cli's global config gives the browser the lane's debugging port", () => {
  const config = JSON.parse(
    playwrightConfig({ driver: 'playwright', session: 's', debugPort: 41_402, streamPort: null, createdAt: 0 }),
  ) as {
    browser: { launchOptions: { args: string[] } };
  };
  assert.deepEqual(config.browser.launchOptions.args, ['--remote-debugging-port=41402']);
});

test("agent-browser's socket folder moves to a short per-user one when the lane folder's path would be too long for a socket", () => {
  const short = browserPaths('/s', 'abcd1234', 'agentlane-abcd1234');
  assert.equal(short.agentBrowserSockets, '/s/lanes/abcd1234/browser/ab');
  const deep = `/${'d'.repeat(90)}`;
  const temp = '/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyy/T';
  const long = browserPaths(deep, 'abcd1234', 'agentlane-abcd1234', () => temp);
  assert.ok(long.agentBrowserSockets.startsWith(`${temp}/ab-`), long.agentBrowserSockets);
  assert.ok(Buffer.byteLength(path.join(long.agentBrowserSockets, 'agentlane-abcd1234.sock')) <= SUN_PATH_LIMIT);
  const other = browserPaths(deep, 'ffff0000', 'agentlane-ffff0000', () => temp);
  assert.notEqual(other.agentBrowserSockets, long.agentBrowserSockets, 'two lanes share a socket folder');
  assert.equal(long.profile, `${deep}/lanes/abcd1234/browser/profile`);
  assert.equal(long.evidence, `${deep}/lanes/abcd1234/evidence`);
});
