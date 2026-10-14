import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserDriverName } from '../browser/kinds.ts';
import { BROWSER_SERVICES, DEFAULT_BROWSER_DRIVER } from '../browser/kinds.ts';
import { AGENT_BROWSER_RELEASE } from '../browser/release.ts';
import type { BuildCacheConfig } from '../cache/config.ts';
import { parseBuildCacheConfig } from '../cache/config.ts';
import type { Appearance, Coordinate } from '../devices/tools.ts';
import type { Platform } from '../devices/backend.ts';
import { CLI, CONFIG_FILE, ENV_PREFIX, FORMER, SCHEMA_FILE, TOOL } from '../name.ts';
import { UsageError } from '../registry/refusal.ts';
import type { HOOK_NAMES, LAUNCH_MODES, PRECONDITION_STAGES, PROJECT_PLATFORMS } from './schema.ts';
import {
  BUILT_IN_SERVICE_TYPES,
  DEFAULT_DIAL_VALUE,
  DEFAULT_READY_HOST,
  DEFAULT_READY_SECONDS,
  DEFAULT_TEARDOWN_SECONDS,
  DEFAULT_VARIANT,
  DEFAULT_WEB_PATH,
  projectSchema,
  WEB_PLATFORM,
} from './schema.ts';
import type { SchemaProblem } from './validate.ts';
import { SchemaValidator } from './validate.ts';

export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type HookName = (typeof HOOK_NAMES)[number];
export type PreconditionStage = (typeof PRECONDITION_STAGES)[number];
export type ProjectPlatform = (typeof PROJECT_PLATFORMS)[number];

export interface DeviceConfig {
  type?: string;
  runtime?: string;
  strict?: boolean;
}

export interface AppConfig {
  platform: Platform;
  bundleId: string;
  scheme: string | null;
  launch: LaunchMode;
  bundler: string | null;
  variant: string;
  output: string | null;
  device: DeviceConfig;
}

/** What `app.ios` or `app.android` replaces when `up` runs for that platform. */
export interface PlatformAppConfig {
  bundleId?: string;
  output?: string;
  device?: DeviceConfig;
}

export type ReadyCheck =
  { kind: 'http'; host: string; path: string; status: number; body: string | null } | { kind: 'tcp'; host: string };

export interface ServiceConfig {
  name: string;
  type: string;
  ports: [number, number] | null;
  start: string;
  cwd: string;
  ready: ReadyCheck;
  timeoutMs: number;
  dial: { argument: string; value: string } | null;
  /** The platforms that need the service; null for every platform. */
  platforms: ProjectPlatform[] | null;
}

export interface Precondition {
  name: string;
  run: string;
  fix: string;
  before: PreconditionStage;
  platforms: ProjectPlatform[] | null;
}

export interface BrowserConfig {
  driver: BrowserDriverName;
  headed: boolean;
}

export interface WebAppConfig {
  service: string;
  path: string;
  browser: BrowserConfig;
}

export interface ResourceConfig {
  name: string;
  create: string;
  exports: string[];
  teardown: string;
  cwd: string;
  teardownTimeoutMs: number;
}

export interface ProjectConfig {
  file: string;
  dir: string;
  /** The platform this view of the config is for: `up --platform`, else the app's platform, else web. */
  platform: ProjectPlatform;
  /** The mobile app, as `up` sees it on `platform` when that is a mobile platform. */
  app: AppConfig | null;
  platformApps: Partial<Record<Platform, PlatformAppConfig>>;
  baseApp: AppConfig | null;
  web: WebAppConfig | null;
  /** The services `platform` needs. */
  services: ServiceConfig[];
  /** Every service, whatever platform needs it. */
  allServices: ServiceConfig[];
  resources: ResourceConfig[];
  hooks: Partial<Record<HookName, string>>;
  preconditions: Precondition[];
  hygiene: { location?: Coordinate; appearance?: Appearance };
  buildCache: BuildCacheConfig | null;
  driver: { flows: string | null } | null;
}

