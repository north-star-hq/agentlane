import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { PLAYWRIGHT_RELEASE } from '../browser/release.ts';
import { adbTools, type AdbFactory } from '../devices/adb.ts';
import type { Platform } from '../devices/backend.ts';
import { MAESTRO_DRIVER_PACKAGE } from '../devices/emulator.ts';
import { devClientLink } from '../devices/launch.ts';
import type { SimTools } from '../devices/tools.ts';
import { resolveCallerLane } from '../driver/caller.ts';
import { engineStatus, stopEngine } from '../driver/client.ts';
import { enginePaths } from '../driver/paths.ts';
import { OWNER_PID_ENV } from '../registry/owner.ts';
import type { Lane } from '../registry/types.ts';
import type { ProcessTable } from '../processes.ts';
import { McpClient, type ToolAnswer } from './mcp-client.ts';
import type { BenchPlatform, Cell, Op, Sample, TargetInfo } from './model.ts';
import type { BatchPlan } from './schedule.ts';

export const CLI_ENTRY = path.join(import.meta.dirname, '..', `cli${path.extname(import.meta.filename)}`);

/** The example app the bench drives (examples/expo-app): its bundle id, home-screen anchor, tap and flow. */
export const TARGET_APP = {
  bundleId: 'com.example.expoapp',
  scheme: 'expoexample',
  anchor: 'home-increment',
  tap: '- tapOn:\n    id: home-increment\n',
  flow: [
    '- tapOn:',
    '    id: home-open-details',
    '- assertVisible:',
    '    id: details-title',
    '- tapOn:',
    '    id: details-back',
    '- assertVisible:',
    '    id: home-increment',
    '',
  ].join('\n'),
} as const;

/**
 * The example's web app on a browser lane: the page `up` opens signed in, the toolkit's `look` shows its Shortest
 * first button by name, a click toggles it, and the flow adds a place through the API to the lane's database.
 */
export const TARGET_WEB = {
  anchor: '"Shortest first"',
  click: "getByTestId('sort-shortest')",
  flow: (name: string) =>
    [
      'async page => {',
      `  await page.getByTestId('add-name').fill(${JSON.stringify(name)});`,
      "  await page.getByTestId('add-submit').click();",
      `  await page.getByTestId('places').getByText(${JSON.stringify(name)}, { exact: true }).waitFor();`,
      '}',
    ].join('\n'),
} as const;

/** The driver CLI call an agent makes for a click or a flow in the lane's browser: through `exec`, as one Bash call. */
export function browserCommand(op: 'click' | 'flow', flowName: string): string[] {
  return op === 'click'
    ? ['exec', '--', 'playwright-cli', 'click', TARGET_WEB.click]
    : ['exec', '--', 'playwright-cli', 'run-code', TARGET_WEB.flow(flowName)];
}

/**
 * The example app restarted onto its own Metro and API. On iOS the dev client reads --initialUrl from its launch
 * arguments; on Android launchApp's arguments become intent extras, and the dev client takes its bundler from the
 * development-client link that follows, which expo-dev-launcher ignores until its launcher screen is up.
 */
export function relaunchYaml(metroPort: number, apiPort: number | null, platform: Platform = 'ios'): string {
  const api = apiPort === null ? [] : [`      apiBaseUrl: http://localhost:${String(apiPort)}`];
  if (platform === 'android') {
    return [
      '- launchApp:',
      '    stopApp: true',
      ...(api.length > 0 ? ['    arguments:', ...api] : []),
      '- extendedWaitUntil:',
      '    visible: DEVELOPMENT SERVERS',
      '    timeout: 15000',
      `- openLink: ${devClientLink({ scheme: TARGET_APP.scheme, port: metroPort })}`,
      '',
    ].join('\n');
  }
  return [
    '- launchApp:',
    '    stopApp: true',
    '    arguments:',
    `      '--initialUrl': http://localhost:${String(metroPort)}`,
    ...api,
    '',
  ].join('\n');
}

const GATE_TIMEOUT_MS = 90_000;
const ADMISSION_TIMEOUT_MS = 20_000;

export interface LiveTarget {
  info: TargetInfo;
  folder: string;
  lane: Lane;
  stateDir: string;
  mcp: McpClient;
  env: NodeJS.ProcessEnv;
  /** Counts the flows run, so each adds a place of its own name. */
  flows: number;
}

