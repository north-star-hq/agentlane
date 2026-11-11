import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  browsersPath,
  describeInstallState,
  ensureBrowserDriver,
  installState,
  type BrowserInstallOptions,
  type Fetcher,
} from '../../src/browser/install.ts';
import type { AgentBrowserRelease, BrowserBuild, PlaywrightRelease } from '../../src/browser/release.ts';
import { DriverError } from '../../src/driver/errors.ts';
import { tempDir } from '../support/fakes.ts';
import { makeZip } from '../support/zip.ts';

const HOST = 'test-host';

function tgz(root: string, name: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(root, 'pkg-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'package', file)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package', file), content, { mode: 0o755 });
  }
  const out = path.join(root, 'served', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  assert.equal(spawnSync('tar', ['-czf', out, '-C', dir, 'package']).status, 0);
  return out;
}

function zip(root: string, name: string, executable: string): string {
  const out = path.join(root, 'served', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, makeZip([{ name: executable, data: '#!/bin/sh\necho browser\n', mode: 0o100755 }]));
  return out;
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha512 = (file: string) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

/** The browsers a playwright-core pins, in the layout of its own `browsers.json`. */
function browsersJson(chromium: string, ffmpeg: string): string {
  return JSON.stringify({
    browsers: [
      { name: 'chromium', revision: chromium, installByDefault: true },
      { name: 'chromium-headless-shell', revision: chromium, installByDefault: true },
      { name: 'ffmpeg', revision: ffmpeg, installByDefault: true, revisionOverrides: { 'mac12-arm64': '1' } },
    ],
  });
}

interface Served {
  root: string;
  env: NodeJS.ProcessEnv;
  playwright: PlaywrightRelease;
  agentBrowser: AgentBrowserRelease;
  fetched: string[];
  fetch: Fetcher;
  options: (over?: Partial<BrowserInstallOptions>) => BrowserInstallOptions;
}

function served(): Served {
  const root = tempDir('browser-install');
  const core = tgz(root, 'playwright-core-9.9.9.tgz', {
    'lib/tools/cli-client/cli.js': 'console.log("cli")\n',
    'browsers.json': browsersJson('1', '2'),
  });
  const ab = tgz(root, 'agent-browser-1.1.1.tgz', { 'bin/agent-browser-test-host': '#!/bin/sh\n' });
  const chromium = zip(root, 'chrome.zip', 'chrome/chrome');
  const shell = zip(root, 'shell.zip', 'shell/shell');
  const ffmpeg = zip(root, 'ffmpeg.zip', 'ffmpeg-mac');
  const archive = (file: string, executable: string[]) => ({
    url: `https://cdn.example/${path.basename(file)}`,
    size: fs.statSync(file).size,
    sha256: sha256(file),
    executable,
  });
  const playwright: PlaywrightRelease = {
    version: '9.9.9',
    core: {
      name: 'playwright-core',
      version: '9.9.9',
      tarball: `https://registry.example/${path.basename(core)}`,
      sha512: sha512(core),
    },
    browsers: [
      { name: 'chromium', revision: '1', archives: { [HOST]: archive(chromium, ['chrome', 'chrome']) } },
      { name: 'chromium-headless-shell', revision: '1', archives: { [HOST]: archive(shell, ['shell', 'shell']) } },
      { name: 'ffmpeg', revision: '2', archives: { [HOST]: archive(ffmpeg, ['ffmpeg-mac']) } },
    ],
  };
  const agentBrowser: AgentBrowserRelease = {
    version: '1.1.1',
    package: {
      name: 'agent-browser',
      version: '1.1.1',
      tarball: `https://registry.example/${path.basename(ab)}`,
      sha512: sha512(ab),
    },
    binaries: { [HOST]: 'bin/agent-browser-test-host' },
  };
  const home = path.join(root, 'home');
  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    AGENTLANE_STATE_DIR: path.join(home, '.local', 'state', 'agentlane'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    PATH: process.env.PATH,
  };
  const fetched: string[] = [];
  const fetch: Fetcher = (url, file) => {
    fetched.push(path.basename(url));
    fs.copyFileSync(path.join(root, 'served', path.basename(url)), file);
    return Promise.resolve();
  };
  return {
    root,
    env,
    playwright,
    agentBrowser,
    fetched,
    fetch,
    options: (over = {}) => ({ env, playwright, agentBrowser, host: HOST, fetch, lockWaitMs: 20_000, ...over }),
  };
}

const releases = (s: Served) => ({ playwright: s.playwright, agentBrowser: s.agentBrowser, host: HOST });

test("the pinned driver and its browsers install into the toolkit's data folder in Playwright's layout, checked by hash, once", async () => {
  const s = served();
  assert.equal(installState(s.env, 'playwright', releases(s)).kind, 'missing');
  const installed = await ensureBrowserDriver('playwright', s.options());
  const base = browsersPath(s.env);
  assert.equal(base, path.join(s.env.HOME ?? '', '.local', 'share', 'agentlane', 'playwright', 'browsers'));
  assert.equal(installed.browsersPath, base);
  for (const folder of ['chromium-1', 'chromium_headless_shell-1', 'ffmpeg-2']) {
    assert.ok(fs.existsSync(path.join(base, folder, 'INSTALLATION_COMPLETE')), folder);
  }
  assert.equal(installed.chrome, path.join(base, 'chromium-1', 'chrome', 'chrome'));
  assert.equal(installed.ffmpeg, path.join(base, 'ffmpeg-2', 'ffmpeg-mac'));
  assert.equal(fs.statSync(installed.chrome).mode & 0o111, 0o111);
  assert.equal(installed.headlessShell, path.join(base, 'chromium_headless_shell-1', 'shell', 'shell'));
  assert.equal(fs.statSync(installed.headlessShell).mode & 0o111, 0o111);
  const [link] = fs.readdirSync(path.join(base, '.links'));
  assert.equal(fs.readFileSync(path.join(base, '.links', link ?? ''), 'utf8'), installed.playwrightCore);
  assert.deepEqual(installed.cli, [
    process.execPath,
    path.join(installed.playwrightCore, 'lib', 'tools', 'cli-client', 'cli.js'),
  ]);
  assert.equal(installState(s.env, 'playwright', releases(s)).kind, 'installed');
  assert.match(
    describeInstallState('playwright', installState(s.env, 'playwright', releases(s))),
    /^playwright 9\.9\.9, pinned, with Chrome for Testing in /,
  );

  const fetchedOnce = s.fetched.length;
  const ab = await ensureBrowserDriver('agent-browser', s.options());
  assert.equal(ab.version, '1.1.1');
  assert.deepEqual(ab.cli, [
    path.join(
      s.env.HOME ?? '',
      '.local',
      'share',
      'agentlane',
      'agent-browser',
      '1.1.1',
      'package',
      'bin',
      'agent-browser-test-host',
    ),
  ]);
  assert.equal(ab.headlessShell, installed.headlessShell, 'agent-browser runs its own Chrome, not the pinned one');
  assert.deepEqual(s.fetched.slice(fetchedOnce), ['agent-browser-1.1.1.tgz'], 'the second driver downloaded the browsers again');
});

test('a download that does not match its pin is refused and leaves nothing installed', async () => {
  const s = served();
  const flipped: Fetcher = (url, file) => {
    const data = fs.readFileSync(path.join(s.root, 'served', path.basename(url)));
    if (url.endsWith('chrome.zip')) data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
    fs.writeFileSync(file, data);
    return Promise.resolve();
  };
  await assert.rejects(ensureBrowserDriver('playwright', s.options({ fetch: flipped })), (error: unknown) => {
    assert.ok(error instanceof DriverError, String(error));
    assert.match(
      error.message,
      /chrome\.zip hashes to sha256 [0-9a-f]{64}, but agentlane pins [0-9a-f]{64}; refusing to install chromium 1/,
    );
    return true;
  });
  assert.equal(fs.existsSync(path.join(browsersPath(s.env), 'chromium-1')), false);
  const short: Fetcher = (url, file) => {
    const data = fs.readFileSync(path.join(s.root, 'served', path.basename(url)));
    fs.writeFileSync(file, url.endsWith('chrome.zip') ? data.subarray(0, 10) : data);
    return Promise.resolve();
  };
  await assert.rejects(
    ensureBrowserDriver('playwright', s.options({ fetch: short })),
    (error: unknown) =>
      error instanceof DriverError &&
      error.message.includes('downloading https://cdn.example/chrome.zip failed after 4 attempts'),
  );
  assert.equal(fs.existsSync(path.join(browsersPath(s.env), 'chromium-1')), false);
  const fresh = served();
  fs.appendFileSync(path.join(fresh.root, 'served', 'playwright-core-9.9.9.tgz'), '\0');
  await assert.rejects(
    ensureBrowserDriver('playwright', fresh.options()),
    /playwright-core-9\.9\.9\.tgz hashes to sha512 .* but agentlane pins/,
  );
  assert.equal(installState(fresh.env, 'playwright', releases(fresh)).kind, 'missing');
});

test('an install from a folder of downloaded archives checks them like downloads', async () => {
  const s = served();
  const installed = await ensureBrowserDriver(
    'playwright',
    s.options({ from: path.join(s.root, 'served'), fetch: () => Promise.reject(new Error('no network')) }),
  );
  assert.equal(installed.version, '9.9.9');
  await assert.rejects(
    ensureBrowserDriver('agent-browser', s.options({ from: path.join(s.root, 'nowhere') })),
    /agent-browser-1\.1\.1\.tgz is missing/,
  );
});

test('a browser folder something else put there, or a different version, reads as a mismatch naming the pin', async () => {
  const s = served();
  await ensureBrowserDriver('playwright', s.options());
  const chromium = path.join(browsersPath(s.env), 'chromium-1');
  fs.writeFileSync(path.join(chromium, '.agentlane-installed'), JSON.stringify({ version: '1', hash: 'other', installedAt: '' }));
  const state = installState(s.env, 'playwright', releases(s));
  assert.equal(state.kind, 'mismatch');
  assert.match(
    describeInstallState('playwright', state),
    /does not match its pin: .*chromium-1 was not installed from the pinned chrome\.zip/,
  );
  const repaired = await ensureBrowserDriver('playwright', s.options());
  assert.equal(repaired.chrome, path.join(chromium, 'chrome', 'chrome'));
  assert.equal(installState(s.env, 'playwright', releases(s)).kind, 'installed');
  const newer = { ...s.playwright, version: '9.9.10', core: { ...s.playwright.core, version: '9.9.10' } };
  assert.equal(installState(s.env, 'playwright', { ...releases(s), playwright: newer }).kind, 'missing');
});

test('two installs at once, in two processes, take turns on the lock, and the second finds the first one’s work done', async () => {
  const s = served();
  const setup = path.join(s.root, 'setup.json');
  const log = path.join(s.root, 'install.log');
  fs.writeFileSync(
    setup,
    JSON.stringify({
      env: s.env,
      playwright: s.playwright,
      agentBrowser: s.agentBrowser,
      host: HOST,
      served: path.join(s.root, 'served'),
    }),
  );
  const worker = path.join(import.meta.dirname, 'install-worker.ts');
  const run = () =>
    new Promise<number | null>(resolve => {
      spawn(process.execPath, [worker, setup, log], { stdio: 'inherit' }).once('exit', resolve);
    });
  assert.deepEqual(await Promise.all([run(), run()]), [0, 0]);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.filter(l => l.endsWith('fetch chrome.zip')).length, 1, lines.join('\n'));
  assert.equal(lines.filter(l => l.includes(' done ')).length, 2, lines.join('\n'));
  assert.ok(
    lines.some(l => /waiting for pid \d+, which is installing the browser drivers$/.test(l)),
    lines.join('\n'),
  );
});

