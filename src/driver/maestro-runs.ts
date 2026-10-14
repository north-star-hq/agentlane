import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where `maestro test` writes a run's output when no option moves it: `$XDG_STATE_HOME/maestro/tests` when that is set,
 * else `~/.maestro/tests` (Maestro's `EnvUtils.xdgStateHome`).
 */
export function maestroRunsDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_STATE_HOME;
  return xdg ? path.join(xdg, 'maestro', 'tests') : path.join(env.HOME ?? os.homedir(), '.maestro', 'tests');
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Removes the links in Maestro's runs folder that point into `lanes` at a run that is gone, the ones the lane's
 * maestro made for runs whose lane folder was pruned. Every other entry stays.
 */
export function sweepMaestroRunLinks(env: NodeJS.ProcessEnv, lanes: string): string[] {
  const dir = maestroRunsDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const link = path.join(dir, name);
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      const target = path.resolve(dir, fs.readlinkSync(link));
      if (!inside(target, lanes) || fs.existsSync(target)) continue;
      fs.unlinkSync(link);
      removed.push(link);
    } catch {
      continue;
    }
  }
  return removed;
}
