import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../driver/exec.ts';

/** Runs `ldd` on a file with extra library folders: its output, or null when ldd can't run here. */
export type Ldd = (file: string, libraryPath: string[]) => Promise<string | null>;

/** The libraries `ldd` lists as `<name> => not found`. */
export function notFound(lddOutput: string): string[] {
  return lddOutput
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.endsWith('not found') && line.includes('=>'))
    .map(line => line.split('=>')[0]?.trim() ?? '')
    .filter(name => name !== '');
}

function sharedLibrariesBeside(executable: string): string[] {
  const folder = path.dirname(executable);
  try {
    return fs
      .readdirSync(folder)
      .filter(name => /\.so(\.|$)/.test(name))
      .map(name => path.join(folder, name))
      .filter(file => fs.statSync(file).isFile());
  } catch {
    return [];
  }
}

/**
 * The system libraries the executables, and the shared libraries shipped beside them, need and the machine lacks,
 * sorted; null when ldd can't run or none of them exists. Each executable's own folder is on the library path, as the
 * browser loads from it.
 */
export async function missingLibraries(executables: string[], ldd: Ldd): Promise<string[] | null> {
  const present = executables.filter(e => e !== '' && fs.statSync(e, { throwIfNoEntry: false })?.isFile());
  if (present.length === 0) return null;
  const missing = new Set<string>();
  for (const executable of present) {
    for (const file of [executable, ...sharedLibrariesBeside(executable)]) {
      const output = await ldd(file, [path.dirname(executable)]);
      if (output === null) return null;
      for (const name of notFound(output)) missing.add(name);
    }
  }
  return [...missing].sort();
}

export const systemLdd: Ldd = async (file, libraryPath) => {
  const inherited = process.env.LD_LIBRARY_PATH;
  const ran = await runCommand('ldd', [file], {
    env: { ...process.env, LD_LIBRARY_PATH: [...(inherited ? [inherited] : []), ...libraryPath].join(':') },
    timeoutMs: 30_000,
  });
  if (ran.error !== undefined) return null;
  return ran.stdout;
};
