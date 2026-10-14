import fs from 'node:fs';
import path from 'node:path';
import { text as readAll } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { adbTools, type AdbFactory, type AdbTools } from './devices/adb.ts';
import { requireEmulatorBooted } from './devices/android.ts';
import {
  ANDROID_SERVICES,
  androidPermissionsOf,
  createXcrunControls,
  isPrivacyService,
  PRIVACY_SERVICES,
  type ControlTools,
} from './devices/controls.ts';
import { DeviceStateError, requireBooted } from './devices/common.ts';
import type { SimTools } from './devices/tools.ts';
import { createXcrunTools, DeviceCommandError } from './devices/xcrun.ts';
import { hasBrowser } from './browser/lane-browser.ts';
import { lookAtBrowser, screenshotBrowser, type BrowserScreenTarget } from './browser/screen.ts';
import { describeInstallState, ensureBrowserDriver } from './browser/install.ts';
import { BROWSER_DRIVERS, DEFAULT_BROWSER_DRIVER, isBrowserDriver } from './browser/kinds.ts';
import { realBrowserTools, type BrowserTools } from './browser/tools.ts';
import { systemClock } from './clock.ts';
import { realEvidenceSystem, type EvidenceSystem } from './evidence/device.ts';
import {
  laneEvidence,
  evidenceTarget,
  keepLogs,
  keepRunFailure,
  keepScreenshot,
  startTrace,
  startVideo,
  stopTrace,
  stopVideo,
  type EvidenceContext,
  type Kept,
} from './evidence/evidence.ts';
import { sizeOf, type EvidenceTarget } from './evidence/files.ts';
import { resolveCallerLane, type Caller, type CallerLane } from './driver/caller.ts';
import { callEngine, engineStatus, stopEngine, type EngineTarget } from './driver/client.ts';
import type { EngineResponse } from './driver/engine.ts';
import { DriverError } from './driver/errors.ts';
import type { Crop } from './driver/images.ts';
import { ensureMaestro, findJdk17, installedMaestro } from './driver/install.ts';
import { enginePaths } from './driver/paths.ts';
import { MAESTRO_RELEASE } from './driver/release.ts';
import type { LookArgs, RunArgs, ScreenshotArgs } from './driver/session.ts';
import { serveMcp } from './mcp/server.ts';
import { createToolHandler, TOOLS } from './mcp/tools.ts';
import { CLI, TOOL } from './name.ts';
import type { ProcessTable } from './processes.ts';
import { tcpProbe } from './registry/ports.ts';
import { NotClaimed, Refusal, UsageError } from './registry/refusal.ts';
import { Registry } from './registry/registry.ts';
import { groupUsage, helpOf, type UsageGroup } from './usage.ts';

export interface DriverCliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  processes: ProcessTable;
  sim?: SimTools;
  controls?: ControlTools;
  adb?: AdbFactory;
  browser?: BrowserTools;
  evidence?: EvidenceSystem;
}

export const DRIVER_COMMANDS = ['look', 'run', 'screenshot', 'record', 'evidence', 'driver', 'browser', 'device', 'mcp'] as const;

export const DRIVER_HELP: UsageGroup<(typeof DRIVER_COMMANDS)[number]> = {
  title: 'Driving (always the simulator, emulator or browser this session claimed for this folder):',
  entries: {
    look: `  look       What's on screen, one line per element.
               --interactive   only what you can tap, toggle or type into
               --within <id|label>  only that element's subtree
               --depth <n>     how many levels to show
               --bounds        each element's bounds in points (device only)
               --raw           Maestro's own inspect_screen output (device only)
               --browser       read the lane's browser (the default when it holds no device)
               --device        read the lane's simulator or emulator
`,
    run: `  run        Run Maestro YAML and print what changed: run <flow.yaml>, run --yaml '<yaml>', or run - (stdin).
               --quick         tap without waiting for the screen to settle
               --app-id <id>   the bundle id for YAML without an appId header
               --env NAME=VALUE  a flow variable (repeatable)
`,
    screenshot: `  screenshot Save the screen as a JPEG (a browser's as a PNG) and print its path.
               --out <file>    where to write it
               --scale <0-1>   shrink it (device only)
               --crop x,y,w,h  a region in points, as look --bounds prints them (device only)
               --browser | --device   which screen, when the lane holds both
`,
    record: `  record     record save <file> writes this session's passing run steps as a flow; record show; record clear.
`,
    evidence: `  evidence   Keep evidence in the lane's evidence folder, which outlives release; each prints what it wrote.
               evidence screenshot
               evidence video start | stop
               evidence trace start | stop
               evidence logs [--since <n>m|<n>s|<n>h]   services, hooks, driver, device log, browser console
               evidence list
               --browser | --device   which screen, when the lane holds both
             A failed run, and a failed command under exec, keep their own evidence there on their own.
`,
    driver: `  driver     driver start | status | stop: the warm Maestro session behind look, run and screenshot.
             driver install [--from <zip>]: install the pinned Maestro build (first use does this on its own).
`,
    browser: `  browser    browser install [--driver playwright|agent-browser] [--from <dir>]: install the pinned driver and
             its browsers into the toolkit's data folder (up does this on its own); browser status.
`,
    device: `  device     Controls for the claimed simulator or emulator:
               device location <lat>,<lon> | clear     (clear: simulator only)
               device permission grant|revoke|reset <service> [<bundle id>]
               device appearance light|dark
               device push <bundle id> <payload.json | ->   (simulator only)
               device clipboard set <text> | get       (simulator only)
               device open <url>
`,
    mcp: `  mcp        Serve look, run and screenshot over MCP on stdio (look and screenshot read a browser lane too).
`,
  },
  footer: `  Each of these takes --worktree <dir> to name the folder whose lane to use.
`,
};

