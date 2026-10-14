import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DriverError, messageOf } from '../driver/errors.ts';
import { runCommand, tail } from '../driver/exec.ts';
import { dataDir, sha256Of } from '../driver/install.ts';
import { tryLock, unlock } from '../driver/lock.ts';
import { CLI, envName, TOOL } from '../name.ts';
import { identityOf, systemProcesses, type ProcessTable } from '../processes.ts';
import type { BrowserDriverName } from './kinds.ts';
import {
  AGENT_BROWSER_RELEASE,
  hostKey,
  PLAYWRIGHT_RELEASE,
  type AgentBrowserRelease,
  type ArchivePin,
  type BrowserBuild,
  type PackagePin,
  type PlaywrightRelease,
} from './release.ts';

/** A Playwright browsers folder to use instead of the pinned builds, for a host they aren't pinned for. */
export const BROWSERS_OVERRIDE_ENV = envName('PLAYWRIGHT_BROWSERS');

export const INSTALL_FIX = `${CLI} browser install`;

/** Fetches a URL into a file, resuming a partial file when the server allows it. */
export type Fetcher = (url: string, file: string) => Promise<void>;

export interface BrowserInstallOptions {
  env: NodeJS.ProcessEnv;
  playwright?: PlaywrightRelease;
  agentBrowser?: AgentBrowserRelease;
  host?: string;
  /** A folder holding the archives already downloaded, by their file names; each is checked like a download. */
  from?: string;
  fetch?: Fetcher;
  processes?: ProcessTable;
  log?: (line: string) => void;
  lockWaitMs?: number;
}

/** What a lane's driver runs: the CLI, and the browser builds under PLAYWRIGHT_BROWSERS_PATH. */
export interface InstalledDriver {
  driver: BrowserDriverName;
  version: string;
  /** The executable the lane's `playwright-cli` or `agent-browser` runs. */
  cli: string[];
  /** playwright-core's folder, which Playwright's own registry records in the browsers folder's `.links`. */
  playwrightCore: string;
  browsersPath: string;
  /** Chrome for Testing, which playwright-cli launches. */
  chrome: string;
  /** Chrome for Testing's headless shell, which agent-browser launches and Playwright tests use headless. */
  headlessShell: string;
  /** Playwright's ffmpeg build, which records video. */
  ffmpeg: string;
  overridden: boolean;
}

export type InstallState =
  { kind: 'installed'; driver: InstalledDriver } | { kind: 'missing'; what: string } | { kind: 'mismatch'; what: string };

interface Marker {
  version: string;
  hash: string;
  installedAt: string;
}

const MARKER = '.agentlane-installed';
const LOCK_WAIT_MS = 15 * 60_000;

export function browsersPath(env: NodeJS.ProcessEnv): string {
  return env[BROWSERS_OVERRIDE_ENV] ?? path.join(dataDir(env), 'playwright', 'browsers');
}

function playwrightHome(env: NodeJS.ProcessEnv, release: PlaywrightRelease): string {
  return path.join(dataDir(env), 'playwright', release.version);
}

function agentBrowserHome(env: NodeJS.ProcessEnv, release: AgentBrowserRelease): string {
  return path.join(dataDir(env), 'agent-browser', release.version);
}

export function browserFolder(build: Pick<BrowserBuild, 'name' | 'revision'>): string {
  return `${build.name.replaceAll('-', '_')}-${build.revision}`;
}

function readMarker(dir: string): Marker | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as Marker;
  } catch {
    return undefined;
  }
}

function writeMarker(dir: string, marker: Marker): void {
  fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify(marker)}\n`);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sha512Base64(file: string): Promise<string> {
  const hash = crypto.createHash('sha512');
  return pipeline(fs.createReadStream(file), hash).then(() => hash.digest('base64'));
}

function archiveOf(build: BrowserBuild, host: string): ArchivePin | undefined {
  return build.archives[host];
}

function unpinned(host: string, what: string): DriverError {
  return new DriverError(
    `${TOOL} pins no ${what} build for ${host}`,
    `install Playwright's browsers for this host yourself (PLAYWRIGHT_BROWSERS_PATH=<folder> npx playwright@${PLAYWRIGHT_RELEASE.version} install chromium ffmpeg) and set ${BROWSERS_OVERRIDE_ENV}=<folder>`,
  );
}

