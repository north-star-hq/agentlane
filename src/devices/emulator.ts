import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { JAVA_HOME_ENV } from '../hooks/env.ts';
import { EMULATOR_NAME_PREFIX, FORMER } from '../name.ts';
import { emulatorSerial } from '../registry/config.ts';
import { isPoolName } from '../registry/paths.ts';
import { UsageError } from '../registry/refusal.ts';
import type { BackendDevice, DeviceBackend, DeviceSpec, SpecRequest } from './backend.ts';
import { DeviceBackendError } from './backend.ts';

export const MAESTRO_DRIVER_PACKAGE = 'dev.mobile.maestro';
export const DEFAULT_DEVICE_PROFILE = 'pixel_8';
export const EMULATOR_FLAGS = ['-no-window', '-no-audio', '-no-boot-anim'] as const;

const BOOT_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

export interface AndroidSdk {
  root: string;
  adb: string;
  emulator: string;
  avdmanager: string | null;
  avdHome: string;
}

export interface SystemImage {
  id: string;
  api: string;
  tag: string;
  tagName: string;
  abi: string;
}

export interface Avd {
  name: string;
  deviceType: string;
  runtime: string;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
}

export function parseProperties(text: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.trimStart().startsWith('#')) continue;
    props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return props;
}

function readProperties(file: string): Map<string, string> {
  try {
    return parseProperties(fs.readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}

export function avdHome(env: NodeJS.ProcessEnv): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return path.join(env.ANDROID_USER_HOME, 'avd');
  return path.join(env.ANDROID_SDK_HOME ?? homeOf(env), '.android', 'avd');
}

export function findAndroidSdk(env: NodeJS.ProcessEnv): AndroidSdk | null {
  const home = homeOf(env);
  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    path.join(home, 'Library', 'Android', 'sdk'),
    path.join(home, 'Android', 'Sdk'),
  ];
  for (const root of roots) {
    if (!root || !path.isAbsolute(root)) continue;
    const adb = path.join(root, 'platform-tools', 'adb');
    const emulator = path.join(root, 'emulator', 'emulator');
    if (!isFile(adb) || !isFile(emulator)) continue;
    const versions = listDir(path.join(root, 'cmdline-tools')).sort((a, b) => (a === 'latest' ? -1 : b === 'latest' ? 1 : 0));
    const avdmanager = versions.map(v => path.join(root, 'cmdline-tools', v, 'bin', 'avdmanager')).find(isFile) ?? null;
    return { root, adb, emulator, avdmanager, avdHome: avdHome(env) };
  }
  return null;
}

