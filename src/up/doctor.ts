import { setupFix } from '../agents/skills.ts';
import { agentWiringChecks } from '../agents/wiring-check.ts';
import { browserChecks, hasBrowser } from '../browser/lane-browser.ts';
import { realBrowserTools, type BrowserTools } from '../browser/tools.ts';
import { stateDir } from '../registry/paths.ts';
import { adbTools, type AdbTools } from '../devices/adb.ts';
import { checkAndroidHygiene, describeReverse, REACT_NATIVE_DEVICE_PORT } from '../devices/android.ts';
import { DEVICE_NOUN } from '../devices/backend.ts';
import { bundlerLocation, readBundlerPin } from '../devices/bundler.ts';
import { readDialDefault } from '../devices/dial.ts';
import { checkHygiene } from '../devices/hygiene.ts';
import { MAESTRO_OVERRIDE_ENV, maestroBuild, type MaestroBuild } from '../driver/install.ts';
import { metroUrl } from '../devices/launch.ts';
import { LAUNCH_ARGS_ENV, webUrl } from '../hooks/env.ts';
import type { SimTools } from '../devices/tools.ts';
import {
  judgeAndroidVariant,
  judgeIosVariant,
  readIosBundle,
  type InstalledBuild,
  type VariantVerdict,
} from '../devices/variant.ts';
import { CLI } from '../name.ts';
import type { MobileConfig, ProjectConfig, ProjectPlatform } from '../project/config.ts';
import { asMobile } from '../project/config.ts';
import type { OwnerState } from '../registry/owner.ts';
import { AGENTS, describeOwner, describeState } from '../registry/owner.ts';
import type { LaneInfo } from '../registry/types.ts';
import { explainInspection, inspectService, listenersElsewhere } from '../services/services.ts';
import type { EnvDeps } from './deps.ts';
import { toolchainFindings } from './preflight.ts';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
  warning?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  lane: string | null;
  checks: DoctorCheck[];
}

export interface DoctorInput {
  config: ProjectConfig | null;
  configProblem: string | null;
  lane: LaneInfo | null;
  ownerState: OwnerState | null;
  folder: string;
  /** The platform `--platform` asked to check; without it, the lane's device decides. */
  platform?: ProjectPlatform | undefined;
  /** The iOS build `up` installed last, from the lane's up record. */
  installed?: InstalledBuild | undefined;
}

function variantCheck(verdict: VariantVerdict, expected: string): DoctorCheck {
  return { name: 'app variant', ok: verdict.ok, detail: verdict.detail, fix: `${UP} installs the ${expected} build again` };
}

const UP = `${CLI} up`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function dialArguments(config: ProjectConfig, lane: LaneInfo): string[] {
  return config.services.flatMap(service => {
    const port = lane.ports.find(p => p.service === service.name)?.port;
    return service.dial && port !== undefined
      ? [service.dial.argument, service.dial.value.replaceAll('{port}', String(port))]
      : [];
  });
}

export function bundlerPort(config: MobileConfig, lane: LaneInfo): number | undefined {
  return config.app.bundler === null ? undefined : lane.ports.find(p => p.service === config.app.bundler)?.port;
}

/** The emulator ports `up` forwards to the Mac: the bundler, and every service the app dials, each on its own port. */
export function reversePorts(config: MobileConfig, lane: LaneInfo): Map<number, number> {
  const wanted = new Map<number, number>();
  const bundler = bundlerPort(config, lane);
  if (bundler !== undefined) wanted.set(config.app.launch === 'bundler-pin' ? REACT_NATIVE_DEVICE_PORT : bundler, bundler);
  for (const service of config.services) {
    const port = lane.ports.find(p => p.service === service.name)?.port;
    if (service.dial && port !== undefined) wanted.set(port, port);
  }
  return wanted;
}