export const DRIVER_USAGE = groupUsage(DRIVER_HELP);

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;

function packageVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function laneFor(deps: DriverCliDeps, worktree: string | undefined, need: Caller['need'] = 'device'): CallerLane {
  return resolveCallerLane({ env: deps.env, cwd: deps.cwd, worktree, processes: deps.processes, need });
}

/** The lane's browser when asked for, or when the lane holds no device; else null, for the device. */
function browserTarget(deps: DriverCliDeps, resolved: CallerLane, asked: boolean): BrowserScreenTarget | null {
  const { lane } = resolved;
  if (!hasBrowser(lane) || (!asked && lane.device !== null)) return null;
  return { tools: deps.browser ?? realBrowserTools, stateDir: resolved.stateDir, lane, env: deps.env };
}

function notOnBrowser(flags: Record<string, unknown>, command: string): void {
  const used = Object.entries(flags)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([flag]) => `--${flag}`);
  if (used.length > 0) {
    throw new UsageError(
      `${used.join(', ')} ${used.length === 1 ? 'reads' : 'read'} a device screen; the lane's browser has no ${command === 'look' ? 'bounds or Maestro output' : 'crop or scale'}`,
      `drop ${used.join(' ')}, or pass --device for the lane's simulator or emulator`,
    );
  }
}

function targetOf(deps: DriverCliDeps, resolved: CallerLane): EngineTarget {
  return {
    stateDir: resolved.stateDir,
    lane: resolved.lane,
    env: deps.env,
    progress: line => {
      deps.stderr(`${TOOL}: ${line}\n`);
    },
  };
}

function saveImage(resolved: CallerLane, prefix: string, data: string, out?: string): string {
  const file = out ?? path.join(enginePaths(resolved.stateDir, resolved.lane.id).shots, `${prefix}-${stamp()}.jpg`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

function print(deps: DriverCliDeps, response: EngineResponse, json: boolean, extra: Record<string, unknown> = {}): number {
  if (json) {
    const { image, ...rest } = response;
    deps.stdout(
      `${JSON.stringify({ ...rest, ...(image ? { image: { mimeType: image.mimeType, bytes: Math.round((image.data.length * 3) / 4) } } : {}), ...extra }, null, 2)}\n`,
    );
  } else {
    const text = response.text ?? response.error ?? '';
    if (text) (response.ok ? deps.stdout : deps.stderr)(`${text}\n`);
  }
  return response.ok ? 0 : EXIT_FAILED;
}

function parseCrop(raw: string): Crop {
  const parts = raw.split(',').map(Number);
  const [x, y, width, height] = parts;
  if (
    parts.length !== 4 ||
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    parts.some(n => !Number.isFinite(n))
  ) {
    throw new UsageError(
      `--crop ${raw} is not x,y,width,height`,
      'pass --crop 0,100,402,300 (points, as look --bounds prints them)',
    );
  }
  if (width <= 0 || height <= 0) throw new UsageError(`--crop ${raw} has no area`, 'give a positive width and height');
  return { x, y, width, height };
}

function parseEnv(pairs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`--env ${pair} is not NAME=VALUE`, 'pass --env USER=alice');
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return env;
}

async function look(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      interactive: { type: 'boolean', default: false },
      within: { type: 'string' },
      depth: { type: 'string' },
      bounds: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      browser: { type: 'boolean', default: false },
      device: { type: 'boolean', default: false },
      worktree: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const lookArgs: LookArgs = { interactiveOnly: values.interactive, bounds: values.bounds, raw: values.raw };
  if (values.within !== undefined) lookArgs.within = values.within;
  if (values.depth !== undefined) {
    const depth = Number(values.depth);
    if (!Number.isInteger(depth) || depth < 1)
      throw new UsageError(`--depth ${values.depth} is not a level count`, 'pass --depth 2');
    lookArgs.depth = depth;
  }
  const resolved = laneFor(deps, values.worktree, values.device ? 'device' : values.browser ? 'browser' : 'either');
  const browser = values.device ? null : browserTarget(deps, resolved, values.browser);
  if (browser) {
    notOnBrowser({ bounds: values.bounds, raw: values.raw }, 'look');
    const page = await lookAtBrowser(browser, {
      interactiveOnly: values.interactive,
      ...(lookArgs.within === undefined ? {} : { within: lookArgs.within }),
      ...(lookArgs.depth === undefined ? {} : { depth: lookArgs.depth }),
    });
    touch(deps, resolved, 'look: browser');
    if (values.json) {
      deps.stdout(
        `${JSON.stringify({ ok: true, text: page.text, url: page.url, title: page.title, driver: page.driver, shown: page.shown, interactive: page.interactive }, null, 2)}\n`,
      );
    } else deps.stdout(`${page.text}\n`);
    return 0;
  }
  const response = await callEngine(targetOf(deps, resolved), { op: 'look', args: lookArgs });
  let screenshot: string | undefined;
  if (response.image) {
    screenshot = saveImage(resolved, 'look', response.image.data);
    if (!values.json) response.text = `${response.text ?? ''}\nScreenshot: ${screenshot}`;
  }
  return print(deps, response, values.json, screenshot ? { screenshot } : {});
}

function joinYamlValue(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const next = args[i + 1];
    if (arg === '--yaml' && next !== undefined) {
      out.push(`--yaml=${next}`);
      i += 1;
    } else out.push(arg);
  }
  return out;
}

