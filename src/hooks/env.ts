import path from 'node:path';
import { ENV_PREFIX, envName } from '../name.ts';
import type { ProjectConfig } from '../project/config.ts';
import { BUILT_IN_SERVICE_TYPES, WEB_PLATFORM } from '../project/schema.ts';
import { OWNER_PID_ENV } from '../registry/owner.ts';
import { STATE_DIR_ENV } from '../registry/paths.ts';
import type { LaneInfo } from '../registry/types.ts';

/** glibc has C.UTF-8 built in, but en_US.UTF-8 only where the locales package generated it; macOS has no C.UTF-8. */
export function hookLocale(platform: NodeJS.Platform = process.platform): string {
  return platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8';
}

export const HOOK_LOCALE = hookLocale();
export const JAVA_HOME_ENV = envName('JAVA_HOME');
export const LOGS_ENV = envName('LOGS');
export const VARIANT_ENV = envName('VARIANT');
export const LAUNCH_ARGS_ENV = envName('LAUNCH_ARGS');
export const LANE_TOKEN_ENV = envName('LANE_TOKEN');
export const WEB_URL_ENV = envName('WEB_URL');
export const EVIDENCE_ENV = envName('EVIDENCE');

/** Where a lane keeps recordings, traces, screenshots and logs taken on demand or on failure; it outlives the lane. */
export function evidenceDir(logsDir: string): string {
  return path.join(logsDir, 'evidence');
}

const SETTINGS = new Set([STATE_DIR_ENV, OWNER_PID_ENV, JAVA_HOME_ENV]);

export function portVariable(service: string): string {
  return envName(`${service.toUpperCase().replaceAll('-', '_')}_PORT`);
}

/** The web app's URL on this lane's port for its service, or null when the config has no web app or the lane no port. */
export function webUrl(config: ProjectConfig | null, lane: LaneInfo): string | null {
  const web = config?.web;
  const port = web ? lane.ports.find(p => p.service === web.service)?.port : undefined;
  return web && port !== undefined ? `http://localhost:${String(port)}${web.path}` : null;
}

export function laneVariables(
  lane: LaneInfo & { token?: string },
  config: ProjectConfig | null,
  logsDir: string | null,
): Record<string, string> {
  const vars: Record<string, string> = { [envName('LANE')]: lane.id };
  if (lane.token !== undefined) vars[LANE_TOKEN_ENV] = lane.token;
  vars[envName('WORKTREE')] = lane.worktree;
  if (config?.platform === WEB_PLATFORM) vars[envName('PLATFORM')] = WEB_PLATFORM;
  else if (lane.device) vars[envName('PLATFORM')] = lane.device.platform;
  if (lane.device) vars[envName('DEVICE')] = lane.device.serial ?? lane.device.id;
  for (const p of lane.ports) vars[portVariable(p.service)] = String(p.port);
  for (const type of BUILT_IN_SERVICE_TYPES) {
    const ofType = lane.ports.filter(p => p.type === type);
    const [only] = ofType;
    if (!(portVariable(type) in vars) && ofType.length === 1 && only) vars[portVariable(type)] = String(only.port);
  }
  const url = webUrl(config, lane);
  if (url !== null) vars[WEB_URL_ENV] = url;
  if (config?.app) vars[VARIANT_ENV] = config.app.variant;
  if (logsDir) {
    vars[LOGS_ENV] = logsDir;
    vars[EVIDENCE_ENV] = evidenceDir(logsDir);
  }
  for (const resource of lane.resources) Object.assign(vars, resource.exports);
  return vars;
}

/** Every variable the config's resources export, which a lane's commands never take from the caller's environment. */
export function resourceVariables(config: ProjectConfig | null): string[] {
  return config ? config.resources.flatMap(r => r.exports) : [];
}

export function hookEnvironment(
  base: NodeJS.ProcessEnv,
  vars: Readonly<Record<string, string>>,
  cleared: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const unset = new Set(cleared);
  for (const [key, value] of Object.entries(base)) {
    if ((key.startsWith(`${ENV_PREFIX}_`) && !SETTINGS.has(key)) || unset.has(key)) continue;
    env[key] = value;
  }
  return { ...env, ...vars, LANG: HOOK_LOCALE, LC_ALL: HOOK_LOCALE };
}

/** The environment of a command run for a lane: its variables, and none of its resources' names from the caller. */
export function laneEnvironment(
  base: NodeJS.ProcessEnv,
  lane: LaneInfo & { token?: string },
  config: ProjectConfig | null,
  logsDir: string | null,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return hookEnvironment(base, { ...laneVariables(lane, config, logsDir), ...extra }, resourceVariables(config));
}