/** The config as `up` sees it for a mobile platform. */
export type MobileConfig = ProjectConfig & { platform: Platform; app: AppConfig };

export function asMobile(config: ProjectConfig): MobileConfig | null {
  const { app, platform } = config;
  return app !== null && platform !== WEB_PLATFORM ? { ...config, app, platform } : null;
}

export class ProjectConfigError extends Error {
  readonly file: string;
  readonly problems: readonly SchemaProblem[];

  constructor(file: string, problems: readonly SchemaProblem[]) {
    const shown = problems.slice(0, 6).map(p => `  ${p.path || '/'} ${p.message}\n    (schema: ${p.schemaPath})`);
    const more = problems.length > shown.length ? [`  ... and ${String(problems.length - shown.length)} more`] : [];
    super(`${file} is not a valid ${CONFIG_FILE}:\n${[...shown, ...more].join('\n')}`);
    this.name = 'ProjectConfigError';
    this.file = file;
    this.problems = problems;
  }
}

const validator = new SchemaValidator(projectSchema);

interface RawService {
  type: string;
  ports?: [number, number];
  start: string;
  cwd?: string;
  ready: { kind: 'http'; path: string; status?: number; body?: string; host?: string } | { kind: 'tcp'; host?: string };
  timeoutSeconds?: number;
  dial?: { argument: string; value?: string };
  platforms?: ProjectPlatform[];
}

interface RawResource {
  create: string;
  exports?: string[];
  teardown: string;
  cwd?: string;
  teardownTimeoutSeconds?: number;
}

interface RawConfig {
  web?: { service?: string; path?: string; browser?: { driver?: BrowserDriverName; headed?: boolean } };
  resources?: Record<string, RawResource>;
  app?: {
    platform: Platform;
    bundleId: string;
    scheme?: string;
    launch: LaunchMode;
    bundler?: string;
    variant?: string;
    output?: string;
    device?: DeviceConfig;
    ios?: PlatformAppConfig;
    android?: PlatformAppConfig;
  };
  services?: Record<string, RawService>;
  hooks?: Partial<Record<HookName, string>>;
  preconditions?: { name: string; run: string; fix: string; before?: PreconditionStage; platforms?: ProjectPlatform[] }[];
  hygiene?: { location?: Coordinate; appearance?: Appearance };
  buildCache?: unknown;
  driver?: { flows?: string };
}

function problem(pathText: string, message: string): SchemaProblem {
  return { path: pathText, schemaPath: '(cross-field rule)', message };
}

const RESERVED_EXPORTS = new Set(['LANG', 'LC_ALL']);

function appProblems(raw: RawConfig, services: [string, RawService][]): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const launchHook = raw.hooks?.launch;
  if (!raw.app) {
    if (launchHook !== undefined) problems.push(problem('/hooks/launch', 'launches the mobile app, and there is no app'));
    return problems;
  }
  const { launch, bundler } = raw.app;
  if (launch === 'hook' && launchHook === undefined) {
    problems.push(problem('/hooks/launch', 'is required when app.launch is "hook"'));
  }
  if (launch !== 'hook' && launchHook !== undefined) {
    problems.push(problem('/hooks/launch', `is not used when app.launch is "${launch}"; remove it, or set app.launch to "hook"`));
  }
  const bundlerService = services.find(([name, s]) => (bundler === undefined ? s.type === 'metro' : name === bundler));
  const missing = bundlerService?.[1].platforms?.filter(p => p === 'ios' || p === 'android') ?? null;
  if (bundlerService && missing !== null && !missing.includes(raw.app.platform)) {
    problems.push(
      problem(
        `/services/${bundlerService[0]}/platforms`,
        `leaves out ${raw.app.platform}, and the app loads its JavaScript from ${bundlerService[0]} there; add "${raw.app.platform}"`,
      ),
    );
  }
  if (bundler !== undefined && !services.some(([name]) => name === bundler)) {
    problems.push(
      problem('/app/bundler', `names no service; the services are: ${services.map(([n]) => n).join(', ') || 'none'}`),
    );
  }
  if (launch !== 'hook' && bundler === undefined) {
    const metro = services.filter(([, s]) => s.type === 'metro');
    if (metro.length !== 1) {
      problems.push(
        problem(
          '/app/bundler',
          `is required: app.launch "${launch}" loads the app from a bundler, and ${String(metro.length)} services have type metro; name one in app.bundler`,
        ),
      );
    }
  }
  return problems;
}

