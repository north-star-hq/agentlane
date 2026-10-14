import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { androidToolchain, CacheKeyError, xcodeVersion } from '../cache/key.ts';
import type { DeviceBackend, DeviceSpec } from '../devices/backend.ts';
import { findAndroidSdk } from '../devices/emulator.ts';
import { HOOK_LOCALE, JAVA_HOME_ENV } from '../hooks/env.ts';
import { runCheck } from '../hooks/run.ts';
import { TOOL } from '../name.ts';
import type { Precondition, PreconditionStage, ProjectConfig } from '../project/config.ts';
import { asMobile } from '../project/config.ts';
import { UsageError } from '../registry/refusal.ts';

const execFileAsync = promisify(execFile);

export interface JavaHome {
  home: string;
  version: string;
}

export interface Toolchain {
  xcodeVersion(): Promise<string>;
  /** The Android build's toolchain for the build cache key, as the build hook would find it in `env`. */
  androidToolchain(root: string, env: NodeJS.ProcessEnv): Promise<string>;
  localeCharmap(locale: string): Promise<string | undefined>;
  findJava17(env: NodeJS.ProcessEnv): Promise<JavaHome | null>;
}

export interface Finding {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

export class Unmet extends Error {
  readonly finding: Finding;

  constructor(finding: Finding, elapsedMs: number) {
    super(
      `${TOOL} up refused before any build, after ${(elapsedMs / 1000).toFixed(1)} s: ${finding.name}: ${finding.detail}\nto fix: ${finding.fix}`,
    );
    this.name = 'Unmet';
    this.finding = finding;
  }
}

async function javaVersion(home: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(path.join(home, 'bin', 'java'), ['-version'], { timeout: 20_000 });
    return /version "([^"]+)"/.exec(`${stderr}${stdout}`)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function macJavaHome17(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/libexec/java_home', ['-v', '17'], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function linuxJvms(): string[] {
  try {
    return fs
      .readdirSync('/usr/lib/jvm')
      .filter(name => /(^|-)17(-|\.|$)/.test(name))
      .map(name => path.join('/usr/lib/jvm', name));
  } catch {
    return [];
  }
}

export async function androidJavaHome(env: NodeJS.ProcessEnv, toolchain: Pick<Toolchain, 'findJava17'>): Promise<string | null> {
  const named = [env[JAVA_HOME_ENV], env.JAVA_HOME].find(home => home !== undefined && home !== '');
  return named ?? (await toolchain.findJava17(env))?.home ?? null;
}

export async function androidBuildEnvironment(
  env: NodeJS.ProcessEnv,
  toolchain: Pick<Toolchain, 'findJava17'>,
): Promise<NodeJS.ProcessEnv> {
  const javaHome = await androidJavaHome(env, toolchain);
  return javaHome === null ? env : { ...env, JAVA_HOME: javaHome };
}