async function run(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: joinYamlValue(args),
    strict: true,
    allowPositionals: true,
    options: {
      yaml: { type: 'string' },
      quick: { type: 'boolean', default: false },
      'app-id': { type: 'string' },
      env: { type: 'string', multiple: true, default: [] },
      worktree: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const [source, ...rest] = positionals;
  if (rest.length > 0 || (source === undefined) === (values.yaml === undefined)) {
    throw new UsageError('run takes one flow', `${CLI} run <flow.yaml>, ${CLI} run --yaml '<yaml>', or ${CLI} run - < flow.yaml`);
  }
  const runArgs: RunArgs = { quick: values.quick, env: parseEnv(values.env) };
  if (values['app-id'] !== undefined) runArgs.appId = values['app-id'];
  if (values.yaml !== undefined) runArgs.yaml = values.yaml;
  else if (source === '-') runArgs.yaml = await readAll(deps.stdin);
  else if (source !== undefined) {
    const file = path.resolve(deps.cwd, source);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile())
      throw new UsageError(`no flow file at ${file}`, 'pass the path of a Maestro flow');
    runArgs.file = file;
  }
  const resolved = laneFor(deps, values.worktree);
  const driverLogFrom = sizeOf(enginePaths(resolved.stateDir, resolved.lane.id).log);
  const response = await callEngine(targetOf(deps, resolved), { op: 'run', args: runArgs });
  let screenshot: string | undefined;
  if (response.image) {
    screenshot = saveImage(resolved, 'run', response.image.data);
    if (!values.json) response.text = `${response.text ?? ''}\nScreenshot: ${screenshot}`;
  }
  let kept: string | undefined;
  if (!response.ok) {
    kept = keepRunFailure(resolved.stateDir, resolved.lane.id, {
      flow: runArgs.yaml ?? (runArgs.file === undefined ? '' : fs.readFileSync(runArgs.file, 'utf8')),
      failure: response.text ?? response.error ?? '',
      screenshot: response.image ? Buffer.from(response.image.data, 'base64') : null,
      driverLogFrom,
    });
    if (!values.json) response.text = `${response.text ?? response.error ?? ''}\nKept (after release too): ${kept}`;
  }
  return print(deps, response, values.json, { ...(screenshot ? { screenshot } : {}), ...(kept ? { evidence: kept } : {}) });
}