export interface LiveDeps {
  env: NodeJS.ProcessEnv;
  processes: ProcessTable;
  platform: BenchPlatform;
  sim: SimTools;
  adb?: AdbFactory;
  log: (line: string) => void;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runCli(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  const started = process.hrtime.bigint();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-8000)));
    child.on('close', code => {
      resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    });
  });
}

/** The environment every child of the bench runs in: the bench process owns its lanes, so they end with it. */
export function benchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [OWNER_PID_ENV]: String(process.pid) };
}

interface UpJson {
  steps?: { step: string; ms: number }[];
  doctor?: { ok?: boolean; checks?: { name: string; ok: boolean; detail: string }[] };
}

function parseUp(stdout: string): UpJson | null {
  try {
    return JSON.parse(stdout) as UpJson;
  } catch {
    return null;
  }
}

async function up(
  folder: string,
  env: NodeJS.ProcessEnv,
  platform: BenchPlatform,
  setup: boolean,
): Promise<{ ms: number; steps: Record<string, number> }> {
  const ran = await runCli(['up', '--json', '--platform', platform, ...(setup ? [] : ['--no-setup'])], folder, env);
  const parsed = parseUp(ran.stdout);
  const failed = parsed?.doctor?.checks?.filter(c => !c.ok) ?? [];
  if (ran.code !== 0 || !parsed || parsed.doctor?.ok !== true) {
    const why =
      failed.length > 0
        ? `doctor: ${failed.map(c => `${c.name}: ${c.detail}`).join('; ')}`
        : ran.stderr.trim().split('\n').slice(-4).join(' / ');
    throw new Error(`up exited ${String(ran.code)}: ${why}`);
  }
  const steps: Record<string, number> = {};
  for (const s of parsed.steps ?? []) steps[`up ${s.step}`] = s.ms;
  return { ms: ran.ms, steps };
}

export async function openTarget(label: string, folder: string, deps: LiveDeps, setup: boolean): Promise<LiveTarget> {
  const env = benchEnv(deps.env);
  deps.log(`${label}: up in ${folder}`);
  const brought = await up(folder, env, deps.platform, setup);
  deps.log(`${label}: up took ${(brought.ms / 1000).toFixed(1)} s`);
  const port = (service: string) => lane.ports.find(p => p.service === service)?.port ?? null;
  const { lane, stateDir } = resolveCallerLane({
    env,
    cwd: folder,
    processes: deps.processes,
    need: deps.platform === 'web' ? 'browser' : 'device',
  });
  if (deps.platform === 'web') {
    const browser = lane.browser;
    if (!browser) throw new Error(`lane ${lane.id} holds no browser`);
    const mcp = new McpClient(process.execPath, [CLI_ENTRY, 'mcp'], folder, env);
    await mcp.initialize();
    return {
      folder,
      lane,
      stateDir,
      mcp,
      env,
      flows: 0,
      info: {
        sim: label,
        folder: lane.worktree,
        lane: lane.id,
        platform: 'web',
        udid: browser.session,
        deviceName: (await browserVersion(browser.debugPort)) ?? 'unknown browser',
        deviceType: `${browser.driver} ${PLAYWRIGHT_RELEASE.version}`,
        runtime: `debugging port ${String(browser.debugPort)}`,
        metroPort: null,
        apiPort: port('api'),
        webPort: port('web'),
      },
    };
  }
  const device = lane.device;
  if (!device) throw new Error(`lane ${lane.id} holds no device`);
  if (device.platform !== deps.platform) throw new Error(`lane ${lane.id} holds ${device.name}, not a ${deps.platform} device`);
  const mcp = new McpClient(process.execPath, [CLI_ENTRY, 'mcp'], folder, env);
  await mcp.initialize();
  return {
    folder,
    lane,
    stateDir,
    mcp,
    env,
    flows: 0,
    info: {
      sim: label,
      folder: lane.worktree,
      lane: lane.id,
      platform: device.platform,
      udid: device.platform === 'android' ? (device.serial ?? device.id) : device.id,
      deviceName: device.name,
      deviceType: device.deviceTypeName,
      runtime: device.runtimeName,
      metroPort: port('metro'),
      apiPort: port('api'),
    },
  };
}

/** Releases the bench's lane for a folder; the release stops its services and its driver. */
export async function releaseFolder(folder: string, deps: Pick<LiveDeps, 'env'>): Promise<string> {
  const ran = await runCli(['release'], folder, benchEnv(deps.env));
  return ran.code === 0 ? ran.stdout.trim() || 'released' : `release exited ${String(ran.code)}: ${ran.stderr.trim()}`;
}