test('a host with no pinned build is told to bring its own browsers', async () => {
  const s = served();
  await assert.rejects(
    ensureBrowserDriver('playwright', s.options({ host: 'plan9-mips' })),
    /pins no chromium build for plan9-mips/,
  );
});

function later(
  s: Served,
  version: string,
  revision: string,
): { playwright: PlaywrightRelease; agentBrowser: AgentBrowserRelease } {
  const core = tgz(s.root, `playwright-core-${version}.tgz`, {
    'lib/tools/cli-client/cli.js': 'console.log("cli")\n',
    'browsers.json': browsersJson(revision, revision),
  });
  const ab = tgz(s.root, `agent-browser-${version}.tgz`, { 'bin/agent-browser-test-host': '#!/bin/sh\n' });
  const archive = (file: string, executable: string[]) => ({
    url: `https://cdn.example/${path.basename(file)}`,
    size: fs.statSync(file).size,
    sha256: sha256(file),
    executable,
  });
  const build = (name: BrowserBuild['name'], file: string, executable: string[]): BrowserBuild => ({
    name,
    revision,
    archives: { [HOST]: archive(zip(s.root, file, executable.join('/')), executable) },
  });
  return {
    playwright: {
      version,
      core: {
        name: 'playwright-core',
        version,
        tarball: `https://registry.example/${path.basename(core)}`,
        sha512: sha512(core),
      },
      browsers: [
        build('chromium', `chrome-${revision}.zip`, ['chrome', 'chrome']),
        build('chromium-headless-shell', `shell-${revision}.zip`, ['shell', 'shell']),
        build('ffmpeg', `ffmpeg-${revision}.zip`, ['ffmpeg-mac']),
      ],
    },
    agentBrowser: {
      ...s.agentBrowser,
      version,
      package: { name: 'agent-browser', version, tarball: `https://registry.example/${path.basename(ab)}`, sha512: sha512(ab) },
    },
  };
}

