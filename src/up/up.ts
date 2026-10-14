import fs from 'node:fs';
import path from 'node:path';
import { setupFix } from '../agents/skills.ts';
import {
  describeSavedLogin,
  hasBrowser,
  openWebApp,
  signInBrowser,
  startFailureTrace,
  stopEndedBrowsers,
  type BrowserContext,
} from '../browser/lane-browser.ts';
import { realBrowserTools, type BrowserTools } from '../browser/tools.ts';
import type { CachedBuildResult, CacheMode } from '../cache/build.ts';
import { cachedBuild } from '../cache/build.ts';
import { computeKey } from '../cache/key.ts';
import { BuildCache, cacheDirFor } from '../cache/store.ts';
import { adbTools, type AdbTools } from '../devices/adb.ts';
import {
  applyAndroidHygiene,
  describeRestored,
  describeReverse,
  ensureReverse,
  intentExtras,
  launchAndroidApp,
  launchAndroidDevClient,
  REACT_NATIVE_DEVICE_PORT,
  requireAppInstalled,
  requireEmulatorBooted,
  restoreReverse,
} from '../devices/android.ts';
import { DEVICE_NOUN } from '../devices/backend.ts';
import { pinBundler } from '../devices/bundler.ts';
import { requireBooted, requireInstalled } from '../devices/common.ts';
import { dialDefaults, writeDialDefaults } from '../devices/dial.ts';
import { applyHygiene } from '../devices/hygiene.ts';
import { readIosBundle } from '../devices/variant.ts';
import { ensureSchemeApproval, launchApp, launchDevClient, rebootDevice } from '../devices/launch.ts';
import type { SimTools } from '../devices/tools.ts';
import { laneEnvironment, laneVariables, hookEnvironment, LAUNCH_ARGS_ENV, resourceVariables, webUrl } from '../hooks/env.ts';
import type { HookRun } from '../hooks/run.ts';
import { runHook } from '../hooks/run.ts';
import { CLI, CONFIG_FILE, TOOL } from '../name.ts';
import { identityOf } from '../processes.ts';
import type { HookName, MobileConfig, ProjectConfig, ProjectPlatform, ServiceConfig } from '../project/config.ts';
import { asMobile, findProjectConfig, forPlatform, loadProjectConfig } from '../project/config.ts';
import { WEB_PLATFORM } from '../project/schema.ts';
import { loadConfig, withProjectBlocks } from '../registry/config.ts';
import { formatAge, shellQuote } from '../registry/format.ts';
import { resolveOwner } from '../registry/owner.ts';
import { stateDir } from '../registry/paths.ts';
import { UsageError } from '../registry/refusal.ts';
import { Registry } from '../registry/registry.ts';
import type { Lane, LaneRef } from '../registry/types.ts';
import { resolveFolder } from '../registry-cli.ts';
import { explainInspection, inspectService } from '../services/services.ts';
import { laneDir, hookLog, pruneEndedLaneFiles, readUpRecord, writeUpRecord } from './lane-files.ts';
import { claimedPort, recordedProcess, startClaimedService, stopClaimedService } from './lane-services.ts';
import type { EnvDeps } from './deps.ts';
import type { DoctorReport } from './doctor.ts';
import { bundlerPort, diagnose, dialArguments, reversePorts } from './doctor.ts';
import { driverVariables } from './maestro-env.ts';
import { androidBuildEnvironment, projectFindings, toolchainFindings, Unmet } from './preflight.ts';
import { stopEndedLanes } from './release.ts';
import { createResources, tearDownEndedResources } from './resources.ts';

export interface UpOptions {
  setup: boolean;
  cacheMode: CacheMode;
  waitMs: number;
  worktree?: string | undefined;
  platform?: ProjectPlatform | undefined;
}

export interface StepTime {
  step: string;
  ms: number;
  detail: string;
}

export type BuildSummary =
  CachedBuildResult | { source: 'installed'; reason: 'no-build-hook' } | { source: 'build'; reason: 'no-cache-config' };