/** The state of one pinned browser build: installed and checked, absent, or there without the toolkit's check. */
function buildState(base: string, build: BrowserBuild, host: string): InstallState | null {
  const archive = archiveOf(build, host);
  const dir = path.join(base, browserFolder(build));
  if (!archive) return { kind: 'missing', what: `${build.name} ${build.revision} (no pinned build for ${host})` };
  const marker = readMarker(dir);
  if (!fs.existsSync(dir)) return { kind: 'missing', what: `${build.name} ${build.revision} in ${base}` };
  if (marker?.hash !== archive.sha256) {
    return {
      kind: 'mismatch',
      what: `${dir} was not installed from the pinned ${path.basename(archive.url)} (sha256 ${archive.sha256.slice(0, 12)}…)`,
    };
  }
  if (!isFile(path.join(dir, ...archive.executable))) {
    return { kind: 'mismatch', what: `${dir} lacks ${archive.executable.join('/')}` };
  }
  return null;
}

function packageState(home: string, pin: PackagePin, entry: string): InstallState | null {
  const marker = readMarker(home);
  if (!fs.existsSync(home)) return { kind: 'missing', what: `${pin.name} ${pin.version} in ${home}` };
  if (marker?.hash !== pin.sha512 || marker.version !== pin.version) {
    return { kind: 'mismatch', what: `${home} is not the pinned ${pin.name} ${pin.version}` };
  }
  if (!isFile(path.join(home, 'package', entry))) return { kind: 'mismatch', what: `${home} lacks package/${entry}` };
  return null;
}

const PLAYWRIGHT_CLI_ENTRY = path.join('lib', 'tools', 'cli-client', 'cli.js');

function executableOf(base: string, build: BrowserBuild | undefined, host: string): string {
  const archive = build && archiveOf(build, host);
  return build && archive ? path.join(base, browserFolder(build), ...archive.executable) : '';
}

/** Whether the driver and its browsers are installed as pinned: what `doctor` reports and what a lane runs. */
export function installState(
  env: NodeJS.ProcessEnv,
  driver: BrowserDriverName,
  options: { playwright?: PlaywrightRelease; agentBrowser?: AgentBrowserRelease; host?: string } = {},
): InstallState {
  const playwright = options.playwright ?? PLAYWRIGHT_RELEASE;
  const agentBrowser = options.agentBrowser ?? AGENT_BROWSER_RELEASE;
  const host = options.host ?? hostKey();
  const base = browsersPath(env);
  const overridden = env[BROWSERS_OVERRIDE_ENV] !== undefined;
  const core = playwrightHome(env, playwright);
  const coreProblem = packageState(core, playwright.core, PLAYWRIGHT_CLI_ENTRY);
  if (coreProblem) return coreProblem;
  if (!overridden) {
    for (const build of playwright.browsers) {
      const problem = buildState(base, build, host);
      if (problem) return problem;
    }
  }
  const chromium = playwright.browsers.find(b => b.name === 'chromium');
  const headlessShell = playwright.browsers.find(b => b.name === 'chromium-headless-shell');
  const ffmpeg = playwright.browsers.find(b => b.name === 'ffmpeg');
  const installed: InstalledDriver = {
    driver,
    version: playwright.version,
    cli: [process.execPath, path.join(core, 'package', PLAYWRIGHT_CLI_ENTRY)],
    playwrightCore: path.join(core, 'package'),
    browsersPath: base,
    chrome: executableOf(base, chromium, host),
    headlessShell: executableOf(base, headlessShell, host),
    ffmpeg: executableOf(base, ffmpeg, host),
    overridden,
  };
  if (driver === 'playwright') return { kind: 'installed', driver: installed };
  const home = agentBrowserHome(env, agentBrowser);
  const binary = agentBrowser.binaries[host];
  if (binary === undefined) return { kind: 'missing', what: `agent-browser ${agentBrowser.version} has no binary for ${host}` };
  const problem = packageState(home, agentBrowser.package, binary);
  if (problem) return problem;
  return {
    kind: 'installed',
    driver: { ...installed, version: agentBrowser.version, cli: [path.join(home, 'package', binary)] },
  };
}

export function describeInstallState(driver: BrowserDriverName, state: InstallState): string {
  switch (state.kind) {
    case 'installed': {
      const d = state.driver;
      const browsers = d.overridden
        ? `the browsers in ${d.browsersPath} (${BROWSERS_OVERRIDE_ENV}, NOT the pinned builds)`
        : `Chrome for Testing in ${d.browsersPath}`;
      return `${driver} ${d.version}, pinned, with ${browsers}`;
    }
    case 'missing':
      return `${driver} is not installed: ${state.what}`;
    case 'mismatch':
      return `${driver} does not match its pin: ${state.what}`;
  }
}

/** How long a download may wait for a connection or for its next bytes; the CDN is slow from some networks. */
export const DOWNLOAD_IDLE_MS = 600_000;
const MAX_REDIRECTS = 5;