async function androidAppChecks(adb: AdbTools, config: MobileConfig, lane: LaneInfo): Promise<DoctorCheck[]> {
  const { bundleId } = config.app;
  const checks: DoctorCheck[] = [];
  const installed = await adb.appInstalled(bundleId);
  checks.push({ name: 'app installed', ok: installed, detail: `${bundleId} ${installed ? 'is' : 'is not'} installed`, fix: UP });
  if (!installed) return checks;
  checks.push(
    variantCheck(judgeAndroidVariant(bundleId, await adb.debuggable(bundleId), config.app.variant), config.app.variant),
  );
  const running = await adb.appRunning(bundleId);
  checks.push({ name: 'app running', ok: running, detail: `${bundleId} ${running ? 'is' : 'is not'} running`, fix: UP });
  const wanted = reversePorts(config, lane);
  if (wanted.size > 0) {
    const rules = await adb.reverses();
    const missing = [...wanted].filter(([devicePort, hostPort]) => rules.get(devicePort) !== hostPort);
    checks.push({
      name: 'device network',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `adb reverse forwards ${describeReverse(wanted)}`
          : `adb reverse lacks ${describeReverse(new Map(missing))}, so the app can't reach those servers`,
      fix: UP,
    });
  }
  return checks;
}

async function androidDeviceChecks(deps: EnvDeps, config: MobileConfig, lane: LaneInfo): Promise<DoctorCheck[]> {
  const device = lane.device;
  if (!device?.serial) {
    return [
      {
        name: 'device',
        ok: false,
        detail: `the lane's emulator ${device?.name ?? ''} is not running`,
        fix: `${CLI} release, then ${UP}`,
      },
    ];
  }
  const adb = adbTools(deps, device.serial);
  const booted = await adb.bootCompleted();
  const checks: DoctorCheck[] = [
    {
      name: 'device',
      ok: booted,
      detail: `${device.name} (${device.deviceTypeName}, ${device.runtimeName}, ${device.serial}) is ${booted ? 'booted' : 'not booted'}`,
      fix: UP,
    },
  ];
  if (!booted) return checks;
  try {
    checks.push(...(await androidAppChecks(adb, config, lane)));
  } catch (error) {
    checks.push({ name: 'app', ok: false, detail: message(error), fix: UP });
  }
  return checks;
}

async function androidHygieneCheck(deps: EnvDeps, config: MobileConfig, serial: string): Promise<DoctorCheck> {
  try {
    const hygiene = await checkAndroidHygiene(adbTools(deps, serial), config.hygiene);
    const off = hygiene.steps.filter(s => !s.ok);
    return {
      name: 'hygiene',
      ok: hygiene.ok,
      detail: hygiene.ok
        ? hygiene.steps.map(s => `${s.step} ${s.got}`).join('; ')
        : off.map(s => `${s.step} reads ${s.got}, not ${s.wanted}`).join('; '),
      fix: UP,
    };
  } catch (error) {
    return { name: 'hygiene', ok: false, detail: message(error), fix: UP };
  }
}

