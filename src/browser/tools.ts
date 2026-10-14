import { realServiceSystem } from '../services/system.ts';
import type { BrowserControl } from './control.ts';
import { controlFor } from './control.ts';
import type { InstalledDriver, InstallState } from './install.ts';
import { ensureBrowserDriver, installState } from './install.ts';
import type { BrowserDriverName } from './kinds.ts';
import { missingLibraries, systemLdd } from './libraries.ts';
import type { BrowserProcessSystem } from './stop.ts';
import { realBrowserProcesses } from './stop.ts';

/** What the toolkit needs from the machine to run a lane's browser; tests replace it. */
export interface BrowserTools {
  install(driver: BrowserDriverName, env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<InstalledDriver>;
  state(driver: BrowserDriverName, env: NodeJS.ProcessEnv): InstallState;
  control(driver: BrowserDriverName, shim: string, env: NodeJS.ProcessEnv, cwd: string): BrowserControl;
  processes: BrowserProcessSystem;
  /** Answers GET on a URL without following redirects, or null when nothing answers. */
  probe(url: string): Promise<{ status: number; body: string } | null>;
  /** The pids listening on a port; undefined when that can't be read. */
  listeners(port: number): number[] | undefined;
  /** The system libraries the installed browsers lack, by file name; null where that isn't checked (off Linux). */
  missingLibraries(installed: InstalledDriver): Promise<string[] | null>;
}

export async function probeUrl(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  }
}

export const realBrowserTools: BrowserTools = {
  install: (driver, env, log) => ensureBrowserDriver(driver, { env, log }),
  state: (driver, env) => installState(env, driver),
  control: controlFor,
  processes: realBrowserProcesses,
  probe: probeUrl,
  listeners: port => realServiceSystem.listeners(port),
  missingLibraries: installed =>
    process.platform === 'linux'
      ? missingLibraries([installed.chrome, installed.headlessShell], systemLdd)
      : Promise.resolve(null),
};