async function screenshot(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      out: { type: 'string' },
      scale: { type: 'string' },
      crop: { type: 'string' },
      browser: { type: 'boolean', default: false },
      device: { type: 'boolean', default: false },
      worktree: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const shotArgs: ScreenshotArgs = {};
  if (values.scale !== undefined) {
    const scale = Number(values.scale);
    if (!(scale > 0 && scale <= 1)) throw new UsageError(`--scale ${values.scale} is not between 0 and 1`, 'pass --scale 0.5');
    shotArgs.scale = scale;
  }
  if (values.crop !== undefined) shotArgs.crop = parseCrop(values.crop);
  const resolved = laneFor(deps, values.worktree, values.device ? 'device' : values.browser ? 'browser' : 'either');
  const browser = values.device ? null : browserTarget(deps, resolved, values.browser);
  if (browser) {
    notOnBrowser({ scale: values.scale, crop: values.crop }, 'screenshot');
    const file = await screenshotBrowser(browser, values.out === undefined ? undefined : path.resolve(deps.cwd, values.out));
    touch(deps, resolved, 'screenshot: browser');
    if (values.json) deps.stdout(`${JSON.stringify({ ok: true, file, mimeType: 'image/png' }, null, 2)}\n`);
    else deps.stdout(`Screenshot of the lane's browser saved to ${file}\n`);
    return 0;
  }
  const response = await callEngine(targetOf(deps, resolved), { op: 'screenshot', args: shotArgs });
  if (!response.ok || !response.image) return print(deps, response, values.json);
  const file = saveImage(
    resolved,
    'screenshot',
    response.image.data,
    values.out === undefined ? undefined : path.resolve(deps.cwd, values.out),
  );
  response.text = `${response.text ?? ''} Saved to ${file}`;
  return print(deps, response, values.json, { file });
}

