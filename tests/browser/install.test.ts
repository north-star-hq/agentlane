import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { browserVariables, writeDriverFiles } from '../../src/browser/env.ts';
import {
  browsersPath,
  describeInstallState,
  ensureBrowserDriver,
  installState,
  type BrowserInstallOptions,
  type Fetcher,
  type InstalledDriver,
} from '../../src/browser/install.ts';
import { browserPaths, type BrowserPaths } from '../../src/browser/paths.ts';
import type { AgentBrowserRelease, BrowserBuild, PlaywrightRelease } from '../../src/browser/release.ts';
import { DriverError } from '../../src/driver/errors.ts';
import type { CommandLines } from '../../src/driver/superseded.ts';
import { FORMER } from '../../src/name.ts';
import { shellQuote } from '../../src/registry/format.ts';
import { Store } from '../../src/registry/store.ts';
import { runningCommands, tempDir } from '../support/fakes.ts';
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
  pins = browsersJson(revision, revision),
): { playwright: PlaywrightRelease; agentBrowser: AgentBrowserRelease } {
  const core = tgz(s.root, `playwright-core-${version}.tgz`, {
    'lib/tools/cli-client/cli.js': 'console.log("cli")\n',
    'browsers.json': pins,
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
  await ensureBrowserDriver(
    'playwright',
    s.options({ ...next, commandLines: runningCommands(running), log: line => lines.push(line) }),
  );
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
      s.options({ ...later(s, '9.10.0', '3'), commandLines: runningCommands(daemon), log: line => lines.push(line) }),
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
  const first = await ensureBrowserDriver('playwright', s.options({ ...later(s, '9.8.0', '0'), commandLines: nobodyRunning }));
  const pins = JSON.stringify({
    browsers: [
      { name: 'chromium', revision: '3', installByDefault: true, revisionOverrides: { 'mac-test': '0' } },
      { name: 'chromium-headless-shell', revision: '3', installByDefault: true },
      { name: 'ffmpeg', revision: '3', installByDefault: true },
    ],
  });
  const next = later(s, '9.10.0', '3', pins);
  const b = await ensureBrowserDriver(
    'playwright',
    s.options({ ...next, commandLines: runningCommands(`node ${first.cli[1] ?? ''}`) }),
  );
  assert.ok(fs.existsSync(first.chrome));
  const lines: string[] = [];
  const a = await ensureBrowserDriver('playwright', s.options({ commandLines: nobodyRunning, log: line => lines.push(line) }));
  assert.equal(installState(s.env, 'playwright', { ...next, host: HOST }).kind, 'installed');
  assert.ok(fs.existsSync(b.chrome));
  assert.ok(fs.existsSync(a.chrome));
  assert.ok(fs.existsSync(first.chrome), lines.join('\n'));
  assert.equal(fs.existsSync(first.headlessShell), false, lines.join('\n'));
  assert.ok(
    lines.includes(`removed ${path.dirname(path.dirname(first.headlessShell))}, which this version supersedes`),
    lines.join('\n'),
  );
});

/** A lane recorded in the registry in `dir` with the browser files `up` writes for `install`, and the lane's variables. */
function laneUp(
  s: Served,
  dir: string,
  id: string,
  driver: 'playwright' | 'agent-browser',
  install: InstalledDriver,
): { paths: BrowserPaths; vars: Record<string, string> } {
  const store = Store.open(dir, 5000);
  try {
    store.write(() => {
      store.db
        .prepare(
          `INSERT INTO claims (id, token, owner_key, owner_kind, owner_pid, owner_start, owner_session, owner_thread,
             project_root, worktree, created_at, last_used_at, last_action)
           VALUES (?, 'token', ?, 'session', NULL, NULL, 's', NULL, '/w', '/w', 0, 0, 'up')`,
        )
        .run(id, `owner-${id}`);
    });
  } finally {
    store.close();
  }
  const browser = { driver, session: `lane-${id}`, debugPort: 9333, streamPort: null, createdAt: 0 };
  const temp = path.join(s.root, 'tmp');
  const paths = browserPaths(dir, id, browser.session, () => temp);
  assert.ok(!path.relative(s.root, paths.agentBrowserSockets).startsWith('..'), paths.agentBrowserSockets);
  const setting = { browser, paths, install, headed: false, url: null };
  writeDriverFiles(setting, id);
  return { paths, vars: browserVariables(setting, '/usr/bin:/bin') };
}

/**
 * What 0.4.1's `writeDriverFiles` writes over an agent-browser lane's files: its shim, which names no browser, and the
 * ffmpeg link. It never writes or removes `bin/.browsers`.
 */
function write041(paths: BrowserPaths, install: InstalledDriver): void {
  fs.mkdirSync(paths.bin, { recursive: true });
  const ffmpegDir = path.join(paths.dir, 'ffmpeg');
  fs.mkdirSync(ffmpegDir, { recursive: true });
  fs.rmSync(path.join(ffmpegDir, 'ffmpeg'), { force: true });
  fs.symlinkSync(install.ffmpeg, path.join(ffmpegDir, 'ffmpeg'));
  const shim = `#!/bin/sh
# agentlane: agent-browser, the toolkit's pinned build, on the toolkit's Chrome for Testing.
case "$1" in
  install|upgrade)
    echo "agentlane: agent-browser and its Chrome are pinned and installed by agentlane (node_modules/.bin/agentlane browser install), so agent-browser $1 is refused here." >&2
    exit 2 ;;
esac
PATH=${shellQuote(ffmpegDir)}:"$PATH"
export PATH
exec ${install.cli.map(shellQuote).join(' ')} "$@"
`;
  fs.writeFileSync(path.join(paths.bin, 'agent-browser'), shim, { mode: 0o755 });
}

/** Turns a lane's `bin/` into what 0.4.1's `up` wrote for agent-browser: its shim alone. */
function as041(paths: BrowserPaths, install: InstalledDriver): void {
  fs.rmSync(paths.bin, { recursive: true });
  write041(paths, install);
}

test('a lane recorded in a registry whose playwright-cli names an older core keeps it and its browsers, with nothing running', async () => {
  const s = served();
  const a = await ensureBrowserDriver('playwright', s.options({ commandLines: nobodyRunning }));
  const { paths } = laneUp(s, s.env.AGENTLANE_STATE_DIR ?? '', '0a1b2c3d', 'playwright', a);
  const lines: string[] = [];
  await ensureBrowserDriver(
    'playwright',
    s.options({ ...later(s, '9.10.0', '3'), commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  assert.deepEqual(installState(s.env, 'playwright', releases(s)), { kind: 'installed', driver: a }, lines.join('\n'));
  assert.ok(lines.includes(`kept ${path.dirname(a.playwrightCore)}, which a lane that is up runs`), lines.join('\n'));
  const run = spawnSync(path.join(paths.bin, 'playwright-cli'), ['--version'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'cli');
});

test('a lane recorded in a registry whose agent-browser names an older build keeps it and its browsers, with nothing running', async () => {
  const s = served();
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  const { paths } = laneUp(s, path.join(s.env.XDG_STATE_HOME ?? '', FORMER.tool), '0a1b2c3d', 'agent-browser', a);
  const lines: string[] = [];
  await ensureBrowserDriver(
    'playwright',
    s.options({ ...later(s, '9.10.0', '3'), commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  for (const file of [a.cli[0] ?? '', a.chrome, a.headlessShell, a.ffmpeg]) {
    assert.ok(fs.existsSync(file), `${file}\n${lines.join('\n')}`);
  }
  assert.ok(
    lines.includes(`kept ${path.dirname(path.dirname(path.dirname(a.cli[0] ?? '')))}, which a lane that is up runs`),
    lines.join('\n'),
  );
  const run = spawnSync(path.join(paths.bin, 'agent-browser'), ['--version'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(spawnSync(a.headlessShell, { encoding: 'utf8' }).stdout.trim(), 'browser');
});

test('a lane recorded in a registry whose ffmpeg link points into an older ffmpeg keeps that ffmpeg', async () => {
  const s = served();
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  const { paths } = laneUp(s, s.env.AGENTLANE_STATE_DIR ?? '', '0a1b2c3d', 'agent-browser', a);
  fs.rmSync(paths.bin, { recursive: true });
  const lines: string[] = [];
  await ensureBrowserDriver(
    'agent-browser',
    s.options({ ...later(s, '9.10.0', '3'), commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  assert.ok(fs.existsSync(a.ffmpeg), lines.join('\n'));
  assert.equal(fs.existsSync(a.chrome), false, lines.join('\n'));
  assert.equal(spawnSync(path.join(paths.dir, 'ffmpeg', 'ffmpeg'), { encoding: 'utf8' }).stdout.trim(), 'browser');
});

test('an older agent-browser a process runs keeps the browsers it needs through a Playwright install of newer pins', async () => {
  const s = served();
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  const daemon = `${a.cli[0] ?? ''} --session lane`;
  const lines: string[] = [];
  await ensureBrowserDriver(
    'playwright',
    s.options({ ...later(s, '9.10.0', '3'), commandLines: runningCommands(daemon), log: line => lines.push(line) }),
  );
  assert.ok(fs.existsSync(a.cli[0] ?? ''), lines.join('\n'));
  for (const file of [a.chrome, a.headlessShell, a.ffmpeg]) assert.ok(fs.existsSync(file), `${file}\n${lines.join('\n')}`);
});

const layouts = ['this version', '0.4.1'] as const;

/** An agent-browser lane recorded in this version's layout in its registry, or in 0.4.1's in agent-env's. */
function agentBrowserLane(s: Served, layout: (typeof layouts)[number], install: InstalledDriver) {
  const dir = layout === '0.4.1' ? path.join(s.env.XDG_STATE_HOME ?? '', FORMER.tool) : (s.env.AGENTLANE_STATE_DIR ?? '');
  const lane = laneUp(s, dir, '0a1b2c3d', 'agent-browser', install);
  if (layout === '0.4.1') as041(lane.paths, install);
  return lane;
}

test('an agent-browser lane keeps the browsers it was set up with through newer Playwright pins and the same agent-browser, with nothing running', async () => {
  for (const layout of layouts) {
    for (const installing of ['playwright', 'agent-browser'] as const) {
      const s = served();
      const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
      const { vars } = agentBrowserLane(s, layout, a);
      const lines: string[] = [];
      await ensureBrowserDriver(
        installing,
        s.options({ playwright: later(s, '9.10.0', '3').playwright, commandLines: nobodyRunning, log: line => lines.push(line) }),
      );
      const why = `${layout} lane, ${installing} install\n${lines.join('\n')}`;
      const shell = vars.AGENT_BROWSER_EXECUTABLE_PATH ?? '';
      assert.equal(shell, a.headlessShell);
      assert.ok(fs.existsSync(shell), `${shell}\n${why}`);
      assert.equal(spawnSync(shell, { encoding: 'utf8' }).stdout.trim(), 'browser', why);
      for (const file of [a.chrome, a.ffmpeg]) assert.ok(fs.existsSync(file), `${file}\n${why}`);
      assert.equal(fs.existsSync(path.dirname(a.playwrightCore)), false, why);
    }
  }
});

test('a running agent-browser daemon of the current version, its browser closed, keeps every older browser through newer Playwright pins', async () => {
  for (const layout of [null, ...layouts]) {
    for (const installing of ['playwright', 'agent-browser'] as const) {
      const s = served();
      const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
      if (layout !== null) agentBrowserLane(s, layout, a);
      const daemon = `${a.cli[0] ?? ''} --session lane-0a1b2c3d`;
      const lines: string[] = [];
      await ensureBrowserDriver(
        installing,
        s.options({
          playwright: later(s, '9.10.0', '3').playwright,
          commandLines: runningCommands(daemon),
          log: line => lines.push(line),
        }),
      );
      const why = `${layout ?? 'no'} lane, ${installing} install\n${lines.join('\n')}`;
      for (const file of [a.chrome, a.headlessShell, a.ffmpeg]) assert.ok(fs.existsSync(file), `${file}\n${why}`);
      assert.ok(lines.includes(`kept ${path.join(a.browsersPath, 'chromium-1')}, which agent-browser may run`), why);
    }
  }
});

test('a lane this version writes names the browsers it was set up with in its bin, and a newer install keeps exactly those', async () => {
  const s = served();
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  const { paths } = laneUp(s, s.env.AGENTLANE_STATE_DIR ?? '', '0a1b2c3d', 'agent-browser', a);
  const files = fs.readdirSync(paths.bin).map(name => fs.readFileSync(path.join(paths.bin, name), 'utf8'));
  for (const browser of [a.headlessShell, a.chrome])
    assert.ok(
      files.some(text => text.includes(browser)),
      browser,
    );
  await ensureBrowserDriver(
    'playwright',
    s.options({ playwright: later(s, '9.8.0', '0').playwright, commandLines: nobodyRunning }),
  );
  const lines: string[] = [];
  await ensureBrowserDriver(
    'agent-browser',
    s.options({ playwright: later(s, '9.10.0', '3').playwright, commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  const browsers = path.join('playwright', 'browsers');
  assert.deepEqual(
    folders(s).sort(),
    [
      path.join('agent-browser', '1.1.1'),
      path.join('playwright', '9.10.0'),
      ...['chromium-1', 'chromium-3', 'chromium_headless_shell-1', 'chromium_headless_shell-3', 'ffmpeg-2', 'ffmpeg-3'].map(
        name => path.join(browsers, name),
      ),
    ].sort(),
    lines.join('\n'),
  );
  assert.ok(lines.includes(`kept ${path.join(a.browsersPath, 'chromium_headless_shell-1')}, which a lane that is up runs`));
});

test("a lane in 0.4.1's layout keeps every older browser beside a lane that names its own", async () => {
  const s = served();
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  agentBrowserLane(s, 'this version', a);
  const old = laneUp(s, path.join(s.env.XDG_STATE_HOME ?? '', FORMER.tool), '1b2c3d4e', 'agent-browser', a);
  as041(old.paths, a);
  const oldest = await ensureBrowserDriver(
    'playwright',
    s.options({ playwright: later(s, '9.8.0', '0').playwright, commandLines: nobodyRunning }),
  );
  const lines: string[] = [];
  await ensureBrowserDriver(
    'agent-browser',
    s.options({ playwright: later(s, '9.10.0', '3').playwright, commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  for (const file of [oldest.chrome, oldest.headlessShell, oldest.ffmpeg])
    assert.ok(fs.existsSync(file), `${file}\n${lines.join('\n')}`);
});

test("a file in a lane's bin that reaches an older core through two links keeps it", async () => {
  const s = served();
  const a = await ensureBrowserDriver('playwright', s.options({ commandLines: nobodyRunning }));
  const { paths } = laneUp(s, s.env.AGENTLANE_STATE_DIR ?? '', '0a1b2c3d', 'playwright', a);
  fs.rmSync(paths.bin, { recursive: true });
  fs.mkdirSync(paths.bin);
  const hop = path.join(paths.dir, 'hop');
  fs.symlinkSync(a.cli[1] ?? '', hop);
  fs.symlinkSync(path.relative(paths.bin, hop), path.join(paths.bin, 'playwright-cli'));
  const lines: string[] = [];
  await ensureBrowserDriver(
    'playwright',
    s.options({ ...later(s, '9.10.0', '3'), commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  assert.ok(lines.includes(`kept ${path.dirname(a.playwrightCore)}, which a lane that is up runs`), lines.join('\n'));
  assert.ok(fs.existsSync(a.cli[1] ?? ''));
});

const registries = {
  "this version's": (s: Served) => s.env.AGENTLANE_STATE_DIR ?? '',
  "0.2.x's": (s: Served) => path.join(s.env.XDG_STATE_HOME ?? '', FORMER.tool),
};

test("a lane this version set up keeps the browsers its agent-browser runs once 0.4.1 rewrites that wrapper beside this version's record", async () => {
  for (const [registry, dir] of Object.entries(registries)) {
    for (const installing of ['playwright', 'agent-browser'] as const) {
      const s = served();
      const b = await ensureBrowserDriver(
        'agent-browser',
        s.options({ playwright: later(s, '9.10.0', '3').playwright, commandLines: nobodyRunning }),
      );
      const { paths } = laneUp(s, dir(s), '0a1b2c3d', 'agent-browser', b);
      const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
      write041(paths, a);
      assert.ok(fs.readFileSync(path.join(paths.bin, '.browsers'), 'utf8').includes(b.headlessShell));
      const lines: string[] = [];
      await ensureBrowserDriver(
        installing,
        s.options({ playwright: later(s, '9.11.0', '4').playwright, commandLines: nobodyRunning, log: line => lines.push(line) }),
      );
      const why = `${registry} registry, ${installing} install\n${lines.join('\n')}`;
      for (const file of [a.headlessShell, a.chrome, a.ffmpeg]) assert.ok(fs.existsSync(file), `${file}\n${why}`);
      assert.equal(spawnSync(a.headlessShell, { encoding: 'utf8' }).stdout.trim(), 'browser', why);
      assert.ok(
        lines.includes(`kept ${path.join(a.browsersPath, 'chromium_headless_shell-1')}, which agent-browser may run`),
        why,
      );
    }
  }
});

test("a lane under a data folder whose path has a ' keeps what its wrapper names in shell quotes", async () => {
  for (const driver of ['agent-browser', 'playwright'] as const) {
    const s = served();
    s.env.XDG_DATA_HOME = path.join(s.root, "it's", 'share');
    const a = await ensureBrowserDriver(driver, s.options({ commandLines: nobodyRunning }));
    assert.ok(
      a.cli.some(part => shellQuote(part).includes(`'\\''`)),
      a.cli.join(' '),
    );
    const lane =
      driver === 'agent-browser'
        ? agentBrowserLane(s, '0.4.1', a)
        : laneUp(s, s.env.AGENTLANE_STATE_DIR ?? '', '0a1b2c3d', 'playwright', a);
    const lines: string[] = [];
    await ensureBrowserDriver(
      'playwright',
      s.options({ playwright: later(s, '9.10.0', '3').playwright, commandLines: nobodyRunning, log: line => lines.push(line) }),
    );
    const why = `${driver} lane\n${lines.join('\n')}`;
    if (driver === 'agent-browser') {
      for (const file of [a.headlessShell, a.chrome, a.ffmpeg]) assert.ok(fs.existsSync(file), `${file}\n${why}`);
      assert.equal(spawnSync(a.headlessShell, { encoding: 'utf8' }).stdout.trim(), 'browser', why);
    } else {
      assert.ok(lines.includes(`kept ${path.dirname(a.playwrightCore)}, which a lane that is up runs`), why);
      const run = spawnSync(path.join(lane.paths.bin, 'playwright-cli'), ['--version'], { encoding: 'utf8' });
      assert.equal(run.stdout.trim(), 'cli', `${run.stderr}\n${why}`);
    }
  }
});

/** A lane's agent-browser daemon, with the environment ps shows for it: the lane's variables, or none it can read. */
function daemonOf(install: InstalledDriver, vars: Record<string, string> | undefined, shown = ''): CommandLines {
  const args = `${install.cli[0] ?? ''} --session lane-0a1b2c3d`;
  const environment = vars && Object.entries(vars).map(([name, value]) => `${name}=${value}`);
  return () => [{ args, environment: () => (environment ? `${args} ${environment.join(' ')}` : shown || undefined) }];
}

/** Pins A, then B while A's daemon runs with an environment that can't be read, so both revisions are installed. */
async function twoRevisions(s: Served): Promise<{ a: InstalledDriver; b: InstalledDriver }> {
  const a = await ensureBrowserDriver('agent-browser', s.options({ commandLines: nobodyRunning }));
  const b = await ensureBrowserDriver(
    'agent-browser',
    s.options({ playwright: later(s, '9.10.0', '3').playwright, commandLines: daemonOf(a, undefined) }),
  );
  for (const file of [a.chrome, a.headlessShell, a.ffmpeg]) assert.ok(fs.existsSync(file), file);
  return { a, b };
}

/** A lane's browser variables, for a lane recorded in this version's registry or one no registry records. */
function laneVariables(s: Served, install: InstalledDriver, recorded: boolean): Record<string, string> {
  if (recorded) return laneUp(s, s.env.AGENTLANE_STATE_DIR ?? '', '0a1b2c3d', 'agent-browser', install).vars;
  const browser = { driver: 'agent-browser' as const, session: 'lane-0a1b2c3d', debugPort: 9333, streamPort: null, createdAt: 0 };
  const paths = browserPaths(path.join(s.root, 'unrecorded'), '0a1b2c3d', browser.session, () => path.join(s.root, 'tmp'));
  return browserVariables({ browser, paths, install, headed: false, url: null }, '/usr/bin:/bin');
}

test('a running agent-browser keeps the browser its environment names, and a newer install removes the older browsers nothing names', async () => {
  for (const recorded of [true, false]) {
    const s = served();
    const { b } = await twoRevisions(s);
    const vars = laneVariables(s, b, recorded);
    assert.equal(vars.AGENT_BROWSER_EXECUTABLE_PATH, b.headlessShell);
    const lines: string[] = [];
    await ensureBrowserDriver(
      'agent-browser',
      s.options({
        playwright: later(s, '9.11.0', '4').playwright,
        commandLines: daemonOf(b, vars),
        log: line => lines.push(line),
      }),
    );
    const browsers = path.join('playwright', 'browsers');
    const kept = recorded ? ['chromium-3', 'chromium_headless_shell-3', 'ffmpeg-3'] : ['chromium_headless_shell-3'];
    assert.deepEqual(
      folders(s).sort(),
      [
        path.join('agent-browser', '1.1.1'),
        path.join('playwright', '9.11.0'),
        ...[...kept, 'chromium-4', 'chromium_headless_shell-4', 'ffmpeg-4'].map(name => path.join(browsers, name)),
      ].sort(),
      `${recorded ? 'recorded' : 'unrecorded'} lane\n${lines.join('\n')}`,
    );
    assert.ok(
      lines.includes(`kept ${path.join(b.browsersPath, 'chromium_headless_shell-3')}, which a running agent-browser launches`),
      lines.join('\n'),
    );
  }
});

/** A stand-in for a lane's agent-browser daemon: a process whose command line names the binary, in this environment. */
async function standInDaemon(install: InstalledDriver, environment: Record<string, string>): Promise<() => Promise<void>> {
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write('ready\\n'); process.stdin.resume()", '--', install.cli[0] ?? '', '--session', 'lane-0a1b2c3d'],
    { env: environment, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => {
      reject(new Error(`the stand-in daemon exited with ${String(code)}`));
    });
  });
  return () =>
    new Promise(resolve => {
      child.once('exit', () => {
        resolve();
      });
      child.kill();
    });
}

test('a running agent-browser keeps the browser its environment names, as ps shows that environment', async () => {
  for (const names of [true, false]) {
    const s = served();
    const { a, b } = await twoRevisions(s);
    const vars = laneVariables(s, b, false);
    if (!names) delete vars.AGENT_BROWSER_EXECUTABLE_PATH;
    const stop = await standInDaemon(b, vars);
    const lines: string[] = [];
    try {
      await ensureBrowserDriver(
        'agent-browser',
        s.options({ playwright: later(s, '9.11.0', '4').playwright, log: line => lines.push(line) }),
      );
    } finally {
      await stop();
    }
    const why = `${names ? 'names' : 'names no browser'}\n${lines.join('\n')}`;
    assert.ok(fs.existsSync(b.headlessShell), why);
    assert.equal(fs.existsSync(a.headlessShell), !names, why);
    assert.equal(fs.existsSync(b.chrome), !names, why);
    assert.ok(
      lines.includes(
        names
          ? `kept ${path.join(b.browsersPath, 'chromium_headless_shell-3')}, which a running agent-browser launches`
          : `kept ${path.join(a.browsersPath, 'chromium-1')}, which agent-browser may run`,
      ),
      why,
    );
  }
});

test("a running agent-browser whose environment can't be read keeps every older browser", async () => {
  for (const recorded of [true, false]) {
    for (const shown of ['', 'other user']) {
      const s = served();
      const { a, b } = await twoRevisions(s);
      if (recorded) laneUp(s, s.env.AGENTLANE_STATE_DIR ?? '', '0a1b2c3d', 'agent-browser', b);
      const daemon = daemonOf(b, undefined, shown && `${b.cli[0] ?? ''} --session lane-0a1b2c3d`);
      const lines: string[] = [];
      await ensureBrowserDriver(
        'agent-browser',
        s.options({ playwright: later(s, '9.11.0', '4').playwright, commandLines: daemon, log: line => lines.push(line) }),
      );
      const why = `${recorded ? 'recorded' : 'unrecorded'} lane, ${shown || 'no'} environment\n${lines.join('\n')}`;
      for (const file of [a.chrome, a.headlessShell, a.ffmpeg, b.chrome, b.headlessShell, b.ffmpeg]) {
        assert.ok(fs.existsSync(file), `${file}\n${why}`);
      }
      assert.ok(lines.includes(`kept ${path.join(a.browsersPath, 'chromium-1')}, which agent-browser may run`), why);
    }
  }
});

test("a newer install keeps the browser revisions a project's own Playwright downloaded into the lane's browsers folder", async () => {
  const s = served();
  const a = await ensureBrowserDriver('playwright', s.options({ commandLines: nobodyRunning }));
  const project = path.join(s.root, 'project', 'node_modules', 'playwright-core');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'browsers.json'), browsersJson('2', '1'));
  const link = path.join(a.browsersPath, '.links', crypto.createHash('sha1').update(project).digest('hex'));
  fs.writeFileSync(link, project);
  const own = ['chromium-0', 'chromium-2', 'chromium_headless_shell-2', 'ffmpeg-1'].map(name => path.join(a.browsersPath, name));
  for (const dir of own) {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });
    for (const marker of ['INSTALLATION_COMPLETE', 'DEPENDENCIES_VALIDATED']) fs.writeFileSync(path.join(dir, marker), '');
  }
  const lines: string[] = [];
  await ensureBrowserDriver(
    'playwright',
    s.options({ ...later(s, '9.10.0', '3'), commandLines: nobodyRunning, log: line => lines.push(line) }),
  );
  for (const dir of own) assert.ok(fs.existsSync(path.join(dir, 'bin', 'browser')), `${dir}\n${lines.join('\n')}`);
  assert.equal(fs.readFileSync(link, 'utf8'), project);
  for (const file of [a.chrome, a.headlessShell, a.ffmpeg])
    assert.equal(fs.existsSync(file), false, `${file}\n${lines.join('\n')}`);
});
