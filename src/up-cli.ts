import { parseArgs } from 'node:util';
import { setupFix } from './agents/skills.ts';
import type { CacheMode } from './cache/build.ts';
import { DeviceBackendError } from './devices/backend.ts';
import { DeviceStateError } from './devices/common.ts';
import { DeviceCommandError } from './devices/xcrun.ts';
import { DriverError } from './driver/errors.ts';
import { HookFailed } from './hooks/run.ts';
import { CLI, CONFIG_FILE, envName, TOOL } from './name.ts';
import type { ProjectConfig, ProjectPlatform } from './project/config.ts';
import { findProjectConfig, forPlatform, loadProjectConfig, ProjectConfigError } from './project/config.ts';
import { PROJECT_PLATFORMS, schemaText } from './project/schema.ts';
import { shellQuote } from './registry/format.ts';
import { ownerKey, resolveOwner } from './registry/owner.ts';
import { stateDir } from './registry/paths.ts';
import { NotClaimed, Refusal, UsageError } from './registry/refusal.ts';
import { readRegistryStatus } from './registry/registry.ts';
import { resolveFolder } from './registry-cli.ts';
import { ServiceFailed } from './services/services.ts';
import { laneDir, readUpRecord } from './up/lane-files.ts';
import type { EnvDeps } from './up/deps.ts';
import { diagnose, renderDoctor } from './up/doctor.ts';
import { execInLane } from './up/exec.ts';
import { Unmet } from './up/preflight.ts';
import { ResourceFailed } from './up/resources.ts';
import { restart } from './up/restart.ts';
import { runSetup } from './up/setup.ts';
import { up } from './up/up.ts';
import { groupUsage, helpOf, type UsageGroup } from './usage.ts';

export const UP_COMMANDS = ['up', 'restart', 'setup', 'exec', 'doctor', 'schema'] as const;

export const UP_HELP: UsageGroup<(typeof UP_COMMANDS)[number]> = {
  title: `Environment (reads ${CONFIG_FILE} from this folder or the ones above it):`,
  entries: {
    up: `  up         Take this worktree from bare to the running app on its own simulator or emulator,
             or to its web app's services: preflight, claim, setup, resources, build (through the
             build cache), services, hygiene, launch, signin, doctor; a web app skips the device
             steps. Prints shell exports on stdout: eval "$(${TOOL} up)".
               --platform <name>     ios, android or web (default: the config's app.platform, or
                                     web when it declares only a web app)
               --no-setup            skip the setup hook (it already ran in this worktree)
               --no-cache            build without the build cache
               --refresh-cache       build, and replace the cached build
               --timeout <seconds>   how long to queue for a simulator (default 600)
               --worktree <dir>      the folder to bring up (default: this one)
               --json                print the result as JSON instead of exports
`,
    restart: `  restart    Stop one of this lane's services and start it again on the same port, with this
             call's environment: KEY=value ${TOOL} restart api. This is how to change a service's
             environment (a feature switch, an admin toggle, a client gate) without release and up.
             The service gets the lane's variables plus this call's environment, as up gives it;
             a variable passed to up and not to restart is gone. Returns once its ready check
             passes; the lane, the device, the app and every other service stay as they are.
               --worktree <dir>      the folder whose lane to use (default: this one)
               --json                print the result as JSON
`,
    setup: `  setup      Run the project's setup hook in this worktree, without claiming anything
             (it gets ${envName('WORKTREE')} and the hook locale only).
               --worktree <dir>      the folder to set up (default: this one)
`,
    exec: `  exec       Run one command with this lane's environment: ${TOOL} exec -- <command> [args...]
             With a driver block, 'maestro' there is the toolkit's build on this lane's device,
             with JDK 17 and the lane's runner token: ${TOOL} exec -- maestro test <flow.yaml>
             Without one, or with an invalid config or no running device, 'maestro' says why and
             runs nothing.
`,
    doctor: `  doctor     Is this worktree's instance worth driving? Checks the lane, toolchain, device,
             app, launch, services and hygiene, read-only; exit 1 names each fix.
               --platform <name>     check the config for ios, android or web, as up --platform builds it;
                                     a lane holding the other platform's device fails the lane check
                                     (default: the platform up ran for, else the config's)
               --json                print the checks as JSON
`,
    schema: `  schema     Print the JSON Schema of ${CONFIG_FILE}.
`,
  },
};

export const UP_USAGE = groupUsage(UP_HELP);

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;

function cacheMode(noCache: boolean, refresh: boolean): CacheMode {
  if (noCache && refresh) throw new UsageError('--no-cache and --refresh-cache are exclusive', 'pass one of them');
  if (noCache) return 'no-cache';
  return refresh ? 'refresh' : 'use';
}

function parseSeconds(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new UsageError(`${flag} ${raw} is not a number of seconds`, `pass ${flag} 600`);
  return value * 1000;
}

function parsePlatform(raw: string | undefined): ProjectPlatform | undefined {
  if (raw === undefined) return undefined;
  const known = PROJECT_PLATFORMS.find(p => p === raw);
  if (known) return known;
  throw new UsageError(`--platform ${raw} is not a platform`, `pass --platform with one of ${PROJECT_PLATFORMS.join(', ')}`);
}