async function record(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { worktree: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const [action, file, ...rest] = positionals;
  if (
    rest.length > 0 ||
    !(action === 'save' || action === 'show' || action === 'clear') ||
    (action === 'save') !== (file !== undefined)
  ) {
    throw new UsageError('record takes save <file>, show or clear', `${CLI} record save flows/probe.yaml`);
  }
  const resolved = laneFor(deps, values.worktree);
  const response = await callEngine(targetOf(deps, resolved), {
    op: 'record',
    args: { action, ...(file === undefined ? {} : { file: path.resolve(deps.cwd, file) }) },
  });
  return print(deps, response, values.json);
}

async function driver(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { from: { type: 'string' }, worktree: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const [action, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`, `${CLI} driver start|status|stop|install`);
  switch (action) {
    case 'install': {
      const before = installedMaestro(deps.env);
      const jdk = await findJdk17(deps.env);
      const installed = await ensureMaestro({
        env: deps.env,
        ...(values.from === undefined ? {} : { from: path.resolve(deps.cwd, values.from) }),
        log: line => {
          deps.stderr(`${TOOL}: ${line}\n`);
        },
      });
      const summary = {
        version: installed.version,
        binary: installed.binary,
        javaHome: jdk.javaHome,
        jdk: jdk.origin,
        installedNow: installed.installedNow,
        alreadyInstalled: before !== undefined && values.from === undefined,
        seconds: installed.ms / 1000,
        sha256: MAESTRO_RELEASE.sha256,
      };
      if (values.json) deps.stdout(`${JSON.stringify(summary, null, 2)}\n`);
      else {
        deps.stdout(
          installed.installedNow
            ? `Installed Maestro ${installed.version} in ${(installed.ms / 1000).toFixed(1)} s: ${installed.binary}\n`
            : `Maestro ${installed.version} is installed: ${installed.binary}\n`,
        );
      }
      return 0;
    }
    case 'start': {
      const resolved = laneFor(deps, values.worktree);
      const started = Date.now();
      const response = await callEngine(targetOf(deps, resolved), { op: 'look', args: { interactiveOnly: true } });
      const seconds = (Date.now() - started) / 1000;
      if (values.json)
        deps.stdout(`${JSON.stringify({ ok: response.ok, pid: response.pid, seconds, error: response.error }, null, 2)}\n`);
      else if (response.ok)
        deps.stdout(
          `Driver ready for lane ${resolved.lane.id} (${resolved.lane.device?.name ?? ''}): first read in ${seconds.toFixed(2)} s.\n`,
        );
      else deps.stderr(`${response.error ?? response.text ?? 'the driver failed'}\n`);
      return response.ok ? 0 : EXIT_FAILED;
    }
    case 'status': {
      const resolved = laneFor(deps, values.worktree);
      const response = await engineStatus(resolved.stateDir, resolved.lane);
      if (values.json) deps.stdout(`${JSON.stringify(response?.status ?? { running: false }, null, 2)}\n`);
      else if (!response?.status)
        deps.stdout(`No driver runs for lane ${resolved.lane.id}; the next look, run or screenshot starts one.\n`);
      else {
        const s = response.status;
        deps.stdout(
          [
            `Driver for lane ${s.laneId} on ${s.device}: engine pid ${String(s.enginePid)}, up ${String(Math.round((Date.now() - s.startedAt) / 1000))} s`,
            `  maestro pid ${String(s.maestroPid ?? 'none')}, runner pid ${String(s.runnerPid ?? 'none')}${s.runnerPorts.length ? ` on port ${s.runnerPorts.join(', ')}` : ''}`,
            `  Maestro started ${String(s.starts)} time${s.starts === 1 ? '' : 's'}${s.restarts.length ? `; restarts: ${s.restarts.join('; ')}` : ''}`,
            `  log: ${s.log}`,
          ].join('\n') + '\n',
        );
      }
      return 0;
    }
    case 'stop': {
      const resolved = laneFor(deps, values.worktree);
      const stopped = await stopEngine(resolved.stateDir, resolved.lane);
      deps.stdout(
        stopped ? `Stopped the driver for lane ${resolved.lane.id}.\n` : `No driver ran for lane ${resolved.lane.id}.\n`,
      );
      return 0;
    }
    default:
      throw new UsageError(`'driver ${action ?? ''}' is not a driver command`, `${CLI} driver start|status|stop|install`);
  }
}

function parseSince(raw: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(raw);
  if (!m) throw new UsageError(`--since ${raw} is not a duration`, 'pass --since 10m, 90s or 1h');
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
}

function evidenceContext(deps: DriverCliDeps, resolved: CallerLane): EvidenceContext {
  return {
    stateDir: resolved.stateDir,
    lane: resolved.lane,
    env: deps.env,
    clock: systemClock,
    system: deps.evidence ?? realEvidenceSystem,
    browser: deps.browser ?? realBrowserTools,
    deviceShot: async () => {
      const response = await callEngine(targetOf(deps, resolved), { op: 'screenshot', args: {} });
      if (!response.ok || !response.image)
        throw new DriverError(response.error ?? response.text ?? 'the driver took no screenshot', `${CLI} doctor`);
      return Buffer.from(response.image.data, 'base64');
    },
  };
}

function listEvidence(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(name => !name.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

const EVIDENCE_FIX = `${CLI} evidence screenshot | video start|stop | trace start|stop | logs | list`;

async function evidence(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      browser: { type: 'boolean', default: false },
      device: { type: 'boolean', default: false },
      since: { type: 'string', default: '10m' },
      worktree: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (values.browser && values.device) throw new UsageError('pass one of --browser and --device', EVIDENCE_FIX);
  const [what = 'list', action, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`, EVIDENCE_FIX);
  const asked: EvidenceTarget | undefined = values.browser ? 'browser' : values.device ? 'device' : undefined;
  const resolved = laneFor(deps, values.worktree, asked ?? 'either');
  const ctx = evidenceContext(deps, resolved);
  const folder = laneEvidence(resolved.stateDir, resolved.lane.id);
  let kept: Kept;
  let said: string;
  switch (what) {
    case 'list': {
      if (action !== undefined) throw new UsageError(`'evidence list' takes no ${action}`, EVIDENCE_FIX);
      const entries = listEvidence(folder);
      if (values.json) deps.stdout(`${JSON.stringify({ folder, entries }, null, 2)}\n`);
      else deps.stdout(`${folder}\n${entries.map(e => `  ${e}`).join('\n')}${entries.length > 0 ? '\n' : '  (empty)\n'}`);
      return 0;
    }
    case 'screenshot': {
      if (action !== undefined) throw new UsageError(`'evidence screenshot' takes no ${action}`, EVIDENCE_FIX);
      kept = await keepScreenshot(ctx, evidenceTarget(resolved.lane, asked));
      said = `Saved ${kept.path}`;
      break;
    }
    case 'video':
    case 'trace': {
      if (action !== 'start' && action !== 'stop') throw new UsageError(`'evidence ${what}' takes start or stop`, EVIDENCE_FIX);
      const target = evidenceTarget(resolved.lane, asked);
      const verb = { video: { start: startVideo, stop: stopVideo }, trace: { start: startTrace, stop: stopTrace } }[what][action];
      kept = await verb(ctx, target);
      said =
        action === 'start'
          ? `Started the ${target} ${what === 'video' ? 'recording' : 'trace'}${what === 'video' ? ` into ${kept.path}` : ''}; ${CLI} evidence ${what} stop${asked ? ` --${asked}` : ''} keeps it.`
          : `Kept the ${target} ${what === 'video' ? 'recording' : 'trace'}: ${kept.path}`;
      break;
    }
    case 'logs': {
      if (action !== undefined) throw new UsageError(`'evidence logs' takes no ${action}`, EVIDENCE_FIX);
      const targets: EvidenceTarget[] = asked ? [asked] : (['device', 'browser'] as const).filter(t => resolved.lane[t] !== null);
      kept = await keepLogs(ctx, targets, parseSince(values.since));
      said = `Kept the lane's logs in ${kept.path}: ${kept.files.map(f => path.relative(kept.path, f)).join(', ') || 'none were found'}`;
      break;
    }
    default:
      throw new UsageError(`'evidence ${what}' is not an evidence command`, EVIDENCE_FIX);
  }
  touch(deps, resolved, `evidence ${what}${action ? ` ${action}` : ''}`);
  if (values.json) deps.stdout(`${JSON.stringify({ ok: kept.problems.length === 0, ...kept }, null, 2)}\n`);
  else {
    deps.stdout(`${said}\n${kept.notes.map(n => `  ${n}\n`).join('')}`);
    for (const problem of kept.problems) deps.stderr(`${TOOL}: ${problem}\n`);
  }
  return kept.problems.length === 0 ? 0 : EXIT_FAILED;
}

async function browserCommand(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      driver: { type: 'string', default: DEFAULT_BROWSER_DRIVER },
      from: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const [action, ...rest] = positionals;
  const fix = `${CLI} browser install [--driver playwright|agent-browser] | ${CLI} browser status`;
  if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`, fix);
  if (!isBrowserDriver(values.driver))
    throw new UsageError(
      `--driver ${values.driver} is not a browser driver`,
      `pass --driver ${BROWSER_DRIVERS.join(' or --driver ')}`,
    );
  const tools = deps.browser ?? realBrowserTools;
  switch (action) {
    case 'install': {
      const started = Date.now();
      const installed = await (values.from === undefined
        ? tools.install(values.driver, deps.env, line => {
            deps.stderr(`${TOOL}: ${line}\n`);
          })
        : ensureBrowserDriver(values.driver, {
            env: deps.env,
            from: path.resolve(deps.cwd, values.from),
            log: line => {
              deps.stderr(`${TOOL}: ${line}\n`);
            },
          }));
      const seconds = (Date.now() - started) / 1000;
      if (values.json) deps.stdout(`${JSON.stringify({ ...installed, seconds }, null, 2)}\n`);
      else
        deps.stdout(
          `${installed.driver} ${installed.version} is installed: ${installed.cli.join(' ')}\n  browsers: ${installed.browsersPath}\n`,
        );
      return 0;
    }
    case 'status': {
      const states = BROWSER_DRIVERS.map(driver => ({ driver, state: tools.state(driver, deps.env) }));
      if (values.json) deps.stdout(`${JSON.stringify(states, null, 2)}\n`);
      else for (const { driver, state } of states) deps.stdout(`${driver}: ${describeInstallState(driver, state)}\n`);
      return states.every(s => s.state.kind === 'installed') ? 0 : EXIT_FAILED;
    }
    default:
      throw new UsageError(`'browser ${action ?? ''}' is not a browser command`, fix);
  }
}

function notAControl(positionals: readonly string[], fix: string): never {
  throw new UsageError(`'device ${positionals.join(' ')}' is not a device control`, fix);
}

async function device(args: string[], deps: DriverCliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { worktree: { type: 'string' } },
  });
  const [control, ...rest] = positionals;
  const resolved = laneFor(deps, values.worktree);
  const claimed = resolved.lane.device;
  if (claimed?.platform === 'android') {
    if (!claimed.serial)
      throw new DriverError(
        `the lane's emulator ${claimed.name} is not running`,
        `${CLI} release, then ${CLI} claim --platform android`,
      );
    const adb = adbTools(deps, claimed.serial);
    await requireEmulatorBooted(adb);
    const said = await androidControl(adb, positionals);
    touch(deps, resolved, `device ${control ?? ''}`);
    deps.stdout(`${said}\n`);
    return 0;
  }
  const sim = deps.sim ?? createXcrunTools();
  const controls = deps.controls ?? createXcrunControls();
  const udid = claimed?.id ?? '';
  await requireBooted(sim, udid);
  let said: string;
  switch (control) {
    case 'location': {
      const [where] = rest;
      if (rest.length !== 1 || where === undefined)
        notAControl(positionals, `${CLI} device location 37.3349,-122.009 (or: clear)`);
      if (where === 'clear') {
        await controls.clearLocation(udid);
        said = 'Cleared the simulated location.';
        break;
      }
      const [latitude, longitude, ...more] = where.split(',').map(Number);
      if (
        latitude === undefined ||
        longitude === undefined ||
        more.length > 0 ||
        !(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)
      ) {
        notAControl(positionals, `${CLI} device location 37.3349,-122.009`);
      }
      await sim.setLocation(udid, { latitude, longitude });
      said = `Location set to ${String(latitude)},${String(longitude)}.`;
      break;
    }
    case 'permission': {
      const [action, service, bundleId, ...extra] = rest;
      if (
        extra.length > 0 ||
        !(action === 'grant' || action === 'revoke' || action === 'reset') ||
        service === undefined ||
        !isPrivacyService(service)
      ) {
        notAControl(
          positionals,
          `${CLI} device permission grant|revoke|reset <service> [<bundle id>]; services: ${PRIVACY_SERVICES.join(', ')}`,
        );
      }
      if (action !== 'reset' && bundleId === undefined)
        notAControl(positionals, `${CLI} device permission ${action} ${service} <bundle id>`);
      await controls.privacy(udid, action, service, bundleId);
      said = `Permission ${service}: ${action}${bundleId === undefined ? ' for every app' : ` for ${bundleId}`}.`;
      break;
    }
    case 'appearance': {
      const [mode] = rest;
      if (rest.length !== 1 || (mode !== 'light' && mode !== 'dark'))
        notAControl(positionals, `${CLI} device appearance light|dark`);
      await sim.setAppearance(udid, mode);
      const now = await sim.readAppearance(udid);
      if (now !== mode)
        throw new DriverError(
          `the appearance reads back as ${now ?? 'nothing'}, not ${mode}`,
          `retry; check 'xcrun simctl ui ${udid} appearance'`,
        );
      said = `Appearance is ${mode}.`;
      break;
    }
    case 'push': {
      const [bundleId, payloadFile] = rest;
      if (rest.length !== 2 || bundleId === undefined || payloadFile === undefined)
        notAControl(positionals, `${CLI} device push <bundle id> <payload.json | ->`);
      const payload =
        payloadFile === '-' ? await readAll(deps.stdin) : fs.readFileSync(path.resolve(deps.cwd, payloadFile), 'utf8');
      try {
        JSON.parse(payload);
      } catch {
        throw new UsageError('the push payload is not JSON', 'pass a JSON file with an "aps" key');
      }
      await controls.push(udid, bundleId, payload);
      said = `Sent a push to ${bundleId}.`;
      break;
    }
    case 'clipboard': {
      const [action, ...words] = rest;
      if (action === 'get' && words.length === 0) {
        deps.stdout(await controls.readClipboard(udid));
        touch(deps, resolved, 'device clipboard');
        return 0;
      }
      if (action !== 'set' || words.length === 0) notAControl(positionals, `${CLI} device clipboard set <text> | get`);
      const text = words.join(' ');
      await controls.writeClipboard(udid, text);
      const back = await controls.readClipboard(udid);
      if (back !== text) throw new DriverError('the clipboard reads back differently', `check 'xcrun simctl pbpaste ${udid}'`);
      said = 'Clipboard set.';
      break;
    }
    case 'open': {
      const [url] = rest;
      if (rest.length !== 1 || url === undefined || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url))
        notAControl(positionals, `${CLI} device open https://example.com`);
      await sim.openUrl(udid, url);
      said = `Opened ${url}.`;
      break;
    }
    default:
      notAControl(positionals, `${CLI} device location|permission|appearance|push|clipboard|open ...`);
  }
  touch(deps, resolved, `device ${control}`);
  deps.stdout(`${said}\n`);
  return 0;
}