export async function closeTarget(target: LiveTarget, deps: LiveDeps): Promise<string[]> {
  const notes: string[] = [];
  await target.mcp.close();
  notes.push(`${target.info.sim}: lane ${target.lane.id}: ${await releaseFolder(target.folder, deps)}`);
  const deadline = Date.now() + ADMISSION_TIMEOUT_MS;
  let engine = true;
  while (Date.now() < deadline) {
    engine = (await engineStatus(target.stateDir, target.lane).catch(() => undefined)) !== undefined;
    if (!engine) break;
    await deps.sim.sleep(250);
  }
  const state = await deviceState(target, deps);
  notes.push(
    `${target.info.sim}: after release the driver is ${engine ? 'STILL RUNNING' : 'stopped'}; ${target.info.deviceName} is ${state}`,
  );
  return notes;
}

/** What the browser on the lane's debugging port says it is, from Chrome's /json/version; null when nothing answers. */
async function browserVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { Browser?: unknown };
    return typeof body.Browser === 'string' ? body.Browser : null;
  } catch {
    return null;
  }
}

async function deviceState(target: LiveTarget, deps: LiveDeps): Promise<string> {
  if (target.info.platform === 'web') {
    const port = target.lane.browser?.debugPort;
    return port !== undefined && (await browserVersion(port)) !== null ? 'still answering' : 'closed';
  }
  if (target.info.platform !== 'android') return (await deps.sim.device(target.info.udid))?.state ?? 'unknown';
  try {
    return (await adbTools(deps, target.info.udid).bootCompleted()) ? 'Booted' : 'not booted';
  } catch {
    return 'not running';
  }
}

async function browserCall(target: LiveTarget, op: 'click' | 'flow'): Promise<ToolAnswer> {
  target.flows += op === 'flow' ? 1 : 0;
  const ran = await runCli(
    browserCommand(op, `Bench place ${target.lane.id}-${String(target.flows)}`),
    target.folder,
    target.env,
  );
  const text = `${ran.stdout}\n${ran.stderr}`;
  return { ms: ran.ms, isError: ran.code !== 0, text, images: 0, bytes: Buffer.byteLength(ran.stdout) };
}

function call(target: LiveTarget, op: Op): Promise<ToolAnswer> {
  if (target.info.platform === 'web') {
    if (op === 'read') return target.mcp.call('look', {});
    if (op === 'screenshot') return target.mcp.call('screenshot', {});
    if (op === 'click' || op === 'flow') return browserCall(target, op);
    throw new Error(`${op} is a device op; a browser lane takes read, screenshot, click and flow`);
  }
  switch (op) {
    case 'read':
      return target.mcp.call('look', {});
    case 'screenshot':
      return target.mcp.call('screenshot', {});
    case 'quick-tap':
      return target.mcp.call('run', { yaml: TARGET_APP.tap, appId: TARGET_APP.bundleId, quick: true });
    case 'tap':
      return target.mcp.call('run', { yaml: TARGET_APP.tap, appId: TARGET_APP.bundleId });
    case 'flow':
      return target.mcp.call('run', { yaml: TARGET_APP.flow, appId: TARGET_APP.bundleId });
    case 'click':
      throw new Error('click is a browser op; a device takes quick-tap and tap');
  }
}

function anchorOf(target: LiveTarget): string {
  return target.info.platform === 'web' ? TARGET_WEB.anchor : TARGET_APP.anchor;
}

function shows(target: LiveTarget, answer: ToolAnswer): boolean {
  return !answer.isError && answer.text.includes(anchorOf(target));
}