export interface UpResult {
  lane: Lane;
  created: boolean;
  platform: ProjectPlatform;
  /** The web app's URL on this lane, when the config has a web app. */
  url: string | null;
  config: string;
  logs: string;
  env: Record<string, string>;
  /** Null for the web app, which `up` does not build. */
  build: BuildSummary | null;
  steps: StepTime[];
  totalMs: number;
  doctor: DoctorReport;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function locateConfig(start: string): ProjectConfig {
  const file = findProjectConfig(start);
  if (!file) {
    throw new UsageError(
      `no ${CONFIG_FILE} in ${start} or the folders above it in this repository`,
      setupFix(`write one at the project's root ('${CLI} schema' prints its JSON Schema)`),
    );
  }
  return loadProjectConfig(file);
}

function projectBlocks(config: ProjectConfig): Record<string, { first: number; last: number }> {
  const blocks: Record<string, { first: number; last: number }> = {};
  for (const s of config.services) if (s.ports) blocks[s.type] = { first: s.ports[0], last: s.ports[1] };
  return blocks;
}

class Run {
  readonly steps: StepTime[] = [];
  private readonly deps: EnvDeps;

  constructor(deps: EnvDeps) {
    this.deps = deps;
  }

  async step<T>(name: string, work: () => Promise<T>, describe: (value: T) => string): Promise<T> {
    const started = this.deps.clock.now();
    const value = await work();
    const ms = this.deps.clock.now() - started;
    const detail = describe(value);
    this.steps.push({ step: name, ms, detail });
    this.deps.log(`${TOOL} up: ${name}: ${detail} (${seconds(ms)})`);
    return value;
  }
}

type Target = { platform: 'ios'; sim: SimTools; udid: string } | { platform: 'android'; adb: AdbTools; serial: string };

interface Ctx {
  deps: EnvDeps;
  registry: Registry;
  ref: LaneRef;
  lane: Lane;
  config: ProjectConfig;
  dir: string;
  env: NodeJS.ProcessEnv;
}

interface DeviceCtx extends Ctx {
  target: Target;
  config: MobileConfig;
}

async function hook(ctx: Ctx, name: HookName, extraEnv: Record<string, string> = {}): Promise<HookRun | null> {
  const command = ctx.config.hooks[name];
  if (!command) return null;
  const log = hookLog(ctx.dir, name);
  ctx.deps.log(`${TOOL} up: ${name}: ${command}   (log: ${log})`);
  ctx.registry.touch(ctx.ref, `up: ${name}`);
  return runHook(name, command, { cwd: ctx.config.dir, env: { ...ctx.env, ...extraEnv }, log });
}

async function bootDevice(sim: SimTools, udid: string, reboot: boolean): Promise<string> {
  const device = await sim.device(udid);
  if (device?.state === 'Booted') {
    if (!reboot) return 'already booted';
    await rebootDevice(sim, udid);
    return 'rebooted so the scheme approval takes effect';
  }
  await sim.boot(udid);
  await requireBooted(sim, udid);
  return 'booted';
}

function installer(target: Target): (app: string) => Promise<void> {
  return target.platform === 'ios' ? app => target.sim.installApp(target.udid, app) : apk => target.adb.install(apk);
}

async function installedApp(ctx: DeviceCtx, bundleId: string): Promise<string> {
  const { target } = ctx;
  if (target.platform === 'ios') {
    await requireInstalled(target.sim, target.udid, bundleId);
    const container = await target.sim.appContainer(target.udid, bundleId);
    if (!container) throw new Error(`${bundleId} is installed on ${target.udid}, but its app bundle can't be read back`);
    return container;
  }
  await requireAppInstalled(target.adb, bundleId);
  const apks = await target.adb.installedApk(bundleId);
  const [apk] = apks;
  if (apks.length !== 1 || apk === undefined) {
    throw new Error(
      `${bundleId} is installed on ${target.serial} as ${String(apks.length)} APKs, which the build cache can't store; set app.android.output to the APK the build hook writes`,
    );
  }
  const local = path.join(ctx.dir, 'installed', `${bundleId}.apk`);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  await target.adb.pull(apk, local);
  return local;
}

async function requireAppOnDevice(target: Target, bundleId: string): Promise<void> {
  if (target.platform === 'ios') await requireInstalled(target.sim, target.udid, bundleId);
  else await requireAppInstalled(target.adb, bundleId);
}

async function buildApp(ctx: DeviceCtx, mode: CacheMode): Promise<BuildSummary> {
  const { config, target } = ctx;
  const { bundleId, output } = config.app;
  const install = installer(target);
  if (!config.hooks.build) {
    await requireAppOnDevice(target, bundleId);
    return { source: 'installed', reason: 'no-build-hook' };
  }
  const env = config.app.platform === 'android' ? await androidBuildEnvironment(ctx.env, ctx.deps.toolchain) : ctx.env;
  const build = async (): Promise<string> => {
    await hook({ ...ctx, env }, 'build');
    if (output !== null) {
      const app = path.resolve(config.dir, output);
      await install(app);
      return app;
    }
    return installedApp(ctx, bundleId);
  };
  const cacheConfig = config.buildCache;
  if (!cacheConfig) {
    await build();
    return { source: 'build', reason: 'no-cache-config' };
  }
  const cache = new BuildCache({ dir: await cacheDirFor(config.dir), config: cacheConfig });
  const builder = identityOf(ctx.deps.processes, process.pid);
  return cachedBuild({
    cache,
    variant: config.app.variant,
    worktree: ctx.lane.worktree,
    mode,
    key: async () =>
      computeKey({
        root: config.dir,
        inputs: cacheConfig.inputs,
        platform: config.app.platform,
        variant: config.app.variant,
        toolchain:
          config.app.platform === 'ios'
            ? await ctx.deps.toolchain.xcodeVersion()
            : await ctx.deps.toolchain.androidToolchain(config.dir, env),
        ...(cacheConfig.envFile !== undefined ? { envFile: cacheConfig.envFile } : {}),
        env: ctx.env,
      }),
    install,
    build,
    ...(builder
      ? {
          wait: {
            builder,
            processes: ctx.deps.processes,
            clock: ctx.deps.clock,
            log: line => {
              ctx.deps.log(`${TOOL} up: build: ${line}`);
            },
          },
        }
      : {}),
  });
}

function describeBuild(result: BuildSummary): string {
  if (result.source === 'cache') {
    const waited = result.waited ? `, after waiting ${formatAge(result.waited.ms)} for that build` : '';
    return `served from the build cache (key ${result.key.slice(0, 12)}, built in ${result.origin.worktree} at ${result.origin.storedAt.toISOString()}${waited})`;
  }
  if (result.source === 'installed') return 'no build hook; the installed app is used';
  if (result.reason === 'no-cache-config') return 'built (no build cache configured)';
  const stored = result.stored ? `, stored as ${result.storedKey?.slice(0, 12) ?? ''}` : '';
  const waited = result.waited ? [`waited ${formatAge(result.waited.ms)} for ${result.waited.worktree}'s build first`] : [];
  const notes = [...waited, ...result.problems];
  const problems = notes.length > 0 ? `; ${notes.join('; ')}` : '';
  return `built (cache ${result.reason}${stored})${problems}`;
}

async function ensureService(ctx: Ctx, service: ServiceConfig): Promise<string> {
  const { deps, lane } = ctx;
  const port = claimedPort(lane, service.name);
  if (port === undefined) throw new Error(`lane ${lane.id} has no port for ${service.name}`);
  const recorded = recordedProcess(lane, service.name);
  if (recorded) {
    const seen = await inspectService(deps.system, service, port, recorded);
    if (seen.healthy) return `already running on ${String(port)} (pid ${String(recorded.pid)}); ${seen.readyDetail}`;
    const stopped = await stopClaimedService(ctx, recorded);
    const started = await startClaimedService(ctx, service, port);
    return `${started}, replacing pid ${String(recorded.pid)}, which failed its check (${explainInspection(seen)}): ${stopped}`;
  }
  return startClaimedService(ctx, service, port);
}

async function launchAndroid(ctx: DeviceCtx, adb: AdbTools): Promise<string> {
  const { config, lane } = ctx;
  const { bundleId } = config.app;
  const launchArgs = dialArguments(config, lane);
  const port = bundlerPort(config, lane);
  switch (config.app.launch) {
    case 'dev-client': {
      if (port === undefined) throw new Error(`no port for the bundler service ${config.app.bundler ?? '(none)'}`);
      if (config.app.scheme === null) {
        throw new UsageError(
          "an Expo dev client on Android opens its bundler through a link in the app's URL scheme, and app.scheme is not set",
          `set app.scheme in ${CONFIG_FILE} to the scheme in app.json`,
        );
      }
      const report = await launchAndroidDevClient(adb, { pkg: bundleId, scheme: config.app.scheme, port, launchArgs });
      return `dev client opened with am start ${report.intent.join(' ')}`;
    }
    case 'bundler-pin': {
      const report = await launchAndroidApp(adb, { pkg: bundleId, launchArgs });
      return `bundler pinned by adb reverse (localhost:${String(REACT_NATIVE_DEVICE_PORT)} on the emulator is Metro); launched with am start ${report.intent.join(' ')}`;
    }
    case 'hook': {
      await hook(ctx, 'launch', { [LAUNCH_ARGS_ENV]: intentLaunchArgs(launchArgs) });
      return 'the launch hook ran';
    }
  }
}

function intentLaunchArgs(launchArgs: readonly string[]): string {
  return intentExtras(launchArgs).map(shellQuote).join(' ');
}

async function launch(ctx: DeviceCtx): Promise<string> {
  ctx.registry.touch(ctx.ref, 'up: launch');
  if (ctx.target.platform === 'android') return launchAndroid(ctx, ctx.target.adb);
  const { config, lane } = ctx;
  const { sim, udid } = ctx.target;
  const { bundleId } = config.app;
  const launchArgs = dialArguments(config, lane);
  const port = bundlerPort(config, lane);
  switch (config.app.launch) {
    case 'dev-client': {
      if (port === undefined) throw new Error(`no port for the bundler service ${config.app.bundler ?? '(none)'}`);
      const report = await launchDevClient(sim, { udid, bundleId, port, launchArgs });
      return `dev client launched with ${report.args.join(' ')}`;
    }
    case 'bundler-pin': {
      if (port === undefined) throw new Error(`no port for the bundler service ${config.app.bundler ?? '(none)'}`);
      const pin = await pinBundler(sim, { udid, bundleId, port });
      const record = readUpRecord(ctx.dir);
      if (record) writeUpRecord(ctx.dir, { ...record, pinned: true, updatedAt: ctx.deps.clock.now() });
      const dials = dialDefaults(launchArgs);
      await writeDialDefaults(sim, { udid, bundleId, dials });
      const report = await launchApp(sim, { udid, bundleId, launchArgs });
      const kept = dials.length > 0 ? `; ${dials.map(d => d.key).join(', ')} kept in its defaults for relaunches` : '';
      return `bundler pinned to ${pin.readBack}; launched with ${report.args.join(' ') || 'no arguments'}${kept}`;
    }
    case 'hook': {
      await hook(ctx, 'launch', { [LAUNCH_ARGS_ENV]: launchArgs.map(shellQuote).join(' ') });
      return 'the launch hook ran';
    }
  }
}

async function keepDeviceNetwork(ctx: DeviceCtx, wanted: ReadonlyMap<number, number>, step: string): Promise<boolean> {
  if (ctx.target.platform !== 'android' || wanted.size === 0) return false;
  const after = `after ${step}`;
  const restored = await restoreReverse(ctx.target.adb, wanted, after);
  if (restored.size > 0) ctx.deps.log(`${TOOL} up: ${describeRestored(restored, ctx.target.serial, after)}`);
  return restored.size > 0;
}

const DETAILED_FINDINGS = new Set(['Xcode', 'simulator runtime', 'Android SDK', 'emulator image', 'Java 17']);

function deviceTarget(deps: EnvDeps, config: MobileConfig, lane: Lane, options: UpOptions): Target {
  const claimed = lane.device;
  if (!claimed) throw new Error(`lane ${lane.id} holds no device`);
  if (claimed.platform !== config.platform) {
    throw new UsageError(
      `this folder's lane ${lane.id} holds ${claimed.name}, ${DEVICE_NOUN[claimed.platform]}, and up is running for ${config.platform}`,
      `${CLI} release here, then ${CLI} up${options.platform === undefined ? '' : ` --platform ${options.platform}`}; or run ${CLI} up --platform ${claimed.platform}`,
    );
  }
  if (claimed.platform === 'android') {
    if (claimed.serial === null) throw new Error(`lane ${lane.id}'s emulator ${claimed.name} has no adb serial`);
    return { platform: 'android', adb: adbTools(deps, claimed.serial), serial: claimed.serial };
  }
  if (!deps.sim) throw new UsageError('this machine has no iOS simulators', 'run up on a Mac with Xcode installed');
  return { platform: 'ios', sim: deps.sim, udid: claimed.id };
}

interface Booted {
  ok: true;
  detail: string;
  ms: number;
}

type Booting = Promise<Booted | { ok: false; error: unknown }>;

async function deviceSteps(
  ctx: DeviceCtx,
  run: Run,
  options: UpOptions,
  booting: Booting,
  approval: { changed: boolean } | null,
  setup: boolean,
): Promise<BuildSummary> {
  const { deps, target, config, registry, lane, dir } = ctx;
  const udid = target.platform === 'ios' ? target.udid : target.serial;
  const booted = await booting;
  if (!booted.ok) throw booted.error;
  run.steps.push({ step: 'boot', ms: booted.ms, detail: booted.detail });
  deps.log(
    `${TOOL} up: boot: ${lane.device?.name ?? udid} ${booted.detail}${approval?.changed ? `, ${config.app.scheme ?? ''}:// approved before boot` : ''} (${seconds(booted.ms)}${setup ? ', alongside setup' : ''})`,
  );

  const build = await run.step('build', () => buildApp(ctx, options.cacheMode), describeBuild);
  if (target.platform === 'ios' && build.source !== 'installed') {
    const container = await target.sim.appContainer(udid, config.app.bundleId);
    const sha256 = container === undefined ? undefined : readIosBundle(container).sha256;
    const record = readUpRecord(dir);
    if (record && sha256 !== undefined) {
      writeUpRecord(dir, { ...record, installed: { variant: config.app.variant, sha256 }, updatedAt: deps.clock.now() });
    }
  }

  await serviceSteps(ctx, run);

  const wanted = target.platform === 'android' ? reversePorts(config, lane) : new Map<number, number>();
  if (target.platform === 'android') {
    await run.step(
      'device network',
      async () => {
        registry.touch(ctx.ref, 'up: device network');
        const report = await ensureReverse(target.adb, wanted);
        const record = readUpRecord(dir);
        if (record) writeUpRecord(dir, { ...record, reversed: [...wanted.keys()], updatedAt: deps.clock.now() });
        return report;
      },
      report =>
        wanted.size === 0
          ? 'nothing to forward'
          : `adb reverse ${describeReverse(wanted)}${report.added.length === 0 ? ' (already in place)' : ''}`,
    );
  }

  await run.step(
    'hygiene',
    async () => {
      registry.touch(ctx.ref, 'up: hygiene');
      return target.platform === 'ios'
        ? applyHygiene(target.sim, udid, config.hygiene)
        : applyAndroidHygiene(target.adb, config.hygiene);
    },
    report =>
      report.changed
        ? `applied ${report.steps
            .filter(s => s.changed)
            .map(s => s.step)
            .join(', ')}`
        : 'already in place',
  );

  await run.step(
    'launch',
    () => launch(ctx),
    detail => detail,
  );
  let relaunched = false;
  const relaunchIfDropped = async (step: string) => {
    if (!(await keepDeviceNetwork(ctx, wanted, step)) || relaunched) return;
    relaunched = true;
    await run.step(
      'relaunch',
      () => launch(ctx),
      detail => `${detail}, so the app loads its bundle again over the restored rules`,
    );
    await keepDeviceNetwork(ctx, wanted, 'relaunch');
  };
  await relaunchIfDropped('launch');

  if (config.hooks.signin) {
    await run.step(
      'signin',
      async () => hook(ctx, 'signin', await driverVariables(deps, config, lane, dir)),
      () => 'done',
    );
    await keepDeviceNetwork(ctx, wanted, 'signin');
  }

  if (config.driver) {
    await run.step(
      'driver',
      async () => {
        registry.touch(ctx.ref, 'up: driver');
        try {
          await deps.startDriver(lane, stateDir(deps.env));
          return 'started; the first look is warm';
        } catch (error) {
          return `not started (${(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''}); the first look starts it`;
        }
      },
      detail => detail,
    );
    if (config.hooks.signin) await keepDeviceNetwork(ctx, wanted, 'the driver started');
    else await relaunchIfDropped('the driver started');
  }
  return build;
}

async function serviceSteps(ctx: Ctx, run: Run): Promise<void> {
  for (const service of ctx.config.services) {
    await run.step(
      `service ${service.name}`,
      () => ensureService(ctx, service),
      detail => detail,
    );
  }
}

const TRACE_NOTE = "; the driver's actions are traced from here, and the trace is kept when a command under exec fails";

async function browserSteps(ctx: Ctx, run: Run, tools: BrowserTools, driverChanged: boolean): Promise<void> {
  const { lane, deps } = ctx;
  if (!hasBrowser(lane)) throw new Error(`lane ${lane.id} holds no browser`);
  const browserCtx: BrowserContext = {
    tools,
    stateDir: stateDir(deps.env),
    lane,
    config: ctx.config,
    url: webUrl(ctx.config, lane),
    env: deps.env,
    laneEnv: ctx.env,
    cwd: ctx.config.dir,
    log: line => {
      deps.log(`${TOOL} up: browser: ${line}`);
    },
  };
  const opened = await run.step(
    'browser',
    async () => {
      ctx.registry.touch(ctx.ref, 'up: browser');
      const done = await openWebApp(browserCtx, deps.clock, driverChanged);
      const traced = !ctx.config.hooks.signin && (await startFailureTrace(done.browser));
      return { ...done, detail: `${done.detail}${traced ? TRACE_NOTE : ''}` };
    },
    o => o.detail,
  );
  if (!ctx.config.hooks.signin) return;
  await run.step(
    'signin',
    async () => {
      fs.rmSync(opened.browser.setting.paths.storageState, { force: true });
      await hook(ctx, 'signin', opened.browser.vars);
      const login = await signInBrowser(browserCtx, opened.browser);
      const traced = await startFailureTrace(opened.browser);
      return `the browser starts with the saved login, ${describeSavedLogin(login)}${traced ? TRACE_NOTE : ''}`;
    },
    detail => detail,
  );
}

function describeResources(made: { created: string[]; kept: string[] }): string {
  const parts = [
    made.created.length > 0 ? `created ${made.created.join(', ')}` : '',
    made.kept.length > 0 ? `kept ${made.kept.join(', ')} from an earlier up of this lane` : '',
  ];
  return parts.filter(p => p !== '').join('; ');
}

export async function up(deps: EnvDeps, options: UpOptions): Promise<UpResult> {
  const started = deps.clock.now();
  const run = new Run(deps);
  const start = options.worktree ?? deps.cwd;
  const located = locateConfig(start);
  const config = forPlatform(located, options.platform ?? located.platform);
  const mobile = asMobile(config);
  const folder = resolveFolder(start);
  const backend = mobile ? deps.devices[mobile.platform] : undefined;

  await run.step(
    'preflight',
    async () => {
      const found = await toolchainFindings(config, { env: deps.env, toolchain: deps.toolchain, backend }, true);
      const failed = found.findings.find(f => !f.ok);
      if (failed) throw new Unmet(failed, deps.clock.now() - started);
      const project = await projectFindings(config, 'claim', hookEnvironment(deps.env, {}, resourceVariables(config)), true);
      const unmet = project.find(f => !f.ok);
      if (unmet) throw new Unmet(unmet, deps.clock.now() - started);
      return [...found.findings, ...project];
    },
    findings => findings.map(f => (DETAILED_FINDINGS.has(f.name) ? f.detail : f.name)).join('; '),
  );
  if (mobile && (!backend || (mobile.platform === 'ios' && !deps.sim))) {
    throw mobile.platform === 'android'
      ? new UsageError('this machine has no Android emulator backend', 'install the Android SDK and set ANDROID_HOME')
      : new UsageError('this machine has no iOS simulators', 'run up on a Mac with Xcode installed');
  }

  const state = stateDir(deps.env);
  const registry = Registry.open({
    dir: state,
    processes: deps.processes,
    ports: deps.ports,
    devices: deps.devices,
    config: withProjectBlocks(loadConfig(state), projectBlocks(config), config.file),
    clock: deps.clock,
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
  });
  try {
    const owner = resolveOwner(deps.env, deps.processes, deps.selfPid);
    const outcome = await run.step(
      'claim',
      async () => {
        const stop = deps.onCancel?.(() => registry.cancelPending());
        try {
          return await registry.claim({
            owner,
            worktree: folder.worktree,
            projectRoot: folder.projectRoot,
            services: config.services.map(s => ({ name: s.name, type: s.type })),
            device: mobile
              ? {
                  platform: mobile.platform,
                  deviceType: mobile.app.device.type,
                  runtime: mobile.app.device.runtime,
                  strict: mobile.app.device.strict,
                }
              : null,
            browser: config.platform === WEB_PLATFORM && config.web ? { driver: config.web.browser.driver } : null,
            waitMs: options.waitMs,
            action: 'up',
          });
        } finally {
          stop?.();
        }
      },
      o =>
        `${o.created ? 'claimed lane' : 'reusing lane'} ${o.lane.id}: ${o.lane.device?.name ?? 'no device'}${o.lane.device ? ` (${o.lane.device.id})` : ''}${o.lane.browser ? `, a ${o.lane.browser.driver} browser` : ''}, ${o.lane.ports.map(p => `${p.service} ${String(p.port)}`).join(', ')}`,
    );
    for (const note of outcome.notes) deps.log(`${TOOL} up: ${note}`);
    for (const e of [...outcome.freed, ...outcome.tookOver]) {
      deps.log(
        `${TOOL} up: ended lane ${e.id} of ${e.owner} in ${e.worktree} (${e.reason}, idle ${formatAge(e.endedAt - e.lastUsedAt)})`,
      );
    }
    const browsers = deps.browser ?? realBrowserTools;
    const ended = [
      ...(await stopEndedLanes(deps, state, [...outcome.freed, ...outcome.tookOver])),
      ...(await stopEndedBrowsers(browsers, registry, state, deps.clock)),
      ...(await tearDownEndedResources(deps, registry, state)),
    ];
    for (const stopped of ended) {
      for (const line of [...stopped.notes, ...stopped.problems]) deps.log(`${TOOL} up: lane ${stopped.lane}: ${line}`);
    }

    const { lane } = outcome;
    const target = mobile ? deviceTarget(deps, mobile, lane, options) : null;
    const dir = laneDir(state, lane.id);
    const previous = readUpRecord(dir);
    writeUpRecord(dir, {
      version: 1,
      lane: lane.id,
      config: config.file,
      platform: config.platform,
      platforms: [...new Set([...(previous?.platforms ?? (previous ? [previous.platform] : [])), config.platform])],
      bundleId: mobile?.app.bundleId ?? previous?.bundleId ?? null,
      launch: mobile?.app.launch ?? previous?.launch ?? null,
      pinned: previous?.pinned ?? false,
      updatedAt: deps.clock.now(),
    });
    pruneEndedLaneFiles(
      state,
      new Set([...registry.status().lanes.map(c => c.id), ...registry.pendingTeardowns().map(t => t.lane)]),
      deps.clock.now(),
      deps.env,
    );
    const ctx: Ctx = {
      deps,
      registry,
      ref: { id: lane.id, token: lane.token },
      lane,
      config,
      dir,
      env: laneEnvironment(deps.env, lane, config, dir),
    };
    const device: DeviceCtx | null = mobile && target ? { ...ctx, config: mobile, target } : null;
    const beforeResources: Ctx = { ...ctx, env: laneEnvironment(deps.env, { ...lane, resources: [] }, config, dir) };

    const approval =
      target?.platform === 'ios' && mobile?.app.scheme
        ? await ensureSchemeApproval(target.sim, { udid: target.udid, scheme: mobile.app.scheme, bundleId: mobile.app.bundleId })
        : null;
    const startBoot = (t: Target): Booting => {
      const bootStarted = deps.clock.now();
      const booting =
        t.platform === 'ios'
          ? bootDevice(t.sim, t.udid, approval?.needsReboot ?? false)
          : requireEmulatorBooted(t.adb).then(() => `booted by the lane as ${t.serial}`);
      return booting.then(
        detail => ({ ok: true as const, detail, ms: deps.clock.now() - bootStarted }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    };
    const setup = options.setup && config.hooks.setup !== undefined;
    const bootingWithSetup = setup && target ? startBoot(target) : null;
    try {
      if (setup) {
        await run.step(
          'setup',
          () => hook(beforeResources, 'setup'),
          () => 'done',
        );
      }
      await run.step(
        'build preconditions',
        async () => {
          const project = await projectFindings(config, 'build', beforeResources.env, true);
          const unmet = project.find(f => !f.ok);
          if (unmet) throw new Unmet(unmet, deps.clock.now() - started);
          return project;
        },
        found => (found.length === 0 ? 'none declared' : found.map(f => f.name).join('; ')),
      );
    } catch (error) {
      if (bootingWithSetup) await bootingWithSetup;
      if (error instanceof Unmet && outcome.created) {
        registry.release(ctx.ref, owner);
        deps.log(`${TOOL} up: released lane ${lane.id}, which this run made, so the refusal leaves nothing behind`);
      }
      throw error;
    }
    const booting = bootingWithSetup ?? (target ? startBoot(target) : null);
    if (config.resources.length > 0) {
      try {
        const made = await run.step('resources', () => createResources(ctx, ctx.lane), describeResources);
        ctx.lane = made.lane;
        ctx.env = laneEnvironment(deps.env, made.lane, config, dir);
        if (device) {
          device.lane = made.lane;
          device.env = ctx.env;
        }
      } catch (error) {
        if (booting) await booting;
        throw error;
      }
    }

    let build: BuildSummary | null = null;
    if (device && booting) build = await deviceSteps(device, run, options, booting, approval, setup);
    else {
      await serviceSteps(ctx, run);
      if (config.platform === WEB_PLATFORM) await browserSteps(ctx, run, browsers, outcome.replacedDriver !== null);
    }

    const fresh = registry.find(owner, folder.worktree);
    if (!fresh) throw new Error(`lane ${lane.id} ended while up was running`);
    registry.touch(ctx.ref, 'up: doctor');
    const doctor = await run.step(
      'doctor',
      () =>
        diagnose(deps, {
          config,
          configProblem: null,
          lane: fresh,
          ownerState: 'alive',
          folder: folder.worktree,
          installed: readUpRecord(dir)?.installed,
        }),
      report => (report.ok ? 'ready' : `${String(report.checks.filter(c => !c.ok).length)} check(s) failed`),
    );
    return {
      lane: fresh,
      created: outcome.created,
      platform: config.platform,
      url: webUrl(config, fresh),
      config: config.file,
      logs: dir,
      env: laneVariables(fresh, config, dir),
      build,
      steps: run.steps,
      totalMs: deps.clock.now() - started,
      doctor,
    };
  } finally {
    registry.close();
  }
}
