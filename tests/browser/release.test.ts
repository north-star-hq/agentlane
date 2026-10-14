import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_BROWSER_RELEASE, PLAYWRIGHT_RELEASE } from '../../src/browser/release.ts';

const HOSTS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

test('every supported host has a pinned build of each browser, and an agent-browser binary', () => {
  for (const build of PLAYWRIGHT_RELEASE.browsers) assert.deepEqual(Object.keys(build.archives).sort(), HOSTS, build.name);
  assert.deepEqual(Object.keys(AGENT_BROWSER_RELEASE.binaries).sort(), HOSTS);
});

test("each pinned archive is its host's file, and its executable sits where Playwright 1.64 looks for it", () => {
  const playwrightNames: Record<string, string> = {
    'darwin-arm64': 'mac-arm64',
    'darwin-x64': 'mac-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux64',
  };
  const ffmpegNames: Record<string, string> = {
    'darwin-arm64': 'ffmpeg-mac-arm64',
    'darwin-x64': 'ffmpeg-mac',
    'linux-arm64': 'ffmpeg-linux-arm64',
    'linux-x64': 'ffmpeg-linux',
  };
  for (const build of PLAYWRIGHT_RELEASE.browsers) {
    for (const host of HOSTS) {
      const pin = build.archives[host];
      assert.ok(pin, `${build.name} ${host}`);
      const file = path.basename(pin.url, '.zip');
      assert.match(pin.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(pin.size) && pin.size > 1_000_000, `${build.name} ${host} size`);
      if (build.name === 'ffmpeg') {
        assert.equal(file, ffmpegNames[host]);
        assert.deepEqual(pin.executable, [host.startsWith('darwin') ? 'ffmpeg-mac' : 'ffmpeg-linux']);
        continue;
      }
      const name = playwrightNames[host] ?? '';
      const prefix = build.name === 'chromium' ? 'chrome' : 'chrome-headless-shell';
      assert.equal(file, `${prefix}-${name}`);
      assert.match(pin.url, new RegExp(`/builds/cft/156\\.0\\.8078\\.4/${name}/${file}\\.zip$`));
      assert.equal(pin.executable[0], file);
      assert.equal(
        pin.executable.at(-1),
        build.name === 'chromium'
          ? host.startsWith('darwin')
            ? 'Google Chrome for Testing'
            : 'chrome'
          : 'chrome-headless-shell',
      );
    }
  }
});