function webProblems(raw: RawConfig, services: [string, RawService][]): SchemaProblem[] {
  if (!raw.web) return [];
  const named = raw.web.service;
  const serving = services.find(([name, s]) => (named === undefined ? s.type === 'web' : name === named));
  if (serving?.[1].platforms && !serving[1].platforms.includes(WEB_PLATFORM)) {
    return [problem(`/services/${serving[0]}/platforms`, `leaves out web, and ${serving[0]} serves the web app; add "web"`)];
  }
  if (named !== undefined) {
    return services.some(([name]) => name === named)
      ? []
      : [problem('/web/service', `names no service; the services are: ${services.map(([n]) => n).join(', ') || 'none'}`)];
  }
  const web = services.filter(([, s]) => s.type === 'web');
  return web.length === 1
    ? []
    : [
        problem(
          '/web/service',
          `is required: ${String(web.length)} services have type web, and the web app is served by one; name it in web.service`,
        ),
      ];
}

function browserProblems(raw: RawConfig): SchemaProblem[] {
  const browser = raw.web?.browser;
  if (browser?.driver !== 'agent-browser' || browser.headed !== true) return [];
  return [
    problem(
      '/web/browser/headed',
      `can't be true with driver agent-browser: agent-browser ${AGENT_BROWSER_RELEASE.version} runs a window only on full Chrome, which it can't start on the lane's own debugging port; use driver playwright to watch the browser`,
    ),
  ];
}

function resourceProblems(raw: RawConfig): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const exporter = new Map<string, string>();
  for (const [name, resource] of Object.entries(raw.resources ?? {})) {
    (resource.exports ?? []).forEach((variable, i) => {
      const at = `/resources/${name}/exports/${String(i)}`;
      if (variable.startsWith(`${ENV_PREFIX}_`) || RESERVED_EXPORTS.has(variable)) {
        problems.push(problem(at, `${variable} is set by ${TOOL} itself; export it under another name`));
      }
      const first = exporter.get(variable);
      if (first !== undefined) problems.push(problem(at, `${variable} is exported by resource ${first} too; export it from one`));
      else exporter.set(variable, name);
    });
  }
  return problems;
}

function crossFieldProblems(raw: RawConfig): SchemaProblem[] {
  const services = Object.entries(raw.services ?? {});
  const problems: SchemaProblem[] = [];
  if (!raw.app && !raw.web) {
    problems.push(problem('', 'declares no app: add app (a mobile app), web (a web app), or both'));
  }
  problems.push(...appProblems(raw, services), ...webProblems(raw, services), ...browserProblems(raw), ...resourceProblems(raw));
  for (const [name, service] of services) {
    if (BROWSER_SERVICES.includes(name)) {
      problems.push(problem(`/services/${name}`, `${name} is the name of the lane's browser ports; name the service otherwise`));
    }
    const builtIn = (BUILT_IN_SERVICE_TYPES as readonly string[]).includes(service.type);
    if (builtIn && service.ports !== undefined) {
      problems.push(
        problem(`/services/${name}/ports`, `is not allowed for type ${service.type}, which uses the Mac's ${service.type} block`),
      );
    }
    if (!builtIn && service.ports === undefined) {
      problems.push(problem(`/services/${name}/ports`, `is required for type ${service.type}, which has no built-in port block`));
    }
    if (service.ports && service.ports[0] > service.ports[1]) {
      problems.push(problem(`/services/${name}/ports`, 'must be [first, last] with first <= last'));
    }
  }
  return problems;
}

