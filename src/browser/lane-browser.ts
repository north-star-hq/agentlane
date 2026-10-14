import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.ts';
import { DriverError, messageOf } from '../driver/errors.ts';
import { CLI } from '../name.ts';
import { laneEnvironment, webUrl } from '../hooks/env.ts';
import type { ProjectConfig } from '../project/config.ts';
import { loadLaneConfig } from '../project/config.ts';
import { laneDir, readUpRecord } from '../up/lane-files.ts';
import type { Registry } from '../registry/registry.ts';
import type { ClaimedBrowser, LaneInfo, EndedBrowser } from '../registry/types.ts';
import type { BrowserControl } from './control.ts';
import { browserVariables, cdpUrl, writeDriverFiles, type BrowserSetting } from './env.ts';
import { INSTALL_FIX, describeInstallState, type InstalledDriver } from './install.ts';
import type { BrowserDriverName } from './kinds.ts';
import { browserPaths, type BrowserPaths } from './paths.ts';
import { acceptSavedLogin, describeSavedLogin, type SavedLogin } from './signin.ts';
import { describeProcesses, onProfile, stopBrowserProcesses, type BrowserMarks, type BrowserStop } from './stop.ts';
import type { BrowserTools } from './tools.ts';

export interface LaneBrowser {
  setting: BrowserSetting;
  vars: Record<string, string>;
  control: BrowserControl;
}

export interface BrowserContext {
  tools: BrowserTools;
  stateDir: string;
  lane: LaneInfo & { browser: ClaimedBrowser };
  config: ProjectConfig | null;
  url: string | null;
  /** The caller's environment, which the lane's variables are laid over. */
  env: NodeJS.ProcessEnv;
  /** The lane's environment without the browser's variables, which control calls run with. */
  laneEnv: NodeJS.ProcessEnv;
  cwd: string;
  log: (line: string) => void;
}

const SHIM: Record<BrowserDriverName, string> = { playwright: 'playwright-cli', 'agent-browser': 'agent-browser' };

export function hasBrowser(lane: LaneInfo): lane is LaneInfo & { browser: ClaimedBrowser } {
  return lane.browser !== null;
}

export function pathsOf(stateDir: string, lane: { id: string; browser: Pick<ClaimedBrowser, 'session'> }): BrowserPaths {
  return browserPaths(stateDir, lane.id, lane.browser.session);
}

function marksOf(stateDir: string, lane: string, session: string): BrowserMarks {
  return { session, paths: browserPaths(stateDir, lane, session) };
}

/** Installs the lane's driver if it must, writes its wrapper and settings, and returns its variables and control. */
export async function laneBrowser(ctx: BrowserContext, install?: InstalledDriver): Promise<LaneBrowser> {
  const { browser } = ctx.lane;
  const installed = install ?? (await ctx.tools.install(browser.driver, ctx.env, ctx.log));
  const setting: BrowserSetting = {
    browser,
    paths: pathsOf(ctx.stateDir, ctx.lane),
    install: installed,
    headed: ctx.config?.web?.browser.headed ?? false,
    url: ctx.url,
  };
  writeDriverFiles(setting, ctx.lane.id);
  const vars = browserVariables(setting, ctx.laneEnv.PATH ?? ctx.env.PATH ?? '/usr/bin:/bin');
  const control = ctx.tools.control(
    browser.driver,
    path.join(setting.paths.bin, SHIM[browser.driver]),
    { ...ctx.laneEnv, ...vars },
    ctx.cwd,
  );
  return { setting, vars, control };
}

/**
 * The lane's browser for a command outside `up` (look, screenshot, evidence, release): with the config `up` last ran
 * for it when that config still loads, so the web app's URL and the headed setting carry over.
 */
export async function browserOfLane(
  tools: BrowserTools,
  stateDir: string,
  lane: LaneInfo & { browser: ClaimedBrowser },
  env: NodeJS.ProcessEnv,
  install?: InstalledDriver,
): Promise<LaneBrowser> {
  const dir = laneDir(stateDir, lane.id);
  const record = readUpRecord(dir);
  const config = ((): ProjectConfig | null => {
    try {
      return record ? loadLaneConfig(record.config, record.platform) : null;
    } catch {
      return null;
    }
  })();
  return laneBrowser(
    {
      tools,
      stateDir,
      lane,
      config,
      url: webUrl(config, lane),
      env,
      laneEnv: laneEnvironment(env, lane, config, dir),
      cwd: config?.dir ?? lane.worktree,
      log: () => undefined,
    },
    install,
  );
}