function brief(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

const elapsed = (from: bigint) => Number(process.hrtime.bigint() - from) / 1e6;

interface Timed {
  ok: boolean;
  phases: Record<string, number>;
  gateReads: number;
  responseBytes: number;
  error?: string;
}

/**
 * One op on the app's home screen. With gate, the app may still be starting: a read is repeated until it shows the
 * anchor, and a screenshot waits for such a read first (taps and flows wait on their own, through Maestro's find). The
 * repeated reads are inside the timed span and counted.
 */
async function timedOp(target: LiveTarget, op: Op, gate: boolean): Promise<Timed> {
  const started = process.hrtime.bigint();
  let gateReads = 0;
  if (op === 'read' || (op === 'screenshot' && gate)) {
    for (;;) {
      const answer = await target.mcp.call('look', {});
      if (shows(target, answer)) {
        if (op === 'read') return { ok: true, phases: { op: elapsed(started) }, gateReads, responseBytes: answer.bytes };
        break;
      }
      if (!gate || elapsed(started) > GATE_TIMEOUT_MS) {
        return {
          ok: false,
          phases: {},
          gateReads,
          responseBytes: answer.bytes,
          error: answer.isError ? brief(answer.text) : `the read doesn't show ${anchorOf(target)}: ${brief(answer.text)}`,
        };
      }
      gateReads += 1;
    }
  }
  const gateMs = elapsed(started);
  const answer = await call(target, op);
  if (answer.isError) return { ok: false, phases: {}, gateReads, responseBytes: answer.bytes, error: brief(answer.text) };
  if (op === 'screenshot' && answer.images !== 1)
    return { ok: false, phases: {}, gateReads, responseBytes: answer.bytes, error: 'no image in the answer' };
  return {
    ok: true,
    phases: { ...(gate && (gateReads > 0 || op === 'screenshot') ? { gate: gateMs } : {}), op: answer.ms },
    gateReads,
    responseBytes: answer.bytes,
  };
}

function psLines(): string[] {
  const result = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 });
  return result.stdout.split('\n');
}

/**
 * What still runs for this lane: its engine, a JVM working in its folder, and XCTest or xcodebuild on its simulator
 * or Maestro's instrumentation on its emulator.
 */
async function leftovers(target: LiveTarget, deps: LiveDeps): Promise<string[]> {
  const found: string[] = [];
  if ((await engineStatus(target.stateDir, target.lane).catch(() => undefined)) !== undefined) found.push('the driver engine');
  const work = enginePaths(target.stateDir, target.lane.id).work;
  const udid = target.info.udid;
  for (const line of psLines()) {
    if (line.includes(`${work}/`) || line.endsWith(work) || line.includes(`${work} `))
      found.push(`a process in the lane's work dir: ${brief(line).slice(0, 120)}`);
    else if (line.includes(udid) && (line.includes('xcodebuild') || line.includes('maestro-driver-iosUITests-Runner')))
      found.push(`XCTest on the simulator: ${brief(line).slice(0, 120)}`);
  }
  if (target.info.platform === 'android' && (await adbTools(deps, udid).appRunning(MAESTRO_DRIVER_PACKAGE)))
    found.push(`Maestro's instrumentation (${MAESTRO_DRIVER_PACKAGE}) on the emulator`);
  return found;
}

async function admit(target: LiveTarget, deps: LiveDeps, simState: 'Booted' | 'Shutdown'): Promise<number> {
  const started = Date.now();
  let problems: string[] = [];
  while (Date.now() - started < ADMISSION_TIMEOUT_MS) {
    problems = await leftovers(target, deps);
    const state = await deviceState(target, deps);
    if (state !== simState) problems.push(`${target.info.deviceName} is ${state}, not ${simState}`);
    if (problems.length === 0) return Date.now() - started;
    await deps.sim.sleep(250);
  }
  throw new Error(`admission: ${problems.join('; ')}`);
}

/** Puts the app on its home screen under a running driver: a read, and a relaunch when the anchor isn't showing. */
async function ensureHome(target: LiveTarget): Promise<void> {
  const first = await target.mcp.call('look', {});
  if (shows(target, first)) return;
  if (target.info.platform === 'web') {
    const url = `http://localhost:${String(target.info.webPort)}/`;
    const opened = await runCli(['exec', '--', 'playwright-cli', 'goto', url], target.folder, target.env);
    if (opened.code !== 0) throw new Error(`opening ${url} failed: ${brief(opened.stderr)}`);
    const timed = await timedOp(target, 'read', true);
    if (!timed.ok) throw new Error(`the signed-in page never showed: ${timed.error ?? ''}`);
    return;
  }
  const { metroPort, apiPort } = target.info;
  if (metroPort === null) throw new Error(`lane ${target.lane.id} has no metro port`);
  const relaunched = await target.mcp.call('run', {
    yaml: relaunchYaml(metroPort, apiPort, target.info.platform),
    appId: TARGET_APP.bundleId,
  });
  if (relaunched.isError) throw new Error(`relaunching the app failed: ${brief(relaunched.text)}`);
  const timed = await timedOp(target, 'read', true);
  if (!timed.ok) throw new Error(`the app's home screen never showed: ${timed.error ?? ''}`);
}

