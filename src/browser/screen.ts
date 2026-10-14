import fs from 'node:fs';
import path from 'node:path';
import type { ClaimedBrowser, LaneInfo } from '../registry/types.ts';
import { lookAtPage, type BrowserLook, type BrowserLookOptions } from './aria.ts';
import { browserOfLane } from './lane-browser.ts';
import { evidenceStamp } from '../evidence/files.ts';
import type { BrowserTools } from './tools.ts';

export interface BrowserScreenTarget {
  tools: BrowserTools;
  stateDir: string;
  lane: LaneInfo & { browser: ClaimedBrowser };
  env: NodeJS.ProcessEnv;
}

export interface PageLook extends BrowserLook {
  url: string;
  title: string;
  driver: ClaimedBrowser['driver'];
}

/** Reads the page in the lane's browser through its driver, and renders it as `look` renders a device screen. */
export async function lookAtBrowser(target: BrowserScreenTarget, options: BrowserLookOptions): Promise<PageLook> {
  const { control } = await browserOfLane(target.tools, target.stateDir, target.lane, target.env);
  const page = await control.read();
  return { ...lookAtPage(page, options), url: page.url, title: page.title, driver: control.driver };
}

/** A PNG of the lane's browser viewport, taken by its driver; kept with the lane's logs unless `out` names a file. */
export async function screenshotBrowser(target: BrowserScreenTarget, out?: string): Promise<string> {
  const { control, setting } = await browserOfLane(target.tools, target.stateDir, target.lane, target.env);
  const file = out ?? path.join(path.dirname(setting.paths.evidence), 'shots', `browser-${evidenceStamp()}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await control.screenshot(file);
  return file;
}
