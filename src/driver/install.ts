import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CLI, envName, TOOL } from '../name.ts';
import { identityOf, systemProcesses, type ProcessTable } from '../processes.ts';
import { DriverError } from './errors.ts';
import { runCommand, tail } from './exec.ts';
import { tryLock, unlock } from './lock.ts';
import { MAESTRO_RELEASE, type MaestroRelease } from './release.ts';

export interface Jdk {
  javaHome: string;
  origin: string;
}

export interface Downloaded {
  zip: string;
  checksumFile: string | undefined;
}

export type Downloader = (release: MaestroRelease, dir: string) => Promise<Downloaded>;

export interface InstallOptions {
  env: NodeJS.ProcessEnv;
  release?: MaestroRelease;
  /** A zip already on disk, checked against the pinned sha256 like a download. */
  from?: string;
  download?: Downloader;
  processes?: ProcessTable;
  log?: (line: string) => void;
  lockWaitMs?: number;
}

export interface Installed {
  home: string;
  binary: string;
  version: string;
  installedNow: boolean;
  ms: number;
}

interface Marker {
  version: string;
  sha256: string;
  installedAt: string;
}

/** A Maestro binary to use instead of the pinned build, such as a local build of `maestro/`. */
export const MAESTRO_OVERRIDE_ENV = envName('MAESTRO');

const JDK_FIX = `install JDK 17 ('brew install openjdk@17'), or set JAVA_HOME to a JDK 17 home`;
const INSTALL_LOCK_WAIT_MS = 15 * 60_000;

export function dataDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME ?? os.homedir(), '.local', 'share');
  return path.join(base, TOOL);
}

export function maestroHome(env: NodeJS.ProcessEnv, release: MaestroRelease = MAESTRO_RELEASE): string {
  return path.join(dataDir(env), 'maestro', release.version);
}

function binaryIn(home: string): string {
  return path.join(home, 'maestro', 'bin', 'maestro');
}