export const systemToolchain: Toolchain = {
  xcodeVersion,

  async localeCharmap(locale) {
    try {
      const { stdout } = await execFileAsync('locale', ['charmap'], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: locale, LC_ALL: locale },
        timeout: 10_000,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },

  async findJava17(env) {
    const pinned = env[JAVA_HOME_ENV];
    const candidates = pinned
      ? [pinned]
      : [
          env.JAVA_HOME,
          await macJavaHome17(),
          '/opt/homebrew/opt/openjdk@17',
          '/usr/local/opt/openjdk@17',
          ...linuxJvms(),
        ].filter((c): c is string => typeof c === 'string' && c !== '');
    for (const home of new Set(candidates)) {
      const version = await javaVersion(home);
      if (version !== null && /^17(\.|$)/.test(version)) return { home, version };
    }
    return null;
  },

  async androidToolchain(root, env) {
    const javaHome = await androidJavaHome(env, systemToolchain);
    if (!javaHome) throw new CacheKeyError(`no JDK found for the Android build: set JAVA_HOME or ${JAVA_HOME_ENV}`);
    const sdk = findAndroidSdk(env);
    if (!sdk) throw new CacheKeyError('no Android SDK found for the Android build: set ANDROID_HOME');
    return androidToolchain({ root, javaHome, sdkRoot: sdk.root });
  },
};

export interface PreflightDeps {
  env: NodeJS.ProcessEnv;
  toolchain: Toolchain;
  backend: DeviceBackend | undefined;
}

export interface Preflight {
  findings: Finding[];
  spec: DeviceSpec | null;
  java: JavaHome | null;
}

function message(error: unknown): string {
  return error instanceof Error ? (error.message.split('\nto fix:')[0] ?? error.message) : String(error);
}

export async function toolchainFindings(config: ProjectConfig, deps: PreflightDeps, stopAtFirst: boolean): Promise<Preflight> {
  const result: Preflight = { findings: [], spec: null, java: null };
  const { backend } = deps;
  const mobile = asMobile(config);
  const android = mobile?.platform === 'android';
  const checks: (() => Promise<Finding | null>)[] = [
    () =>
      Promise.resolve(
        !mobile || backend
          ? null
          : android
            ? {
                name: 'Android emulators',
                ok: false,
                detail: 'this machine has no Android emulator backend',
                fix: 'install the Android SDK (Android Studio, or the command-line tools with platform-tools and the emulator)',
              }
            : {
                name: 'iOS simulators',
                ok: false,
                detail: 'this machine has no iOS simulators',
                fix: 'run up on a Mac with Xcode installed',
              },
      ),
    () => {
      if (!android) return Promise.resolve(null);
      const sdk = findAndroidSdk(deps.env);
      return Promise.resolve({
        name: 'Android SDK',
        ok: sdk !== null,
        detail: sdk
          ? `adb and the emulator in ${sdk.root}`
          : 'no Android SDK with platform-tools and the emulator (looked at ANDROID_HOME, ANDROID_SDK_ROOT and ~/Library/Android/sdk)',
        fix: 'install Android Studio or the SDK command-line tools, then set ANDROID_HOME',
      });
    },
    async () => {
      if (!mobile || android) return null;
      try {
        return { name: 'Xcode', ok: true, detail: await deps.toolchain.xcodeVersion(), fix: '' };
      } catch (error) {
        return {
          name: 'Xcode',
          ok: false,
          detail: message(error),
          fix: 'install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
        };
      }
    },
    async () => {
      const charmap = await deps.toolchain.localeCharmap(HOOK_LOCALE);
      const ambient = deps.env.LC_ALL ?? deps.env.LANG ?? '(unset)';
      return {
        name: 'hook locale',
        ok: charmap === 'UTF-8',
        detail:
          charmap === 'UTF-8'
            ? `hooks run with LANG and LC_ALL ${HOOK_LOCALE} (this shell has ${ambient})`
            : `${HOOK_LOCALE} gives charmap ${charmap ?? 'nothing'}, not UTF-8; CocoaPods fails without a UTF-8 locale`,
        fix: `install the ${HOOK_LOCALE} locale (on Linux: locale-gen ${HOOK_LOCALE})`,
      };
    },
    () => {
      if (!backend || !mobile) return Promise.resolve(null);
      const runtimeName = android ? 'emulator image' : 'simulator runtime';
      try {
        result.spec = backend.resolveSpec({ deviceType: mobile.app.device.type, runtime: mobile.app.device.runtime });
        return Promise.resolve({
          name: runtimeName,
          ok: true,
          detail: `${result.spec.deviceTypeName} on ${result.spec.runtimeName}`,
          fix: '',
        });
      } catch (error) {
        const fix =
          error instanceof UsageError
            ? error.fix
            : android
              ? 'install a system image: sdkmanager "system-images;android-36;google_apis;arm64-v8a"'
              : 'install an iOS simulator runtime: xcodebuild -downloadPlatform iOS';
        return Promise.resolve({ name: runtimeName, ok: false, detail: message(error), fix });
      }
    },
    async () => {
      if (!config.driver || !mobile) return null;
      result.java = await deps.toolchain.findJava17(deps.env);
      const pinned = deps.env[JAVA_HOME_ENV];
      return {
        name: 'Java 17',
        ok: result.java !== null,
        detail: result.java
          ? `java ${result.java.version} at ${result.java.home}`
          : `no JDK 17 found${pinned ? ` at ${JAVA_HOME_ENV}=${pinned}` : ''}; the driver (Maestro) needs it`,
        fix: `install JDK 17 (brew install openjdk@17), or set ${JAVA_HOME_ENV} to a JDK 17 home`,
      };
    },
  ];
  for (const check of checks) {
    const finding = await check();
    if (!finding) continue;
    result.findings.push(finding);
    if (!finding.ok && stopAtFirst) break;
  }
  return result;
}

export async function preconditionFinding(p: Precondition, cwd: string, env: NodeJS.ProcessEnv): Promise<Finding> {
  const outcome = await runCheck(p.run, { cwd, env });
  const status = outcome.signal ? `was killed by ${outcome.signal}` : `exited ${String(outcome.code)}`;
  const output = outcome.output ? `: ${outcome.output.split('\n').slice(-3).join(' / ')}` : '';
  return {
    name: p.name,
    ok: outcome.code === 0,
    detail: outcome.code === 0 ? `\`${p.run}\` passed` : `\`${p.run}\` ${status}${output}`,
    fix: p.fix,
  };
}

export async function projectFindings(
  config: ProjectConfig,
  stage: PreconditionStage,
  env: NodeJS.ProcessEnv,
  stopAtFirst: boolean,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const applies = (p: Precondition) => p.before === stage && (p.platforms === null || p.platforms.includes(config.platform));
  for (const p of config.preconditions.filter(applies)) {
    const finding = await preconditionFinding(p, config.dir, env);
    findings.push(finding);
    if (!finding.ok && stopAtFirst) break;
  }
  return findings;
}
