import fs from 'node:fs';
import path from 'node:path';
import { CLI, envName, TOOL } from '../name.ts';
import { STORAGE_STATE_ENV } from '../project/schema.ts';
import { shellQuote } from '../registry/format.ts';
import type { ClaimedBrowser } from '../registry/types.ts';
import type { InstalledDriver } from './install.ts';
import type { BrowserPaths } from './paths.ts';

export const BROWSER_DRIVER_ENV = envName('BROWSER_DRIVER');
export const BROWSER_SESSION_ENV = envName('BROWSER_SESSION');
export const BROWSER_PROFILE_ENV = envName('BROWSER_PROFILE');
export const BROWSER_CDP_ENV = envName('BROWSER_CDP');

export interface BrowserSetting {
  browser: ClaimedBrowser;
  paths: BrowserPaths;
  install: InstalledDriver;
  headed: boolean;
  url: string | null;
}

export function cdpUrl(browser: Pick<ClaimedBrowser, 'debugPort'>): string {
  return `http://127.0.0.1:${String(browser.debugPort)}`;
}

/** Playwright's global CLI config for the lane: the launch flag that gives the browser the lane's debugging port. */
export function playwrightConfig(browser: ClaimedBrowser): string {
  return `${JSON.stringify({ browser: { launchOptions: { args: [`--remote-debugging-port=${String(browser.debugPort)}`] } } }, null, 2)}\n`;
}

export function playwrightShim(cli: readonly string[], laneId: string): string {
  return `#!/bin/sh
# ${TOOL}: playwright-cli for lane ${laneId}, the toolkit's pinned build.
for arg in "$@"; do
  case "$arg" in
    kill-all)
      echo "${TOOL}: playwright-cli kill-all stops every Playwright browser on this Mac, other lanes' too. Run playwright-cli close-all: it closes this lane's sessions." >&2
      exit 2 ;;
    install-browser)
      echo "${TOOL}: the lane's browsers are pinned and installed by ${TOOL} into a folder other lanes share, so playwright-cli install-browser is refused here; ${CLI} browser install installs them." >&2
      exit 2 ;;
  esac
done
exec ${cli.map(shellQuote).join(' ')} "$@"
`;
}

export function agentBrowserShim(cli: readonly string[], ffmpegDir: string | null): string {
  const pathLine = ffmpegDir === null ? '' : `PATH=${shellQuote(ffmpegDir)}:"$PATH"\nexport PATH\n`;
  return `#!/bin/sh
# ${TOOL}: agent-browser, the toolkit's pinned build, on the toolkit's Chrome for Testing.
case "$1" in
  install|upgrade)
    echo "${TOOL}: agent-browser and its Chrome are pinned and installed by ${TOOL} (${CLI} browser install), so agent-browser $1 is refused here." >&2
    exit 2 ;;
esac
${pathLine}exec ${cli.map(shellQuote).join(' ')} "$@"
`;
}

function writeExecutable(file: string, content: string): void {
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o755 });
  fs.renameSync(temp, file);
}

/** Writes the lane's driver wrapper and the files its driver reads, and returns the folder that goes first on PATH. */
export function writeDriverFiles(setting: BrowserSetting, laneId: string): string {
  const { paths, install, browser } = setting;
  for (const dir of [paths.dir, paths.bin, paths.output, paths.evidence]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (browser.driver === 'playwright') {
    fs.mkdirSync(paths.playwrightSessions, { recursive: true, mode: 0o700 });
    const config = path.join(paths.playwrightConfigHome, '.playwright');
    fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config, 'cli.config.json'), playwrightConfig(browser));
    writeExecutable(path.join(paths.bin, 'playwright-cli'), playwrightShim(install.cli, laneId));
  } else {
    fs.mkdirSync(paths.agentBrowserSockets, { recursive: true, mode: 0o700 });
    let ffmpegDir: string | null = null;
    if (install.ffmpeg !== '') {
      ffmpegDir = path.join(paths.dir, 'ffmpeg');
      fs.mkdirSync(ffmpegDir, { recursive: true, mode: 0o700 });
      const link = path.join(ffmpegDir, 'ffmpeg');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(install.ffmpeg, link);
    }
    writeExecutable(path.join(paths.bin, 'agent-browser'), agentBrowserShim(install.cli, ffmpegDir));
  }
  return paths.bin;
}

/**
 * The variables that bind the driver's own CLI, and Playwright tests, to the lane's browser. Both drivers read their
 * session, profile and launch settings from these; playwright-cli's session and config folders are its PWTEST_
 * variables, the only way it takes them.
 */
export function browserVariables(setting: BrowserSetting, basePath: string): Record<string, string> {
  const { browser, paths, install } = setting;
  const vars: Record<string, string> = {
    [BROWSER_DRIVER_ENV]: browser.driver,
    [BROWSER_SESSION_ENV]: browser.session,
    [BROWSER_PROFILE_ENV]: paths.profile,
    [BROWSER_CDP_ENV]: cdpUrl(browser),
    [STORAGE_STATE_ENV]: paths.storageState,
    PLAYWRIGHT_BROWSERS_PATH: install.browsersPath,
    PATH: [paths.bin, basePath].join(path.delimiter),
  };
  if (setting.url !== null) vars.PLAYWRIGHT_TEST_BASE_URL = setting.url;
  if (browser.driver === 'playwright') {
    Object.assign(vars, {
      PLAYWRIGHT_CLI_SESSION: browser.session,
      PWTEST_DAEMON_SESSION_DIR: paths.playwrightSessions,
      PWTEST_CLI_GLOBAL_CONFIG: paths.playwrightConfigHome,
      PLAYWRIGHT_MCP_BROWSER: 'chromium',
      PLAYWRIGHT_MCP_USER_DATA_DIR: paths.profile,
      PLAYWRIGHT_MCP_HEADLESS: setting.headed ? 'false' : 'true',
      PLAYWRIGHT_MCP_OUTPUT_DIR: paths.output,
    });
    return vars;
  }
  Object.assign(vars, {
    AGENT_BROWSER_SESSION: browser.session,
    AGENT_BROWSER_SOCKET_DIR: paths.agentBrowserSockets,
    AGENT_BROWSER_PROFILE: paths.profile,
    AGENT_BROWSER_ARGS: `--remote-debugging-port=${String(browser.debugPort)}`,
    AGENT_BROWSER_SCREENSHOT_DIR: paths.output,
  });
  if (install.headlessShell !== '') vars.AGENT_BROWSER_EXECUTABLE_PATH = install.headlessShell;
  if (browser.streamPort !== null) vars.AGENT_BROWSER_STREAM_PORT = String(browser.streamPort);
  return vars;
}
