import crypto from 'node:crypto';
import path from 'node:path';
import { perUserTemp, SUN_PATH_LIMIT } from '../driver/paths.ts';
import { evidenceDir } from '../hooks/env.ts';
import { laneDir } from '../up/lane-files.ts';

/** Where a lane keeps its browser. Everything but the evidence goes when the lane's browser is stopped for good. */
export interface BrowserPaths {
  dir: string;
  profile: string;
  /** The lane's saved login, in Playwright's storage-state format. */
  storageState: string;
  /** playwright-cli's session files for this lane alone. */
  playwrightSessions: string;
  /** Holds `.playwright/cli.config.json`, read by playwright-cli as its global config. */
  playwrightConfigHome: string;
  /** agent-browser's sockets for this lane alone; outside the lane folder when that path is too long for a socket. */
  agentBrowserSockets: string;
  /** Where the drivers write snapshots and screenshots they take on their own. */
  output: string;
  /** The lane's wrappers for the drivers' CLIs. */
  bin: string;
  /** Recordings, traces, screenshots and logs kept on demand or on failure; this folder outlives the lane. */
  evidence: string;
}

export function browserPaths(stateDir: string, laneId: string, session: string, temp: () => string = perUserTemp): BrowserPaths {
  const lane = laneDir(stateDir, laneId);
  const dir = path.join(lane, 'browser');
  let sockets = path.join(dir, 'ab');
  if (Buffer.byteLength(path.join(sockets, `${session}.sock`)) > SUN_PATH_LIMIT) {
    const digest = crypto
      .createHash('sha256')
      .update(`${path.resolve(stateDir)}\0${laneId}`)
      .digest('hex')
      .slice(0, 10);
    sockets = path.join(temp(), `ab-${digest}`);
  }
  return {
    dir,
    profile: path.join(dir, 'profile'),
    storageState: path.join(dir, 'signin.json'),
    playwrightSessions: path.join(dir, 'playwright'),
    playwrightConfigHome: path.join(dir, 'config'),
    agentBrowserSockets: sockets,
    output: path.join(dir, 'output'),
    bin: path.join(lane, 'bin'),
    evidence: evidenceDir(lane),
  };
}