/** Stops whatever of the lane's browser runs under the driver it no longer uses, after its driver changed. */
async function stopOtherDriver(ctx: BrowserContext, clock: Clock): Promise<string | null> {
  const stopped = await stopBrowserProcesses(
    ctx.tools.processes,
    marksOf(ctx.stateDir, ctx.lane.id, ctx.lane.browser.session),
    clock,
  );
  return stopped.stopped.length > 0 ? `stopped ${describeProcesses(stopped.stopped)} left from before` : null;
}

export interface OpenedBrowser {
  browser: LaneBrowser;
  detail: string;
}

/** Opens the web app in the lane's browser: started with the lane's profile, on its debugging port. */
export async function openWebApp(ctx: BrowserContext, clock: Clock, driverChanged: boolean): Promise<OpenedBrowser> {
  if (ctx.url === null) throw new Error(`lane ${ctx.lane.id} has no port for the web app's service`);
  const notes: string[] = [];
  if (driverChanged) {
    const left = await stopOtherDriver(ctx, clock);
    if (left) notes.push(left);
  }
  const browser = await laneBrowser(ctx);
  const libraries = await librariesCheck(ctx.tools, browser.setting.install);
  if (libraries && !libraries.ok) throw new DriverError(libraries.detail, libraries.fix);
  await browser.control.open(ctx.url);
  const where = `${browser.control.driver} session ${ctx.lane.browser.session}, debugging port ${String(ctx.lane.browser.debugPort)}${ctx.lane.browser.streamPort === null ? '' : `, stream port ${String(ctx.lane.browser.streamPort)}`}`;
  return { browser, detail: [`opened ${ctx.url} (${where})`, ...notes].join('; ') };
}

/** Starts the lane's browser on the saved login the signin hook wrote, and opens the web app again with it. */
export async function signInBrowser(ctx: BrowserContext, browser: LaneBrowser): Promise<SavedLogin> {
  const login = acceptSavedLogin(browser.setting.paths.storageState, ctx.url);
  await browser.control.loadState(login.file);
  if (ctx.url !== null) await browser.control.open(ctx.url);
  return login;
}

export { describeSavedLogin };

/** Keeps a trace of the driver's actions running, so a failed command run under `exec` can leave it behind. */
export async function startFailureTrace(browser: LaneBrowser): Promise<boolean> {
  if (!browser.control.tracesActions) return false;
  await browser.control.traceStart();
  return true;
}