function parseLocation(where: string | undefined): { latitude: number; longitude: number } | undefined {
  const [latitude, longitude, ...more] = (where ?? '').split(',').map(Number);
  if (latitude === undefined || longitude === undefined || more.length > 0) return undefined;
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : undefined;
}

async function androidPermission(adb: AdbTools, words: readonly string[], positionals: readonly string[]): Promise<string> {
  const [action, service, pkg, ...extra] = words;
  const permissions = service === undefined ? undefined : androidPermissionsOf(service);
  if (extra.length > 0 || !(action === 'grant' || action === 'revoke' || action === 'reset') || !permissions) {
    notAControl(
      positionals,
      `${CLI} device permission grant|revoke|reset <service> [<package>]; services on Android: ${ANDROID_SERVICES.join(', ')}`,
    );
  }
  if (action === 'reset' && pkg === undefined) {
    await adb.resetPermissions();
    return 'Reset the runtime permissions of every app.';
  }
  if (pkg === undefined) notAControl(positionals, `${CLI} device permission ${action} ${service ?? ''} <package>`);
  const skipped: string[] = [];
  for (const permission of permissions) {
    try {
      if (action === 'reset') {
        await adb.permission('revoke', pkg, permission);
        await adb.clearPermissionFlags(pkg, permission);
      } else {
        await adb.permission(action, pkg, permission);
      }
    } catch (error) {
      if (service === 'all' || /has not requested permission|Unknown permission/i.test((error as Error).message)) {
        skipped.push(permission.replace('android.permission.', ''));
        continue;
      }
      throw error;
    }
  }
  const done = permissions.length - skipped.length;
  if (done === 0) {
    throw new DriverError(
      `${pkg} requests none of ${permissions.join(', ')}`,
      'grant a permission the app declares in its manifest',
    );
  }
  const note = skipped.length > 0 ? ` (${pkg} doesn't request ${skipped.join(', ')})` : '';
  return `Permission ${service ?? ''}: ${action} for ${pkg}${note}.`;
}