function report(error: unknown, command: string, deps: EnvDeps): number {
  const say = (text: string) => {
    deps.log(text.startsWith(TOOL) ? text : `${TOOL}: ${text}`);
  };
  if (error instanceof Unmet) {
    say(error.message);
    return EXIT_REFUSED;
  }
  if (error instanceof Refusal || error instanceof NotClaimed) {
    say(error.message);
    return EXIT_REFUSED;
  }
  if (error instanceof ProjectConfigError) {
    say(`${error.message}\nto fix: ${setupFix(`correct those fields ('${CLI} schema' prints the JSON Schema)`)}`);
    return EXIT_USAGE;
  }
  if (error instanceof UsageError) {
    say(error.message);
    return EXIT_USAGE;
  }
  if (
    error instanceof HookFailed ||
    error instanceof ResourceFailed ||
    error instanceof ServiceFailed ||
    error instanceof DeviceStateError ||
    error instanceof DeviceBackendError ||
    error instanceof DeviceCommandError ||
    error instanceof DriverError
  ) {
    say(error.message);
    if (command === 'up') say(`the lane stays: fix this and run ${CLI} up again, or ${CLI} release`);
    return EXIT_FAILED;
  }
  throw error;
}

async function runUp(args: string[], deps: EnvDeps, stdout: (text: string) => void): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      'no-setup': { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      'refresh-cache': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '600' },
      worktree: { type: 'string' },
      platform: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const platform = parsePlatform(values.platform);
  const result = await up(deps, {
    platform,
    setup: !values['no-setup'],
    cacheMode: cacheMode(values['no-cache'], values['refresh-cache']),
    waitMs: parseSeconds(values.timeout, '--timeout'),
    worktree: values.worktree,
  });
  if (values.json) {
    stdout(`${JSON.stringify({ ...result, lane: { ...result.lane, token: undefined } }, null, 2)}\n`);
  } else {
    deps.log(renderDoctor(result.doctor).trimEnd());
    deps.log(
      `${TOOL} up: ${result.doctor.ok ? 'ready' : 'NOT ready'} in ${(result.totalMs / 1000).toFixed(1)} s; logs in ${result.logs}`,
    );
    if (result.url !== null) deps.log(`${TOOL} up: the web app is at ${result.url}`);
    for (const [key, value] of Object.entries(result.env)) stdout(`export ${key}=${shellQuote(value)}\n`);
  }
  return result.doctor.ok ? 0 : EXIT_FAILED;
}

async function runRestart(args: string[], deps: EnvDeps, stdout: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { worktree: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const result = await restart(deps, positionals, values.worktree);
  if (values.json) stdout(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const s of result.services) {
      deps.log(`${TOOL} restart: ${s.service}: ${s.stopped}; ${s.started} (${(s.ms / 1000).toFixed(1)} s)`);
    }
  }
  return 0;
}

async function runDoctor(args: string[], deps: EnvDeps, stdout: (text: string) => void): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { json: { type: 'boolean', default: false }, platform: { type: 'string' } },
  });
  const asked = parsePlatform(values.platform);
  const folder = resolveFolder(deps.cwd);
  const key = ownerKey(resolveOwner(deps.env, deps.processes, deps.selfPid));
  const state = stateDir(deps.env);
  const status = readRegistryStatus({ dir: state, processes: deps.processes, devices: deps.devices, clock: deps.clock });
  const lane = status.lanes.find(c => c.ownerKey === key && c.worktree === folder.worktree) ?? null;
  let config: ProjectConfig | null = null;
  let configProblem: string | null = null;
  const record = lane ? readUpRecord(laneDir(state, lane.id)) : null;
  const file = record?.config ?? findProjectConfig(deps.cwd);
  if (!file) configProblem = `no ${CONFIG_FILE} in ${deps.cwd} or above it`;
  else {
    try {
      const loaded = loadProjectConfig(file);
      const platform = asked ?? record?.platform ?? lane?.device?.platform;
      config = platform === undefined ? loaded : forPlatform(loaded, platform);
    } catch (error) {
      configProblem = (error as Error).message;
    }
  }
  const result = await diagnose(deps, {
    config,
    configProblem,
    lane,
    ownerState: lane?.ownerState ?? null,
    folder: folder.worktree,
    platform: asked,
    installed: record?.installed,
  });
  stdout(values.json ? `${JSON.stringify(result, null, 2)}\n` : renderDoctor(result));
  return result.ok ? 0 : EXIT_FAILED;
}

export async function runUpCommand(
  command: string,
  args: string[],
  deps: EnvDeps,
  stdout: (text: string) => void,
): Promise<number> {
  try {
    switch (command) {
      case 'up':
        return await runUp(args, deps, stdout);
      case 'restart':
        return await runRestart(args, deps, stdout);
      case 'doctor':
        return await runDoctor(args, deps, stdout);
      case 'setup': {
        const { values } = parseArgs({ args, strict: true, options: { worktree: { type: 'string' } } });
        const result = await runSetup(deps, values.worktree);
        return result.code === 0 ? 0 : EXIT_FAILED;
      }
      case 'exec': {
        const rest = args[0] === '--' ? args.slice(1) : args;
        return await execInLane(deps, rest);
      }
      case 'schema':
        parseArgs({ args, strict: true, options: {} });
        stdout(schemaText());
        return 0;
      default:
        throw new UsageError(`'${command}' is not an environment command`, `run ${TOOL} --help`);
    }
  } catch (error) {
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      deps.log(`${TOOL} ${command}: ${error.message}\n\n${helpOf(UP_HELP, command) ?? UP_USAGE}`);
      return EXIT_USAGE;
    }
    return report(error, command, deps);
  }
}