async function appChecks(
  sim: SimTools,
  config: MobileConfig,
  lane: LaneInfo,
  udid: string,
  built: InstalledBuild | undefined,
): Promise<DoctorCheck[]> {
  const { bundleId } = config.app;
  const checks: DoctorCheck[] = [];
  const installed = await sim.appInstalled(udid, bundleId);
  checks.push({ name: 'app installed', ok: installed, detail: `${bundleId} ${installed ? 'is' : 'is not'} installed`, fix: UP });
  if (!installed) return checks;
  const container = await sim.appContainer(udid, bundleId);
  if (container !== undefined) {
    checks.push(variantCheck(judgeIosVariant(readIosBundle(container), config.app.variant, built), config.app.variant));
  }
  const running = await sim.appRunning(udid, bundleId);
  checks.push({ name: 'app running', ok: running, detail: `${bundleId} ${running ? 'is' : 'is not'} running`, fix: UP });
  if (!running) return checks;

  const commandLine = await sim.appCommandLine(udid, bundleId);
  const args = commandLine ?? '';
  const has = (words: string[]) => commandLine !== undefined && ` ${args} `.includes(` ${words.join(' ')} `);
  const port = bundlerPort(config, lane);
  if (config.app.launch === 'dev-client' && port !== undefined) {
    const wanted = ['--initialUrl', metroUrl(port)];
    checks.push({
      name: 'launch',
      ok: has(wanted),
      detail: has(wanted)
        ? `the dev client was launched with ${wanted.join(' ')}`
        : `the app's arguments are '${args}', without ${wanted.join(' ')}`,
      fix: UP,
    });
  }
  if (config.app.launch === 'bundler-pin' && port !== undefined) {
    const wanted = bundlerLocation(port);
    const pin = await readBundlerPin(sim, udid, bundleId);
    checks.push({
      name: 'bundler pin',
      ok: pin === wanted,
      detail: pin === wanted ? `RCT_jsLocation reads back ${pin}` : `RCT_jsLocation reads '${pin ?? 'nothing'}', not ${wanted}`,
      fix: UP,
    });
  }
  const dial = dialArguments(config, lane);
  for (let i = 0; i < dial.length; i += 2) {
    const pair = [dial[i] ?? '', dial[i + 1] ?? ''];
    const key = pair[0]?.replace(/^-+/, '') ?? '';
    const launched = has(pair);
    const kept =
      !launched && config.app.launch === 'bundler-pin' && (await readDialDefault(sim, udid, bundleId, key)) === pair[1];
    checks.push({
      name: `dials ${key}`,
      ok: launched || kept,
      detail: launched
        ? `the app was launched with ${pair.join(' ')}`
        : kept
          ? `the app was relaunched without arguments, and its defaults hold ${key} = ${pair[1] ?? ''}`
          : `the app's arguments are '${args}', without ${pair.join(' ')}`,
      fix: config.app.launch === 'hook' ? `pass $${LAUNCH_ARGS_ENV} to the app in the launch hook, then ${UP}` : UP,
    });
  }
  return checks;
}

export function describeMaestroBuild(build: MaestroBuild): string {
  switch (build.kind) {
    case 'release':
      return `the pinned release ${build.version} (sha256 ${build.sha256.slice(0, 12)}…), in ${build.home}`;
    case 'not-installed':
      return `the pinned release ${build.version}, not installed yet: the first look downloads it, or run ${CLI} driver install`;
    case 'override': {
      const from = `${MAESTRO_OVERRIDE_ENV}=${build.binary}`;
      if (build.version === undefined) return `NOT the release: ${from}, whose version can't be read`;
      if (build.local) return `NOT the release: a local build, ${build.version}, from ${from} (the release is ${build.release})`;
      if (build.version === build.release)
        return `NOT the pinned install: ${from} says ${build.version}, but nothing checked it against the release's sha256`;
      return `NOT the release: ${from} is ${build.version} (the release is ${build.release})`;
    }
  }
}

function wiringChecks(config: ProjectConfig | null, folder: string, env: NodeJS.ProcessEnv): DoctorCheck[] {
  const wired = agentWiringChecks(config?.dir ?? folder, env);
  if (wired.length > 0 || !config) return wired;
  return [
    {
      name: 'wiring',
      ok: true,
      warning: true,
      detail: "no agent's skills, MCP server or hooks are set up in this project",
      fix: setupFix(`run ${CLI} init --agents with the ones you use (${AGENTS.join(',')})`),
    },
  ];
}