function readMarker(home: string): Marker | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.installed'), 'utf8')) as Marker;
  } catch {
    return undefined;
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The pinned build, if it is installed and its marker names the pinned checksum. */
export function installedMaestro(env: NodeJS.ProcessEnv, release: MaestroRelease = MAESTRO_RELEASE): Installed | undefined {
  const home = maestroHome(env, release);
  const marker = readMarker(home);
  const binary = binaryIn(home);
  if (marker?.sha256 !== release.sha256 || marker.version !== release.version || !isExecutable(binary)) return undefined;
  return { home, binary, version: release.version, installedNow: false, ms: 0 };
}

async function javaSettings(home: string): Promise<{ spec: string | undefined; javaHome: string | undefined }> {
  const java = path.join(home, 'bin', 'java');
  if (!isExecutable(java)) return { spec: undefined, javaHome: undefined };
  const ran = await runCommand(java, ['-XshowSettings:properties', '-version'], { timeoutMs: 30_000 });
  const text = `${ran.stdout}\n${ran.stderr}`;
  return {
    spec: /^\s*java\.specification\.version = (\S+)/m.exec(text)?.[1],
    javaHome: /^\s*java\.home = (.+)$/m.exec(text)?.[1]?.trim(),
  };
}

/** Finds JDK 17 the way maestro/build.sh does: JAVA_HOME, then java_home -v 17, then Homebrew's openjdk@17. */
export async function findJdk17(env: NodeJS.ProcessEnv): Promise<Jdk> {
  let candidate: string | undefined;
  let origin: string;
  if (env.JAVA_HOME) {
    candidate = env.JAVA_HOME;
    origin = `JAVA_HOME=${env.JAVA_HOME}`;
  } else {
    const javaHome = await runCommand('/usr/libexec/java_home', ['-v', '17'], { timeoutMs: 10_000 });
    if (javaHome.code === 0 && javaHome.stdout.trim()) {
      candidate = javaHome.stdout.trim();
      origin = '/usr/libexec/java_home -v 17';
    } else {
      const prefixes = ['/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@17'];
      if (!prefixes.some(prefix => isExecutable(path.join(prefix, 'bin', 'java')))) {
        const brew = await runCommand('brew', ['--prefix', 'openjdk@17'], { timeoutMs: 10_000 });
        if (brew.code === 0 && brew.stdout.trim()) prefixes.unshift(brew.stdout.trim());
      }
      candidate = prefixes.find(prefix => isExecutable(path.join(prefix, 'bin', 'java')));
      origin = `Homebrew's openjdk@17 (${candidate ?? 'not installed'})`;
    }
  }
  if (!candidate) throw new DriverError('no JDK 17 found; Maestro runs on JDK 17', JDK_FIX);
  const settings = await javaSettings(candidate);
  if (settings.spec === undefined) {
    throw new DriverError(`${origin} has no working bin/java`, `${JDK_FIX}, or unset JAVA_HOME so ${TOOL} finds one`);
  }
  if (settings.spec !== '17') {
    throw new DriverError(
      `${origin} is Java ${settings.spec}, and Maestro runs on JDK 17`,
      `${JDK_FIX}, or unset JAVA_HOME so ${TOOL} finds one`,
    );
  }
  return { javaHome: settings.javaHome ?? candidate, origin };
}

export async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

const manualFix = (release: MaestroRelease) =>
  `download ${release.url} yourself and run '${CLI} driver install --from <that zip>'`;

export const httpsDownload: Downloader = async (release, dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const fetchTo = async (url: string, file: string) => {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new DriverError(`downloading ${url} failed: HTTP ${String(response.status)}`, `retry, or ${manualFix(release)}`);
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
  };
  const zip = path.join(dir, release.asset);
  await fetchTo(release.url, zip);
  const checksumFile = `${zip}.sha256`;
  await fetchTo(`${release.url}.sha256`, checksumFile);
  return { zip, checksumFile };
};

async function verify(release: MaestroRelease, downloaded: Downloaded): Promise<void> {
  const refuse = (problem: string) =>
    new DriverError(
      `${problem}; refusing to install Maestro ${release.version}`,
      `retry the install, since a download can arrive damaged. If the same hash comes back, the release asset no longer matches what this ${TOOL} pins, so upgrade ${TOOL}. A zip given with --from must be the pinned build itself.`,
    );
  let size: number;
  try {
    size = fs.statSync(downloaded.zip).size;
  } catch {
    throw refuse(`${downloaded.zip} is missing`);
  }
  if (size !== release.size) {
    throw refuse(`${path.basename(downloaded.zip)} is ${String(size)} bytes, but the pinned asset is ${String(release.size)}`);
  }
  const actual = await sha256Of(downloaded.zip);
  if (actual !== release.sha256) {
    throw refuse(`${path.basename(downloaded.zip)} hashes to sha256 ${actual}, but ${TOOL} pins ${release.sha256}`);
  }
  if (downloaded.checksumFile !== undefined) {
    const published = /^([0-9a-f]{64})\b/.exec(fs.readFileSync(downloaded.checksumFile, 'utf8').trim())?.[1];
    if (published !== release.sha256) {
      throw refuse(`the release's own checksum file says ${published ?? 'nothing readable'}, but ${TOOL} pins ${release.sha256}`);
    }
  }
}

/** macOS's unzip copies a quarantined zip's com.apple.quarantine to every file it unpacks, and Gatekeeper can block those files. */
async function clearQuarantine(dir: string): Promise<void> {
  const cleared = await runCommand('xattr', ['-dr', 'com.apple.quarantine', dir], { timeoutMs: 60_000 });
  if (cleared.code !== 0) {
    throw new DriverError(
      `clearing macOS's quarantine from the unpacked Maestro failed (${cleared.error ?? `exit ${String(cleared.code)}`}): ${tail(cleared.stderr, 5)}`,
      `retry '${CLI} driver install'`,
    );
  }
}

async function unpack(release: MaestroRelease, zip: string, into: string, jdk: Jdk): Promise<void> {
  const unzipped = await runCommand('unzip', ['-q', zip, '-d', into], { timeoutMs: 10 * 60_000 });
  if (unzipped.code !== 0) {
    throw new DriverError(
      `unzip of ${path.basename(zip)} failed (${unzipped.error ?? `exit ${String(unzipped.code)}`}): ${tail(unzipped.stderr, 5)}`,
      `install unzip, then retry '${CLI} driver install'`,
    );
  }
  if (process.platform === 'darwin') await clearQuarantine(into);
  const binary = binaryIn(into);
  if (!isExecutable(binary)) {
    throw new DriverError(`${path.basename(zip)} has no executable maestro/bin/maestro`, manualFix(release));
  }
  const version = await runCommand(binary, ['--version'], {
    env: { ...process.env, JAVA_HOME: jdk.javaHome, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_DISABLE_UPDATE_CHECK: 'true' },
    timeoutMs: 120_000,
  });
  const printed = version.stdout.trim().split('\n').at(-1)?.trim();
  if (version.code !== 0 || printed !== release.version) {
    throw new DriverError(
      `the unpacked Maestro prints '${printed ?? ''}' for --version (exit ${String(version.code)}), not ${release.version}: ${tail(version.stderr, 5)}`,
      `check that ${jdk.origin} is a working JDK 17, then retry '${CLI} driver install'`,
    );
  }
}

/** Installs the pinned Maestro build on first use: download, check against the pinned sha256, unpack, check --version. */
export async function ensureMaestro(options: InstallOptions): Promise<Installed> {
  const release = options.release ?? MAESTRO_RELEASE;
  const ready = installedMaestro(options.env, release);
  if (ready && options.from === undefined) return ready;
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const jdk = await findJdk17(options.env);
  const home = maestroHome(options.env, release);
  const base = path.dirname(home);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });

  const processes = options.processes ?? systemProcesses;
  const me = identityOf(processes, process.pid);
  if (!me) throw new Error(`ps could not read this process's start time (pid ${String(process.pid)})`);
  const lock = path.join(base, `.${release.version}.lock`);
  const deadline = Date.now() + (options.lockWaitMs ?? INSTALL_LOCK_WAIT_MS);
  let announced = false;
  for (;;) {
    const attempt = tryLock(lock, me, processes);
    if (attempt.acquired) break;
    if (Date.now() > deadline) {
      throw new DriverError(
        `another process (pid ${String(attempt.holder?.pid ?? '?')}) has been installing Maestro ${release.version} for too long`,
        `wait for it, or remove ${lock} if that process is gone`,
      );
    }
    if (!announced) log(`waiting for pid ${String(attempt.holder?.pid ?? '?')}, which is installing Maestro ${release.version}`);
    announced = true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const work = fs.mkdtempSync(path.join(base, '.install-'));
  try {
    const again = installedMaestro(options.env, release);
    if (again && options.from === undefined) return again;
    let downloaded: Downloaded;
    if (options.from !== undefined) {
      downloaded = { zip: path.resolve(options.from), checksumFile: undefined };
    } else {
      log(`downloading Maestro ${release.version} (${String(Math.round(release.size / 1_048_576))} MB) from ${release.url}`);
      downloaded = await (options.download ?? httpsDownload)(release, path.join(work, 'download'));
    }
    await verify(release, downloaded);
    const unpacked = path.join(work, 'unpacked');
    await unpack(release, downloaded.zip, unpacked, jdk);
    const marker: Marker = { version: release.version, sha256: release.sha256, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(unpacked, '.installed'), `${JSON.stringify(marker)}\n`);
    if (fs.existsSync(home)) fs.renameSync(home, path.join(work, 'previous'));
    fs.renameSync(unpacked, home);
    log(`installed Maestro ${release.version} in ${home}`);
    return { home, binary: binaryIn(home), version: release.version, installedNow: true, ms: Date.now() - started };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    unlock(lock, me);
  }
}