async function androidControl(adb: AdbTools, positionals: readonly string[]): Promise<string> {
  const [control, ...rest] = positionals;
  switch (control) {
    case 'location': {
      if (rest[0] === 'clear') {
        throw new UsageError(
          "an emulator's GPS always has a fix, so it can't be cleared",
          `set another one: ${CLI} device location 37.3349,-122.009`,
        );
      }
      const at = rest.length === 1 ? parseLocation(rest[0]) : undefined;
      if (!at) notAControl(positionals, `${CLI} device location 37.3349,-122.009`);
      await adb.setLocation(at);
      return `Location set to ${String(at.latitude)},${String(at.longitude)}.`;
    }
    case 'permission':
      return androidPermission(adb, rest, positionals);
    case 'appearance': {
      const [mode] = rest;
      if (rest.length !== 1 || (mode !== 'light' && mode !== 'dark'))
        notAControl(positionals, `${CLI} device appearance light|dark`);
      await adb.setNightMode(mode);
      const now = await adb.nightMode();
      if (now !== mode)
        throw new DriverError(
          `the appearance reads back as ${now ?? 'nothing'}, not ${mode}`,
          `retry; check 'adb -s ${adb.serial} shell cmd uimode night'`,
        );
      return `Appearance is ${mode}.`;
    }
    case 'push':
      throw new UsageError(
        'an emulator has no local push: Firebase Cloud Messaging delivers pushes through Google, and no adb command hands one to an app',
        'test push handling on a simulator, or send a real message through FCM',
      );
    case 'clipboard':
      throw new UsageError(
        'an emulator has no shell command for the clipboard: Android lets only the focused app or the keyboard read or write it',
        `type the text with ${CLI} run (inputText), or use a simulator`,
      );
    case 'open': {
      const [url] = rest;
      if (rest.length !== 1 || url === undefined || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url))
        notAControl(positionals, `${CLI} device open https://example.com`);
      await adb.start(['-a', 'android.intent.action.VIEW', '-d', url]);
      return `Opened ${url}.`;
    }
    default:
      notAControl(positionals, `${CLI} device location|permission|appearance|open ...`);
  }
}