function normalize(raw: RawConfig, file: string): ProjectConfig {
  const dir = path.dirname(file);
  const services = Object.entries(raw.services ?? {}).map(([name, s]): ServiceConfig => {
    const host = s.ready.host ?? DEFAULT_READY_HOST;
    return {
      name,
      type: s.type,
      ports: s.ports ?? null,
      start: s.start,
      cwd: path.resolve(dir, s.cwd ?? '.'),
      ready:
        s.ready.kind === 'http'
          ? { kind: 'http', host, path: s.ready.path, status: s.ready.status ?? 200, body: s.ready.body ?? null }
          : { kind: 'tcp', host },
      timeoutMs: (s.timeoutSeconds ?? DEFAULT_READY_SECONDS) * 1000,
      dial: s.dial ? { argument: s.dial.argument, value: s.dial.value ?? DEFAULT_DIAL_VALUE } : null,
      platforms: s.platforms ?? null,
    };
  });
  const { app } = raw;
  const baseApp: AppConfig | null = app
    ? {
        platform: app.platform,
        bundleId: app.bundleId,
        scheme: app.scheme ?? null,
        launch: app.launch,
        bundler: app.bundler ?? services.find(s => s.type === 'metro')?.name ?? null,
        variant: app.variant ?? DEFAULT_VARIANT,
        output: app.output ?? null,
        device: deviceOf(app.device),
      }
    : null;
  const platformApps: Partial<Record<Platform, PlatformAppConfig>> = {};
  if (app?.ios) platformApps.ios = app.ios;
  if (app?.android) platformApps.android = app.android;
  const web: WebAppConfig | null = raw.web
    ? {
        service: raw.web.service ?? services.find(s => s.type === 'web')?.name ?? '',
        path: raw.web.path ?? DEFAULT_WEB_PATH,
        browser: {
          driver: raw.web.browser?.driver ?? DEFAULT_BROWSER_DRIVER,
          headed: raw.web.browser?.headed ?? false,
        },
      }
    : null;
  const platform = baseApp?.platform ?? WEB_PLATFORM;
  return {
    file,
    dir,
    platform,
    app: baseApp && resolveApp(baseApp, platformApps, baseApp.platform),
    platformApps,
    baseApp,
    web,
    services: servicesFor(services, platform),
    allServices: services,
    resources: Object.entries(raw.resources ?? {}).map(([name, r]) => ({
      name,
      create: r.create,
      exports: r.exports ?? [],
      teardown: r.teardown,
      cwd: path.resolve(dir, r.cwd ?? '.'),
      teardownTimeoutMs: (r.teardownTimeoutSeconds ?? DEFAULT_TEARDOWN_SECONDS) * 1000,
    })),
    hooks: { ...raw.hooks },
    preconditions: (raw.preconditions ?? []).map(p => ({
      name: p.name,
      run: p.run,
      fix: p.fix,
      before: p.before ?? 'claim',
      platforms: p.platforms ?? null,
    })),
    hygiene: { ...raw.hygiene },
    buildCache: raw.buildCache === undefined ? null : parseBuildCacheConfig(raw.buildCache),
    driver: raw.driver ? { flows: raw.driver.flows ?? null } : null,
  };
}

function deviceOf(raw: DeviceConfig | undefined): DeviceConfig {
  const device: DeviceConfig = {};
  if (raw?.type !== undefined) device.type = raw.type;
  if (raw?.runtime !== undefined) device.runtime = raw.runtime;
  if (raw?.strict !== undefined) device.strict = raw.strict;
  return device;
}

function resolveApp(base: AppConfig, platformApps: Partial<Record<Platform, PlatformAppConfig>>, platform: Platform): AppConfig {
  const own = platformApps[platform];
  return {
    ...base,
    platform,
    bundleId: own?.bundleId ?? base.bundleId,
    output: own?.output ?? base.output,
    device: own?.device ? deviceOf(own.device) : base.device,
  };
}

export function servicesFor(services: readonly ServiceConfig[], platform: ProjectPlatform): ServiceConfig[] {
  return services.filter(s => s.platforms === null || s.platforms.includes(platform));
}