function sampleOf(
  started: Date,
  ms: number,
  timed: Timed,
  untimed: Record<string, number> = {},
  extra: Record<string, number> = {},
): Sample {
  const phases: Record<string, number> = { ...extra, ...timed.phases };
  for (const [key, value] of Object.entries(untimed)) phases[`untimed ${key}`] = value;
  return {
    ms: timed.ok ? ms : 0,
    ok: timed.ok,
    startedAt: started.toISOString(),
    phases,
    gateReads: timed.gateReads,
    responseBytes: timed.responseBytes,
    ...(timed.error === undefined ? {} : { error: timed.error }),
  };
}

function deviceOf(target: LiveTarget): Platform {
  const platform = target.info.platform ?? 'ios';
  if (platform === 'web') throw new Error('a browser lane is measured warm only');
  return platform;
}

export function planFor(cell: Cell, op: Op, targets: readonly LiveTarget[], deps: LiveDeps): BatchPlan {
  if (deps.platform === 'web' && cell !== 'warm') throw new Error(`a browser lane is measured warm only, not ${cell}`);
  const first = targets[0];
  if (!first) throw new Error('no targets');
  const bySim = new Map(targets.map(t => [t.info.sim, t]));
  const target = (sim: string): LiveTarget => {
    const found = bySim.get(sim);
    if (!found) throw new Error(`no target ${sim}`);
    return found;
  };
  const env = benchEnv(deps.env);
  switch (cell) {
    case 'warm':
      return {
        cell,
        op,
        sims: targets.map(t => t.info.sim),
        prepare: async () => {
          for (const t of targets) await ensureHome(t);
        },
        sample: async sim => {
          const started = new Date();
          const timed = await timedOp(target(sim), op, false);
          return sampleOf(started, timed.phases.op ?? 0, timed);
        },
      };
    case 'relaunch':
      return {
        cell,
        op,
        sims: [first.info.sim],
        prepare: () => ensureHome(first),
        sample: async () => {
          const { metroPort, apiPort } = first.info;
          if (metroPort === null) throw new Error(`lane ${first.lane.id} has no metro port`);
          const started = new Date();
          const t0 = process.hrtime.bigint();
          const relaunched = await first.mcp.call('run', {
            yaml: relaunchYaml(metroPort, apiPort, deviceOf(first)),
            appId: TARGET_APP.bundleId,
          });
          if (relaunched.isError) throw new Error(`relaunch failed: ${brief(relaunched.text)}`);
          const timed = await timedOp(first, op, true);
          return sampleOf(started, elapsed(t0), timed, {}, { relaunch: relaunched.ms });
        },
      };
    case 'cold':
      return {
        cell,
        op,
        sims: [first.info.sim],
        prepare: () => ensureHome(first),
        sample: async () => {
          const p0 = process.hrtime.bigint();
          await ensureHome(first);
          await stopEngine(first.stateDir, first.lane);
          const admitted = await admit(first, deps, 'Booted');
          const prep = elapsed(p0);
          const started = new Date();
          const t0 = process.hrtime.bigint();
          const timed = await timedOp(first, op, false);
          return sampleOf(started, elapsed(t0), timed, { prepare: prep, admission: admitted });
        },
      };
    case 'first-interaction':
      return {
        cell,
        op,
        sims: [first.info.sim],
        prepare: () => Promise.resolve(),
        sample: async () => {
          await stopEngine(first.stateDir, first.lane);
          await admit(first, deps, 'Booted');
          const brought = await up(first.folder, env, deps.platform, false);
          const started = new Date();
          const t0 = process.hrtime.bigint();
          const timed = await timedOp(first, op, true);
          return sampleOf(started, elapsed(t0), timed, { up: brought.ms });
        },
      };
    case 'cold-cold':
      return {
        cell,
        op,
        sims: [first.info.sim],
        selfLoading: true,
        prepare: () => Promise.resolve(),
        sample: async () => {
          const p0 = process.hrtime.bigint();
          await stopEngine(first.stateDir, first.lane);
          await deps.sim.shutdown(first.info.udid);
          const admitted = await admit(first, deps, 'Shutdown');
          const prep = elapsed(p0);
          const started = new Date();
          const t0 = process.hrtime.bigint();
          const brought = await up(first.folder, env, deps.platform, false);
          const timed = await timedOp(first, op, true);
          return sampleOf(
            started,
            elapsed(t0),
            timed,
            { prepare: prep, admission: admitted },
            { up: brought.ms, ...brought.steps },
          );
        },
      };
  }
}