export async function diagnose(deps: EnvDeps, input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const { config, lane } = input;
  checks.push(
    config
      ? { name: 'config', ok: true, detail: config.file, fix: '' }
      : {
          name: 'config',
          ok: false,
          detail: input.configProblem ?? 'no config',
          fix: setupFix(`fix it by hand ('${CLI} schema' prints its JSON Schema)`),
        },
  );
  checks.push(...wiringChecks(config, input.folder, deps.env));
  const asked = input.platform;
  const held = lane?.device;
  const mismatch = asked !== undefined && asked !== 'web' && held && held.platform !== asked ? { asked, held } : undefined;
  if (!lane) {
    checks.push({ name: 'lane', ok: false, detail: `this session holds no lane in ${input.folder}`, fix: UP });
  } else if (mismatch) {
    checks.push({
      name: 'lane',
      ok: false,
      detail: `this folder's lane ${lane.id} holds ${mismatch.held.name}, ${DEVICE_NOUN[mismatch.held.platform]}, and doctor is checking ${mismatch.asked}`,
      fix: `${CLI} release here, then ${UP} --platform ${mismatch.asked}; or run ${CLI} doctor --platform ${mismatch.held.platform}`,
    });
  } else {
    const alive = input.ownerState === 'alive';
    checks.push({
      name: 'lane',
      ok: alive,
      detail: `lane ${lane.id} held by ${describeOwner(lane.owner)} in ${lane.worktree}${alive ? '' : `: ${describeState(input.ownerState ?? 'cant-tell')}`}`,
      fix: UP,
    });
  }
  const mobile = config && asMobile(config);
  if (config) {
    const preflight = await toolchainFindings(
      config,
      { env: deps.env, toolchain: deps.toolchain, backend: mobile ? deps.devices[mobile.platform] : undefined },
      false,
    );
    checks.push(...preflight.findings);
    if (config.driver && mobile) {
      checks.push({ name: 'Maestro', ok: true, detail: describeMaestroBuild(await maestroBuild(deps.env)), fix: '' });
    }
  }
  if (!config || !lane || mismatch) return finish(lane, checks);
  checks.push(...resourceChecks(config, lane));
  const tools = deps.browser ?? realBrowserTools;
  if (hasBrowser(lane)) checks.push(...(await browserChecks(tools, stateDir(deps.env), lane, deps.env)));
  else if (!mobile && config.web) {
    checks.push({
      name: 'browser',
      ok: false,
      detail: `lane ${lane.id} holds no browser`,
      fix: `${UP} (it claims one and opens the web app in it)`,
    });
  }

  if (!mobile) {
    checks.push(...(await serviceChecks(deps, config, lane)));
    checks.push(await webAppCheck(tools, config, lane, checks));
    return finish(lane, checks);
  }

  if (lane.device?.platform === 'android') {
    const deviceChecks = await androidDeviceChecks(deps, mobile, lane);
    checks.push(...deviceChecks);
    checks.push(...(await serviceChecks(deps, config, lane)));
    const serial = lane.device.serial;
    if (serial && deviceChecks[0]?.ok) checks.push(await androidHygieneCheck(deps, mobile, serial));
    return finish(lane, checks);
  }

  const udid = lane.device?.id;
  const sim = deps.sim;
  if (!udid || !sim) {
    checks.push({ name: 'device', ok: false, detail: 'the lane holds no simulator', fix: `${CLI} release, then ${UP}` });
    return finish(lane, checks);
  }
  const device = await sim.device(udid);
  const booted = device?.state === 'Booted';
  checks.push({
    name: 'device',
    ok: booted,
    detail: device
      ? `${device.name} (${lane.device?.deviceTypeName ?? ''}, ${lane.device?.runtimeName ?? ''}, ${udid}) is ${device.state}`
      : `simulator ${udid} no longer exists`,
    fix: UP,
  });

  if (booted) {
    try {
      checks.push(...(await appChecks(sim, mobile, lane, udid, input.installed)));
    } catch (error) {
      checks.push({ name: 'app', ok: false, detail: message(error), fix: UP });
    }
  }

  checks.push(...(await serviceChecks(deps, config, lane)));

  if (booted) {
    try {
      const hygiene = await checkHygiene(sim, udid, config.hygiene);
      const off = hygiene.steps.filter(s => !s.ok);
      checks.push({
        name: 'hygiene',
        ok: hygiene.ok,
        detail: hygiene.ok
          ? hygiene.steps.map(s => `${s.step} ${s.got}`).join('; ')
          : off.map(s => `${s.step} reads ${s.got}, not ${s.wanted}`).join('; '),
        fix: UP,
      });
    } catch (error) {
      checks.push({ name: 'hygiene', ok: false, detail: message(error), fix: UP });
    }
  }
  return finish(lane, checks);
}