function compareApi(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function readSystemImages(sdkRoot: string): SystemImage[] {
  const images: SystemImage[] = [];
  const base = path.join(sdkRoot, 'system-images');
  for (const platformDir of listDir(base)) {
    const api = /^android-(\d+(?:\.\d+)?)$/.exec(platformDir)?.[1];
    if (!api) continue;
    for (const tag of listDir(path.join(base, platformDir))) {
      for (const abi of listDir(path.join(base, platformDir, tag))) {
        const props = readProperties(path.join(base, platformDir, tag, abi, 'source.properties'));
        if (props.size === 0) continue;
        images.push({
          id: `system-images;${platformDir};${tag};${abi}`,
          api,
          tag,
          tagName: props.get('SystemImage.TagDisplay') ?? tag,
          abi,
        });
      }
    }
  }
  return images;
}

export function hostAbi(arch: string = process.arch): string {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export function deviceProfileName(profile: string): string {
  return profile
    .split('_')
    .map(word => (word === '' ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

function installHint(abi: string): string {
  return `install one with: sdkmanager "system-images;android-36;google_apis;${abi}"`;
}

export function resolveAndroidSpec(images: readonly SystemImage[], request: SpecRequest, abi: string): DeviceSpec {
  const wanted = request.runtime?.trim();
  let image: SystemImage | undefined;
  if (wanted) {
    image =
      images.find(i => i.id === wanted) ??
      images.find(i => i.abi === abi && i.tag === 'google_apis' && (`android-${i.api}` === wanted || i.api === wanted));
    if (!image) {
      throw new UsageError(
        `no installed Android system image matches '${wanted}'`,
        `pass --runtime with one of: ${images.map(i => i.id).join(', ') || '(none installed)'}; or ${installHint(abi)}`,
      );
    }
  } else {
    image = images.filter(i => i.abi === abi && i.tag === 'google_apis').sort((a, b) => compareApi(b.api, a.api))[0];
    if (!image) throw new UsageError(`no Google APIs system image for ${abi} is installed`, installHint(abi));
  }
  const given = request.deviceType?.trim();
  const profile = given === undefined || given === '' ? DEFAULT_DEVICE_PROFILE : given;
  if (!/^[A-Za-z0-9_.-]+$/.test(profile)) {
    throw new UsageError(`'${profile}' is not an Android device profile id`, 'pass --device-type with an id such as pixel_8');
  }
  return {
    deviceType: profile,
    deviceTypeName: deviceProfileName(profile),
    runtime: image.id,
    runtimeName: `Android API ${image.api} (${image.tagName}, ${image.abi})`,
  };
}

export function sysdirToImage(sysdir: string): string {
  const parts = sysdir.split('/').filter(part => part !== '' && part !== 'system-images');
  return parts.length === 0 ? '' : ['system-images', ...parts].join(';');
}

export function readAvds(home: string): Avd[] {
  let files: string[];
  try {
    files = fs.readdirSync(home).filter(f => f.endsWith('.ini'));
  } catch {
    return [];
  }
  return files.map(file => {
    const name = file.slice(0, -'.ini'.length);
    const pointer = readProperties(path.join(home, file));
    const dir = pointer.get('path') ?? path.join(home, `${name}.avd`);
    const config = readProperties(path.join(dir, 'config.ini'));
    return {
      name,
      deviceType: config.get('hw.device.name') ?? '',
      runtime: sysdirToImage(config.get('image.sysdir.1') ?? ''),
    };
  });
}

export function parseRunningEmulators(lines: readonly string[]): Map<string, number | null> {
  const running = new Map<string, number | null>();
  for (const line of lines) {
    const args = line.trim().split(/\s+/);
    const executable = path.basename(args[0] ?? '');
    if (!executable.startsWith('emulator') && !executable.startsWith('qemu-system')) continue;
    const flag = args.indexOf('-avd');
    const name = flag >= 0 ? args[flag + 1] : args.find(a => a.startsWith('@'))?.slice(1);
    if (!name) continue;
    const portFlag = args.indexOf('-port');
    const port = portFlag >= 0 ? Number(args[portFlag + 1]) : NaN;
    const known = running.get(name);
    running.set(name, Number.isInteger(port) ? port : (known ?? null));
  }
  return running;
}

export function parseAdbDevices(output: string): string[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/)[0] ?? '')
    .filter(serial => /^emulator-\d+$/.test(serial));
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tail(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-15).join('\n');
  } catch {
    return '(no log)';
  }
}

export function findJavaHome(env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    env[JAVA_HOME_ENV],
    env.JAVA_HOME,
    '/opt/homebrew/opt/openjdk@17',
    '/usr/local/opt/openjdk@17',
    '/opt/homebrew/opt/openjdk',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  ];
  return candidates.find((home): home is string => !!home && isFile(path.join(home, 'bin', 'java'))) ?? null;
}

export interface EmulatorBackendOptions {
  env: NodeJS.ProcessEnv;
  logDir: string;
  sdk?: AndroidSdk | null;
}

function assertPoolAvd(id: string): void {
  if (!isPoolName('android', id)) {
    throw new DeviceBackendError(
      `${id} is not an AVD the registry created (${EMULATOR_NAME_PREFIX}<6 hex>, or ${FORMER.emulatorNamePrefix}<6 hex> from 0.2.x), so it is left alone`,
    );
  }
}

export function createEmulatorBackend(options: EmulatorBackendOptions): DeviceBackend {
  let found = options.sdk;
  const sdk = (): AndroidSdk => {
    found ??= findAndroidSdk(options.env);
    if (!found) {
      throw new UsageError(
        'no Android SDK found (looked at ANDROID_HOME, ANDROID_SDK_ROOT and ~/Library/Android/sdk)',
        'install Android Studio or the SDK command-line tools, and set ANDROID_HOME',
      );
    }
    return found;
  };
  const toolEnv = (): NodeJS.ProcessEnv => ({ ...options.env, ANDROID_HOME: sdk().root, ANDROID_SDK_ROOT: sdk().root });

  const adb = (args: string[], timeoutMs = 20_000) =>
    spawnSync(sdk().adb, args, { encoding: 'utf8', timeout: timeoutMs, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  const adbAsync = async (args: string[], timeoutMs = 10_000): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(sdk().adb, args, { timeout: timeoutMs, env: toolEnv() });
      return stdout;
    } catch {
      return null;
    }
  };

  const runningByProcess = (): Map<string, number | null> => {
    const ps = spawnSync('ps', ['-A', '-o', 'args='], {
      encoding: 'utf8',
      env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
      timeout: 10_000,
    });
    if (ps.error || ps.status !== 0) throw new DeviceBackendError(`ps could not list the running emulators: ${ps.stderr}`);
    return parseRunningEmulators(ps.stdout.split('\n'));
  };

  const running = (): Map<string, string | null> => {
    const byProcess = runningByProcess();
    const serials = new Map<string, string | null>(
      [...byProcess].map(([name, port]) => [name, port === null ? null : emulatorSerial(port)]),
    );
    if (![...serials.values()].includes(null)) return serials;
    const devices = adb(['devices']);
    if (devices.status !== 0) return serials;
    for (const serial of parseAdbDevices(devices.stdout)) {
      const named = adb(['-s', serial, 'emu', 'avd', 'name'], 5_000);
      const name = named.status === 0 ? (named.stdout.split(/\r?\n/)[0] ?? '').trim() : '';
      if (serials.get(name) === null) serials.set(name, serial);
    }
    return serials;
  };

  const stopped = (id: string): boolean => !runningByProcess().has(id);

  const backend: DeviceBackend = {
    platform: 'android',

    resolveSpec(request) {
      return resolveAndroidSpec(readSystemImages(sdk().root), request, hostAbi());
    },

    list(): BackendDevice[] {
      const live = running();
      return readAvds(sdk().avdHome).map(avd => {
        const serial = live.get(avd.name);
        return {
          id: avd.name,
          name: avd.name,
          deviceType: avd.deviceType,
          runtime: avd.runtime,
          booted: live.has(avd.name),
          ...(serial ? { serial } : {}),
        };
      });
    },

    create(name, spec) {
      assertPoolAvd(name);
      const tool = sdk().avdmanager;
      if (!tool) {
        throw new DeviceBackendError(
          `avdmanager is not under ${sdk().root}/cmdline-tools; install the Android SDK Command-line Tools`,
        );
      }
      const java = findJavaHome(options.env);
      if (!java) throw new DeviceBackendError('avdmanager needs a JDK 17 or newer: brew install openjdk@17, or set JAVA_HOME');
      const made = spawnSync(tool, ['create', 'avd', '-n', name, '-k', spec.runtime, '-d', spec.deviceType], {
        input: 'no\n',
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...toolEnv(), JAVA_HOME: java },
      });
      if (made.status !== 0 || !isFile(path.join(sdk().avdHome, `${name}.ini`))) {
        const output = `${made.stderr}\n${made.stdout}`.trim().split('\n').slice(-5).join('\n');
        throw new DeviceBackendError(`avdmanager create avd ${name} failed: ${output || (made.error?.message ?? '')}`);
      }
      return name;
    },

    delete(id) {
      assertPoolAvd(id);
      backend.shutdown(id);
      const tool = sdk().avdmanager;
      const java = findJavaHome(options.env);
      if (!tool || !java) throw new DeviceBackendError(`deleting ${id} needs avdmanager and a JDK 17 or newer`);
      const removed = spawnSync(tool, ['delete', 'avd', '-n', id], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...toolEnv(), JAVA_HOME: java },
      });
      if (removed.status !== 0) throw new DeviceBackendError(`avdmanager delete avd ${id} failed: ${removed.stderr.trim()}`);
    },

    shutdown(id) {
      assertPoolAvd(id);
      const live = running();
      if (!live.has(id)) return;
      const serial = live.get(id);
      if (!serial) {
        throw new DeviceBackendError(`emulator ${id} is running but adb does not list it, so it cannot be stopped through adb`);
      }
      adb(['-s', serial, 'shell', 'am', 'force-stop', MAESTRO_DRIVER_PACKAGE]);
      const kill = adb(['-s', serial, 'emu', 'kill']);
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (!stopped(id)) {
        if (Date.now() >= deadline) {
          throw new DeviceBackendError(
            `emulator ${id} (${serial}) did not stop within ${String(STOP_TIMEOUT_MS / 1000)} s of adb emu kill${kill.status === 0 ? '' : `: ${kill.stderr.trim()}`}`,
          );
        }
        pause(200);
      }
    },

    async boot(id, consolePort) {
      assertPoolAvd(id);
      if (consolePort === undefined) throw new DeviceBackendError(`emulator ${id} has no claimed console port to boot on`);
      const serial = emulatorSerial(consolePort);
      const live = running();
      const log = path.join(options.logDir, `${id}.log`);
      const child: { exited: string | null } = { exited: null };
      if (live.get(id) !== serial) {
        if (live.has(id)) backend.shutdown(id);
        fs.mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
        const out = fs.openSync(log, 'a');
        const started = spawn(sdk().emulator, ['-avd', id, '-port', String(consolePort), ...EMULATOR_FLAGS], {
          detached: true,
          stdio: ['ignore', out, out],
          env: toolEnv(),
        });
        fs.closeSync(out);
        started.once('error', error => (child.exited = error.message));
        started.once('exit', (code, signal) => (child.exited = signal ? `signal ${signal}` : `exit code ${String(code)}`));
        started.unref();
      }
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      for (;;) {
        if (child.exited !== null) {
          throw new DeviceBackendError(
            `emulator ${id} exited before it booted (${child.exited}); its log, ${log}:\n${tail(log)}`,
          );
        }
        const booted = await adbAsync(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']);
        if (booted?.trim() === '1') break;
        if (Date.now() >= deadline) {
          throw new DeviceBackendError(
            `emulator ${id} did not finish booting as ${serial} within ${String(BOOT_TIMEOUT_MS / 1000)} s; its log is ${log}`,
          );
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const name = ((await adbAsync(['-s', serial, 'emu', 'avd', 'name'])) ?? '').split(/\r?\n/)[0]?.trim();
      if (name !== id) throw new DeviceBackendError(`${serial} is the emulator '${name ?? ''}', not ${id}`);
    },
  };
  return backend;
}