export function declaredPlatforms(config: ProjectConfig): ProjectPlatform[] {
  const mobile: Platform[] = config.baseApp ? ['ios', 'android'] : [];
  return config.web ? [...mobile, WEB_PLATFORM] : mobile;
}

/**
 * The config as `up` sees it for one platform: app.ios or app.android replace the app's fields they name. A platform
 * the config declares no app for is refused.
 */
export function forPlatform(config: ProjectConfig, platform: ProjectPlatform): ProjectConfig {
  if (platform === WEB_PLATFORM) {
    if (!config.web) {
      throw new UsageError(
        `${config.file} declares no web app`,
        `add a web block naming the service that serves it, or run ${CLI} up --platform ${config.baseApp?.platform ?? 'ios'}`,
      );
    }
    return { ...config, platform, app: null, services: servicesFor(config.allServices, platform) };
  }
  if (!config.baseApp) {
    throw new UsageError(
      `${config.file} declares no mobile app, only a web app`,
      `run ${CLI} up --platform ${WEB_PLATFORM}, or add an app block for ${platform}`,
    );
  }
  const services = servicesFor(config.allServices, platform);
  const { bundler } = config.baseApp;
  if (bundler !== null && !services.some(s => s.name === bundler)) {
    throw new UsageError(
      `the app loads its JavaScript from ${bundler}, and ${bundler}'s platforms in ${config.file} leave out ${platform}`,
      `add "${platform}" to services.${bundler}.platforms, or run ${CLI} up --platform ${config.baseApp.platform}`,
    );
  }
  return { ...config, platform, app: resolveApp(config.baseApp, config.platformApps, platform), services };
}

/** The config a lane was brought up with: for its platform, while the config still declares that platform. */
export function loadLaneConfig(file: string, platform: ProjectPlatform | undefined): ProjectConfig {
  const loaded = loadProjectConfig(file);
  return platform !== undefined && declaredPlatforms(loaded).includes(platform) ? forPlatform(loaded, platform) : loaded;
}

export function parseProjectConfig(raw: unknown, file: string): ProjectConfig {
  const problems = validator.validate(raw);
  if (problems.length > 0) throw new ProjectConfigError(file, problems);
  const typed = raw as RawConfig;
  const crossField = crossFieldProblems(typed);
  if (crossField.length > 0) throw new ProjectConfigError(file, crossField);
  return normalize(typed, file);
}

export function loadProjectConfig(file: string): ProjectConfig {
  if (path.basename(file) === FORMER.configFile) throw formerConfigError(file);
  const text = fs.readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProjectConfigError(file, [{ path: '', schemaPath: '(JSON syntax)', message: (error as Error).message }]);
  }
  return parseProjectConfig(raw, file);
}

function gitTop(dir: string): string | null {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? fs.realpathSync(result.stdout.trim()) : null;
}

/** The nearest config at or above `start`, under this version's name or 0.2.x's, within the git worktree. */
export function findConfigFile(start: string): string | null {
  let dir = fs.realpathSync(start);
  const stop = gitTop(dir);
  for (;;) {
    for (const name of [CONFIG_FILE, FORMER.configFile]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir) return null;
    dir = parent;
  }
}

export function formerConfigError(file: string): UsageError {
  return new UsageError(
    `${file} is a 0.2.x config; ${TOOL} reads ${CONFIG_FILE}`,
    `rename it to ${CONFIG_FILE}, point its "$schema" at ${SCHEMA_FILE}, and rename the ${FORMER.envPrefix}_ variables in it and in the scripts it runs to ${ENV_PREFIX}_ (${FORMER.envPrefix}_CLAIM is ${ENV_PREFIX}_LANE now); the CHANGELOG's 0.3.0 section lists every rename`,
  );
}

/** The nearest config at or above `start`; 0.2.x's config there is refused with the renames it needs. */
export function findProjectConfig(start: string): string | null {
  const found = findConfigFile(start);
  if (found !== null && path.basename(found) === FORMER.configFile) throw formerConfigError(found);
  return found;
}