export type MaestroBuild =
  | { kind: 'release'; version: string; home: string; sha256: string }
  | { kind: 'not-installed'; version: string }
  | { kind: 'override'; binary: string; version: string | undefined; local: boolean; release: string };

/** Reads the build version a Maestro distribution was stamped with, from its CLI jar; undefined when unreadable. */
export async function distributionVersion(binary: string): Promise<string | undefined> {
  const lib = path.join(path.dirname(path.dirname(binary)), 'lib');
  let jar: string | undefined;
  try {
    jar = fs.readdirSync(lib).find(name => /^maestro-cli(-[\w.+-]+)?\.jar$/.test(name));
  } catch {
    return undefined;
  }
  if (jar === undefined) return undefined;
  const ran = await runCommand('unzip', ['-p', path.join(lib, jar), 'version.properties'], { timeoutMs: 10_000 });
  if (ran.code !== 0) return undefined;
  const props = new Map(
    ran.stdout
      .split('\n')
      .map(line => /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => [m[1] ?? '', m[2] ?? '']),
  );
  return props.get('buildVersion') ?? props.get('version');
}

export const LOCAL_BUILD_MARK = '+local.';

/** Which Maestro the driver runs: the pinned release, nothing yet, or a build named by the override variable. */
export async function maestroBuild(env: NodeJS.ProcessEnv, release: MaestroRelease = MAESTRO_RELEASE): Promise<MaestroBuild> {
  const override = env[MAESTRO_OVERRIDE_ENV];
  if (override) {
    const version = await distributionVersion(override);
    return {
      kind: 'override',
      binary: override,
      version,
      local: version?.includes(LOCAL_BUILD_MARK) ?? false,
      release: release.version,
    };
  }
  const installed = installedMaestro(env, release);
  return installed
    ? { kind: 'release', version: release.version, home: installed.home, sha256: release.sha256 }
    : { kind: 'not-installed', version: release.version };
}