function touch(deps: DriverCliDeps, resolved: CallerLane, action: string): void {
  const registry = Registry.open({ dir: resolved.stateDir, processes: deps.processes, ports: tcpProbe, devices: {} });
  try {
    registry.touch({ id: resolved.lane.id, token: resolved.lane.token }, action);
  } finally {
    registry.close();
  }
}

async function mcp(args: string[], deps: DriverCliDeps): Promise<number> {
  if (args.length > 0) throw new UsageError(`'mcp' takes no arguments`, `${CLI} mcp`);
  await serveMcp({
    input: deps.stdin,
    output: deps.output,
    info: { name: TOOL, version: packageVersion() },
    tools: TOOLS,
    call: createToolHandler({ env: deps.env, cwd: deps.cwd, processes: deps.processes }),
  });
  return 0;
}

export async function runDriverCommand(command: string, args: string[], deps: DriverCliDeps): Promise<number> {
  try {
    switch (command) {
      case 'look':
        return await look(args, deps);
      case 'run':
        return await run(args, deps);
      case 'screenshot':
        return await screenshot(args, deps);
      case 'record':
        return await record(args, deps);
      case 'evidence':
        return await evidence(args, deps);
      case 'driver':
        return await driver(args, deps);
      case 'browser':
        return await browserCommand(args, deps);
      case 'device':
        return await device(args, deps);
      case 'mcp':
        return await mcp(args, deps);
      default:
        throw new UsageError(`'${command}' is not a driving command`, `run ${TOOL} --help`);
    }
  } catch (error) {
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      deps.stderr(`${TOOL} ${command}: ${error.message}\n\n${helpOf(DRIVER_HELP, command) ?? DRIVER_USAGE}`);
      return EXIT_USAGE;
    }
    if (error instanceof UsageError) {
      deps.stderr(`${TOOL}: ${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof NotClaimed || error instanceof Refusal) {
      deps.stderr(`${TOOL}: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    if (error instanceof DriverError || error instanceof DeviceStateError || error instanceof DeviceCommandError) {
      deps.stderr(`${TOOL}: ${error.message}\n`);
      return EXIT_FAILED;
    }
    throw error;
  }
}