function download(url: string, file: string, redirects: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const have = isFile(file) ? fs.statSync(file).size : 0;
    const client = url.startsWith('http:') ? http : https;
    const request = client.get(
      url,
      { headers: have > 0 ? { range: `bytes=${String(have)}-` } : {}, timeout: DOWNLOAD_IDLE_MS },
      response => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location !== undefined) {
          response.resume();
          if (redirects >= MAX_REDIRECTS)
            reject(new DriverError(`${url} redirected more than ${String(MAX_REDIRECTS)} times`, `retry ${INSTALL_FIX}`));
          else resolve(download(new URL(location, url).toString(), file, redirects + 1));
          return;
        }
        if (status === 416 && have > 0) {
          response.resume();
          fs.rmSync(file, { force: true });
          resolve(download(url, file, redirects));
          return;
        }
        if (status !== 200 && status !== 206) {
          response.resume();
          reject(new DriverError(`downloading ${url} failed: HTTP ${String(status)}`, `retry ${INSTALL_FIX}`));
          return;
        }
        pipeline(response, fs.createWriteStream(file, { flags: status === 206 && have > 0 ? 'a' : 'w' })).then(resolve, reject);
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`${new URL(url).host} sent nothing for ${String(DOWNLOAD_IDLE_MS / 1000)} s`));
    });
    request.on('error', reject);
  });
}

/** Fetches a URL over HTTPS into a file, resuming what an earlier attempt left, and waiting long on a slow network. */
export const httpsFetch: Fetcher = (url, file) => download(url, file, 0);

async function fetchWithRetries(
  fetcher: Fetcher,
  url: string,
  file: string,
  size: number | null,
  log: (line: string) => void,
): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      const got = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      log(
        `${path.basename(file)}: ${messageOf(last)}; resuming at ${String(Math.round(got / 1_048_576))} MB (attempt ${String(attempt)} of 4)`,
      );
    }
    try {
      await fetcher(url, file);
      if (size === null || fs.statSync(file).size === size) return;
      if (fs.statSync(file).size > size) fs.rmSync(file, { force: true });
      last = new Error(
        `${path.basename(file)} is ${String(fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0)} bytes of ${String(size)}`,
      );
    } catch (error) {
      last = error;
    }
  }
  throw new DriverError(
    `downloading ${url} failed after 4 attempts: ${messageOf(last)}`,
    `retry ${INSTALL_FIX}; a download resumes where it stopped`,
  );
}

function refuse(what: string, problem: string): DriverError {
  return new DriverError(
    `${problem}; refusing to install ${what}`,
    `retry ${INSTALL_FIX}, since a download can arrive damaged. If the same hash comes back, the published file no longer matches what this ${TOOL} pins, so upgrade ${TOOL}`,
  );
}

class Installer {
  private readonly options: BrowserInstallOptions;
  private readonly log: (line: string) => void;
  private readonly work: string;

  constructor(options: BrowserInstallOptions, work: string) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.work = work;
  }

  private async obtain(url: string, size: number | null, what: string): Promise<string> {
    const name = path.basename(new URL(url).pathname);
    if (this.options.from !== undefined) {
      const file = path.join(this.options.from, name);
      if (!isFile(file))
        throw new DriverError(`${file} is missing`, `put ${name} in ${this.options.from}, or install without --from`);
      return file;
    }
    const file = path.join(this.work, name);
    this.log(`downloading ${what}${size === null ? '' : ` (${String(Math.round(size / 1_048_576))} MB)`} from ${url}`);
    await fetchWithRetries(this.options.fetch ?? httpsFetch, url, file, size, this.log);
    return file;
  }

  async unpackPackage(pin: PackagePin, home: string): Promise<void> {
    const what = `${pin.name} ${pin.version}`;
    const file = await this.obtain(pin.tarball, null, what);
    const actual = await sha512Base64(file);
    if (actual !== pin.sha512)
      throw refuse(what, `${path.basename(file)} hashes to sha512 ${actual}, but ${TOOL} pins ${pin.sha512}`);
    const into = fs.mkdtempSync(path.join(this.work, 'package-'));
    const ran = await runCommand('tar', ['-xzf', file, '-C', into], { timeoutMs: 10 * 60_000 });
    if (ran.code !== 0)
      throw new DriverError(`tar could not unpack ${path.basename(file)}: ${tail(ran.stderr, 5)}`, `retry ${INSTALL_FIX}`);
    writeMarker(into, { version: pin.version, hash: pin.sha512, installedAt: new Date().toISOString() });
    replace(home, into, this.work);
    this.log(`installed ${what} in ${home}`);
  }

  async unpackBrowser(base: string, build: BrowserBuild, archive: ArchivePin): Promise<void> {
    const what = `${build.name} ${build.revision}`;
    const file = await this.obtain(archive.url, archive.size, what);
    const size = fs.statSync(file).size;
    if (size !== archive.size)
      throw refuse(what, `${path.basename(file)} is ${String(size)} bytes, but the pinned build is ${String(archive.size)}`);
    const actual = await sha256Of(file);
    if (actual !== archive.sha256)
      throw refuse(what, `${path.basename(file)} hashes to sha256 ${actual}, but ${TOOL} pins ${archive.sha256}`);
    const into = fs.mkdtempSync(path.join(this.work, 'browser-'));
    const ran = await runCommand('unzip', ['-q', file, '-d', into], { timeoutMs: 10 * 60_000 });
    if (ran.code !== 0)
      throw new DriverError(
        `unzip of ${path.basename(file)} failed: ${tail(ran.stderr, 5)}`,
        `install unzip, then retry ${INSTALL_FIX}`,
      );
    const executable = path.join(into, ...archive.executable);
    if (!isFile(executable)) throw refuse(what, `${path.basename(file)} has no ${archive.executable.join('/')}`);
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(into, 'INSTALLATION_COMPLETE'), '');
    writeMarker(into, { version: build.revision, hash: archive.sha256, installedAt: new Date().toISOString() });
    replace(path.join(base, browserFolder(build)), into, this.work);
    this.log(`installed ${what} in ${path.join(base, browserFolder(build))}`);
  }
}