/** Removes what the lane's browser kept that holds its login: the profile and the saved login. Evidence stays. */
function forgetLogin(paths: BrowserPaths): void {
  for (const target of [paths.profile, paths.storageState, paths.playwrightSessions, paths.output, paths.agentBrowserSockets]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

export interface BrowserTeardown {
  notes: string[];
  problems: string[];
}

/** Stops a lane's browser: the driver's own close first, then every process of it the process table still shows. */
export async function stopLaneBrowser(
  tools: BrowserTools,
  stateDir: string,
  lane: string,
  session: string,
  clock: Clock,
  control: BrowserControl | null,
): Promise<BrowserTeardown> {
  const result: BrowserTeardown = { notes: [], problems: [] };
  if (control) {
    try {
      if (await control.isOpen()) {
        await control.close();
        result.notes.push(`closed the ${control.driver} session ${session}`);
      }
    } catch (error) {
      result.notes.push(
        `the driver could not close its session (${messageOf(error).split('\n')[0] ?? ''}); stopping its processes`,
      );
    }
  }
  const marks = marksOf(stateDir, lane, session);
  const stopped: BrowserStop = await stopBrowserProcesses(tools.processes, marks, clock);
  if (stopped.stopped.length > 0) result.notes.push(`stopped the browser's processes: ${describeProcesses(stopped.stopped)}`);
  if (stopped.left === undefined)
    result.problems.push(`the process table could not be read, so the browser of lane ${lane} may still run`);
  else if (stopped.left.length > 0)
    result.problems.push(`the browser of lane ${lane} survived SIGKILL: ${describeProcesses(stopped.left)}`);
  else forgetLogin(marks.paths);
  return result;
}

/** Stops the browsers of lanes that have ended, however they ended, and forgets each once nothing of it runs. */
export async function stopEndedBrowsers(
  tools: BrowserTools,
  registry: Registry,
  stateDir: string,
  clock: Clock,
): Promise<{ lane: string; notes: string[]; problems: string[] }[]> {
  const results: { lane: string; notes: string[]; problems: string[] }[] = [];
  for (const ended of registry.endedBrowsers()) {
    const done = await stopLaneBrowser(tools, stateDir, ended.lane, ended.session, clock, null);
    if (done.problems.length === 0) registry.forgetBrowser(ended.lane);
    if (done.notes.length > 0 || done.problems.length > 0) results.push({ lane: ended.lane, ...done });
  }
  return results;
}

export type { EndedBrowser };

export interface BrowserCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

const UP = `${CLI} up`;

/** Playwright's own command that installs, through apt, the system libraries its Chromium builds need. */
export function installDepsCommand(installed: InstalledDriver, root = process.getuid?.() === 0): string {
  return `${root ? '' : 'sudo '}${process.execPath} ${path.join(installed.playwrightCore, 'cli.js')} install-deps chromium`;
}

/** Whether the machine has the system libraries the lane's browsers link; null where that isn't checked. */
async function librariesCheck(tools: BrowserTools, installed: InstalledDriver): Promise<BrowserCheck | null> {
  const missing = await tools.missingLibraries(installed);
  if (missing === null) return null;
  const ok = missing.length === 0;
  return {
    name: 'browser libraries',
    ok,
    detail: ok
      ? 'Chrome for Testing finds every system library it links'
      : `Chrome for Testing can't start without system libraries this machine lacks: ${missing.join(', ')}`,
    fix: ok
      ? ''
      : `${installDepsCommand(installed)} (apt packages, for Ubuntu and Debian; elsewhere install the packages that provide these libraries)`,
  };
}

/** Whether the lane's browser runs, and is this lane's: its debugging port answers, from a browser on the lane's profile. */
export async function browserChecks(
  tools: BrowserTools,
  stateDir: string,
  lane: LaneInfo & { browser: ClaimedBrowser },
  env: NodeJS.ProcessEnv,
): Promise<BrowserCheck[]> {
  const { browser } = lane;
  const state = tools.state(browser.driver, env);
  const checks: BrowserCheck[] = [
    {
      name: 'browser driver',
      ok: state.kind === 'installed',
      detail: describeInstallState(browser.driver, state),
      fix:
        state.kind === 'installed' ? '' : `${INSTALL_FIX}${browser.driver === 'agent-browser' ? ' --driver agent-browser' : ''}`,
    },
  ];
  if (state.kind === 'installed') {
    const libraries = await librariesCheck(tools, state.driver);
    if (libraries) checks.push(libraries);
  }
  const paths = pathsOf(stateDir, lane);
  const answer = await tools.probe(`${cdpUrl(browser)}/json/version`);
  const table = tools.processes.list();
  const running = table?.filter(e => onProfile(e.args, paths.profile)) ?? [];
  if (answer?.status !== 200) {
    checks.push({
      name: 'browser',
      ok: false,
      detail:
        running.length > 0
          ? `a browser runs on the lane's profile (${describeProcesses(running.slice(0, 1))}), but nothing answers on its debugging port ${String(browser.debugPort)}`
          : `the lane's browser is not running: nothing answers on its debugging port ${String(browser.debugPort)}`,
      fix: `${UP} (it opens the web app in the lane's browser)`,
    });
    return checks;
  }
  const version = (() => {
    try {
      return (JSON.parse(answer.body) as { Browser?: string }).Browser ?? 'a browser';
    } catch {
      return 'something that is not a browser';
    }
  })();
  const listening = tools.listeners(browser.debugPort);
  const ours = listening === undefined ? running.length > 0 : listening.some(pid => running.some(e => e.pid === pid));
  checks.push({
    name: 'browser',
    ok: ours,
    detail: ours
      ? `${version} on debugging port ${String(browser.debugPort)}, with this lane's profile ${paths.profile}, ${browser.driver} session ${browser.session}`
      : `${version} answers on debugging port ${String(browser.debugPort)}, but no browser runs on this lane's profile ${paths.profile}: that port is another browser's`,
    fix: ours
      ? ''
      : `stop what listens on ${String(browser.debugPort)} (lsof -nP -iTCP:${String(browser.debugPort)} -sTCP:LISTEN), then ${UP}`,
  });
  return checks;
}