async function serviceChecks(deps: EnvDeps, config: ProjectConfig, lane: LaneInfo): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const service of config.services) {
    const port = lane.ports.find(p => p.service === service.name)?.port;
    if (port === undefined) {
      checks.push({ name: `service ${service.name}`, ok: false, detail: 'the lane has no port for it', fix: UP });
      continue;
    }
    const recorded = lane.processes.find(p => p.service === service.name) ?? null;
    const seen = await inspectService(deps.system, service, port, recorded);
    const foreign = seen.listeners?.filter(l => !l.ours) ?? [];
    const elsewhere = listenersElsewhere(deps.system, seen.listeners ?? [], lane.worktree);
    const code =
      elsewhere.length === 0
        ? ''
        : `; ${elsewhere.map(l => `the listener pid ${String(l.pid)} runs in ${l.cwd ?? '(unknown)'}`).join(', ')}, outside this worktree ${lane.worktree}, so ${String(port)} serves that folder's code`;
    checks.push({
      name: `service ${service.name}`,
      ok: seen.healthy && elsewhere.length === 0,
      detail: `${explainInspection(seen)}${code}`,
      fix:
        foreign.length > 0
          ? `stop ${foreign.map(l => `pid ${String(l.pid)}`).join(', ')}, then ${UP}`
          : elsewhere.length > 0
            ? `make services.${service.name}.start run this worktree's code (its cwd and the paths it starts), then ${CLI} restart ${service.name}`
            : `${UP} (it restarts the service)`,
    });
  }
  return checks;
}

function resourceChecks(config: ProjectConfig, lane: LaneInfo): DoctorCheck[] {
  const declared = config.resources.map(r => r.name);
  const names = [...new Set([...declared, ...lane.resources.map(r => r.name)])];
  return names.map(name => {
    const held = lane.resources.find(r => r.name === name);
    const exported = held?.exports ? Object.keys(held.exports) : [];
    if (!held) {
      return {
        name: `resource ${name}`,
        ok: false,
        detail: `lane ${lane.id} has no ${name}: ${config.file} declared it after up last ran`,
        fix: `${UP} (it creates it)`,
      };
    }
    if (!held.exports) {
      return {
        name: `resource ${name}`,
        ok: false,
        detail: "its create failed or did not finish, so the lane's commands lack its values",
        fix: `${UP} (it runs create again; the create log is in the lane's resources folder)`,
      };
    }
    const kept = declared.includes(name)
      ? ''
      : `; ${config.file} no longer declares it, and its teardown runs when the lane ends`;
    return {
      name: `resource ${name}`,
      ok: true,
      detail: `created for lane ${lane.id}${exported.length > 0 ? `, exports ${exported.join(', ')}` : ''}${kept}`,
      fix: '',
    };
  });
}

async function webAppCheck(
  tools: BrowserTools,
  config: ProjectConfig,
  lane: LaneInfo,
  checks: readonly DoctorCheck[],
): Promise<DoctorCheck> {
  const url = webUrl(config, lane);
  const service = config.web?.service ?? '';
  const served = checks.find(c => c.name === `service ${service}`)?.ok === true;
  if (url === null) return { name: 'web app', ok: false, detail: `the lane has no port for ${service}`, fix: UP };
  if (!served) return { name: 'web app', ok: false, detail: `${url}, but ${service} is not healthy`, fix: UP };
  const answer = await tools.probe(url);
  return {
    name: 'web app',
    ok: answer !== null && answer.status < 500,
    detail:
      answer === null
        ? `${url} does not answer`
        : answer.status === 200
          ? url
          : `${url} answers HTTP ${String(answer.status)}${answer.status < 500 ? '' : `, a server error`}`,
    fix: answer === null ? UP : `read the log of ${service} in the lane's log folder`,
  };
}

function finish(lane: LaneInfo | null, checks: DoctorCheck[]): DoctorReport {
  return { ok: checks.every(c => c.ok), lane: lane?.id ?? null, checks };
}

export function renderDoctor(report: DoctorReport): string {
  const lines = report.checks.map(c => {
    const head = `${c.ok ? (c.warning ? 'warn' : 'ok  ') : 'FAIL'}  ${c.name}: ${c.detail}`;
    return c.ok && !c.warning ? head : `${head}\n        fix: ${c.fix}`;
  });
  const failed = report.checks.filter(c => !c.ok).length;
  lines.push(failed === 0 ? 'ready' : `not ready: ${String(failed)} check${failed === 1 ? '' : 's'} failed`);
  return `${lines.join('\n')}\n`;
}