function replace(target: string, fresh: string, work: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) fs.renameSync(target, path.join(work, `previous-${path.basename(target)}-${String(Date.now())}`));
  fs.renameSync(fresh, target);
}

/** Links our playwright-core into the browsers folder the way Playwright's own install does, so its cleanup keeps them. */
function linkPlaywright(base: string, core: string): void {
  const links = path.join(base, '.links');
  fs.mkdirSync(links, { recursive: true });
  fs.writeFileSync(path.join(links, crypto.createHash('sha1').update(core).digest('hex')), core);
}

/** Installs what the driver needs that is missing or does not match its pin, under a lock held across processes. */
export async function ensureBrowserDriver(driver: BrowserDriverName, options: BrowserInstallOptions): Promise<InstalledDriver> {
  const releases = {
    playwright: options.playwright ?? PLAYWRIGHT_RELEASE,
    agentBrowser: options.agentBrowser ?? AGENT_BROWSER_RELEASE,
    host: options.host ?? hostKey(),
  };
  const before = installState(options.env, driver, releases);
  if (before.kind === 'installed') return before.driver;
  const root = dataDir(options.env);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const processes = options.processes ?? systemProcesses;
  const me = identityOf(processes, process.pid);
  if (!me) throw new Error(`ps could not read this process's start time (pid ${String(process.pid)})`);
  const lock = path.join(root, '.browsers.lock');
  const deadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  let announced = false;
  for (;;) {
    const attempt = tryLock(lock, me, processes);
    if (attempt.acquired) break;
    if (Date.now() > deadline) {
      throw new DriverError(
        `another process (pid ${String(attempt.holder?.pid ?? '?')}) has been installing the browser drivers for too long`,
        `wait for it, or remove ${lock} if that process is gone`,
      );
    }
    if (!announced)
      options.log?.(`waiting for pid ${String(attempt.holder?.pid ?? '?')}, which is installing the browser drivers`);
    announced = true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const work = fs.mkdtempSync(path.join(root, '.browsers-install-'));
  try {
    const installer = new Installer(options, work);
    const { playwright, agentBrowser, host } = releases;
    const core = playwrightHome(options.env, playwright);
    if (packageState(core, playwright.core, PLAYWRIGHT_CLI_ENTRY)) await installer.unpackPackage(playwright.core, core);
    if (options.env[BROWSERS_OVERRIDE_ENV] === undefined) {
      const base = browsersPath(options.env);
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      linkPlaywright(base, path.join(core, 'package'));
      for (const build of playwright.browsers) {
        if (!buildState(base, build, host)) continue;
        const archive = archiveOf(build, host);
        if (!archive) throw unpinned(host, build.name);
        await installer.unpackBrowser(base, build, archive);
      }
    }
    if (driver === 'agent-browser') {
      const binary = agentBrowser.binaries[host];
      if (binary === undefined) throw unpinned(host, 'agent-browser');
      const home = agentBrowserHome(options.env, agentBrowser);
      if (packageState(home, agentBrowser.package, binary)) {
        await installer.unpackPackage(agentBrowser.package, home);
        fs.chmodSync(path.join(home, 'package', binary), 0o755);
      }
    }
    const after = installState(options.env, driver, releases);
    if (after.kind !== 'installed') throw new DriverError(describeInstallState(driver, after), `retry ${INSTALL_FIX}`);
    return after.driver;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    unlock(lock, me);
  }
}