const nobodyRunning = () => [];

function folders(s: Served): string[] {
  const data = path.join(s.env.HOME ?? '', '.local', 'share', 'agentlane');
  return ['playwright', 'agent-browser', path.join('playwright', 'browsers')].flatMap(parent =>
    fs
      .readdirSync(path.join(data, parent))
      .filter(name => !name.startsWith('.') && name !== 'browsers')
      .map(name => path.join(parent, name)),
  );
}

test('installing and checking newer pins removes the older driver packages and browsers, and the newer ones run', async () => {
  const s = served();
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  const next = later(s, '9.10.0', '3');
  const lines: string[] = [];
  const b = await ensureBrowserDriver(
    'agent-browser',
    s.options({ ...next, commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  assert.deepEqual(folders(s).sort(), [
    path.join('agent-browser', '9.10.0'),
    path.join('playwright', '9.10.0'),
    path.join('playwright', 'browsers', 'chromium-3'),
    path.join('playwright', 'browsers', 'chromium_headless_shell-3'),
    path.join('playwright', 'browsers', 'ffmpeg-3'),
  ]);
  assert.ok(lines.includes(`removed ${path.dirname(a.playwrightCore)}, which this version supersedes`), lines.join('\n'));
  const links = fs.readdirSync(path.join(b.browsersPath, '.links'));
  assert.deepEqual(
    links.map(link => fs.readFileSync(path.join(b.browsersPath, '.links', link), 'utf8')),
    [b.playwrightCore],
  );
  assert.equal(spawnSync(b.chrome, { encoding: 'utf8' }).stdout.trim(), 'browser');
  assert.equal(installState(s.env, 'agent-browser', { ...next, host: HOST }).kind, 'installed');
  assert.equal(installState(s.env, 'agent-browser', releases(s)).kind, 'missing');
});

test('a failed install of newer pins leaves the older driver and browsers installed', async () => {
  const s = served();
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  const next = later(s, '9.10.0', '3');
  const flipped: Fetcher = (url, file) => {
    const data = fs.readFileSync(path.join(s.root, 'served', path.basename(url)));
    if (url.endsWith('ffmpeg-3.zip')) data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
    fs.writeFileSync(file, data);
    return Promise.resolve();
  };
  await assert.rejects(
    ensureBrowserDriver('agent-browser', s.options({ ...next, fetch: flipped, commandLines: nobodyRunning })),
    /refusing to install ffmpeg 3/,
  );
  const state = installState(s.env, 'agent-browser', releases(s));
  assert.deepEqual(state, { kind: 'installed', driver: a });
  assert.equal(spawnSync(a.chrome, { encoding: 'utf8' }).stdout.trim(), 'browser');
});

test('newer pins keep a browser a running process uses, and folders the toolkit did not install', async () => {
  const s = served();
  const a = await ensureBrowserDriver('playwright', s.options({ commandLines: nobodyRunning }));
  const foreign = path.join(a.browsersPath, 'chromium-0');
  fs.mkdirSync(foreign);
  const next = later(s, '9.10.0', '3');
  const running = `${a.chrome} --headless --user-data-dir=/tmp/profile`;
  const lines: string[] = [];
  await ensureBrowserDriver('playwright', s.options({ ...next, commandLines: () => [running], log: line => lines.push(line) }));
  assert.ok(fs.existsSync(a.chrome), lines.join('\n'));
  assert.ok(fs.existsSync(foreign));
  assert.ok(lines.includes(`kept ${path.join(a.browsersPath, 'chromium-1')}, which a running process uses`), lines.join('\n'));
  assert.equal(fs.existsSync(path.join(a.browsersPath, 'ffmpeg-2')), false);
  assert.equal(fs.existsSync(path.dirname(a.playwrightCore)), false);
});

test('an older playwright-core kept by a running daemon keeps the browsers it pins, and an older agent-browser keeps them too', async () => {
  for (const driver of ['playwright', 'agent-browser'] as const) {
    const s = served();
    const a = await ensureBrowserDriver(driver, s.options({ commandLines: nobodyRunning }));
    const daemon =
      driver === 'playwright'
        ? `node ${path.join(a.playwrightCore, 'lib', 'tools', 'cli-client', 'cli.js')} daemon --session lane`
        : `${a.cli[0] ?? ''} --session lane`;
    const lines: string[] = [];
    await ensureBrowserDriver(
      driver,
      s.options({ ...later(s, '9.10.0', '3'), commandLines: () => [daemon], log: line => lines.push(line) }),
    );
    assert.ok(fs.existsSync(a.chrome), lines.join('\n'));
    assert.ok(fs.existsSync(a.headlessShell), lines.join('\n'));
    assert.ok(fs.existsSync(a.ffmpeg), lines.join('\n'));
    if (driver === 'playwright') assert.deepEqual(installState(s.env, driver, releases(s)), { kind: 'installed', driver: a });
    assert.ok(lines.includes(`kept ${path.join(a.browsersPath, 'chromium-1')}, which a kept version runs`), lines.join('\n'));
  }
});

test('a newer playwright-core keeps the browsers it pins from an install of older pins', async () => {
  const s = served();
  const next = later(s, '9.10.0', '3');
  const b = await ensureBrowserDriver('playwright', s.options({ ...next, commandLines: nobodyRunning }));
  const a = await ensureBrowserDriver('playwright', s.options({ commandLines: nobodyRunning }));
  assert.equal(installState(s.env, 'playwright', { ...next, host: HOST }).kind, 'installed');
  assert.ok(fs.existsSync(b.chrome));
  assert.ok(fs.existsSync(a.chrome));
});
