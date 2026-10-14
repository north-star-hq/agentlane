import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What an installed iOS app bundle shows about the build that made it. */
export interface IosBundleFacts {
  executable: string;
  /** Over the executable and, when there is one, its debug dylib, which holds a Debug build's code. */
  sha256: string | undefined;
  debugDylib: boolean;
  jsBundle: boolean;
}

/** The build `up` installed, as recorded in the lane's up record. */
export interface InstalledBuild {
  variant: string;
  sha256: string;
}

export interface VariantVerdict {
  ok: boolean;
  detail: string;
}

function plistExecutable(plist: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(plist, 'latin1');
  } catch {
    return undefined;
  }
  if (!text.startsWith('bplist')) return /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
  const result = spawnSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

/** One hash over the files that exist among `files`, in order; undefined when the first is missing. */
function sha256Of(files: readonly string[]): string | undefined {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1 << 20);
  for (const [index, file] of files.entries()) {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      if (index === 0) return undefined;
      continue;
    }
    try {
      hash.update(`${path.basename(file)}\0`);
      for (let read = fs.readSync(fd, chunk); read > 0; read = fs.readSync(fd, chunk)) hash.update(chunk.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
  }
  return hash.digest('hex');
}

export function readIosBundle(app: string): IosBundleFacts {
  const executable = plistExecutable(path.join(app, 'Info.plist')) ?? path.basename(app, '.app');
  return {
    executable,
    sha256: sha256Of([path.join(app, executable), path.join(app, `${executable}.debug.dylib`)]),
    debugDylib: fs.existsSync(path.join(app, `${executable}.debug.dylib`)),
    jsBundle: fs.existsSync(path.join(app, 'main.jsbundle')),
  };
}

/**
 * Debug or Release as an iOS bundle's files show it. Xcode 16 and later link a Debug build's code into
 * `<executable>.debug.dylib` (ENABLE_DEBUG_DYLIB), and React Native embeds `main.jsbundle` only in a Release build.
 */
function bundleVariant(facts: IosBundleFacts): { variant: 'Debug' | 'Release' | undefined; why: string } {
  if (facts.debugDylib) return { variant: 'Debug', why: `it has ${facts.executable}.debug.dylib` };
  if (facts.jsBundle) return { variant: 'Release', why: `it embeds main.jsbundle and has no ${facts.executable}.debug.dylib` };
  return { variant: undefined, why: `it has neither ${facts.executable}.debug.dylib nor main.jsbundle` };
}

const KNOWN = new Set(['Debug', 'Release']);

export function judgeIosVariant(facts: IosBundleFacts, expected: string, installed: InstalledBuild | undefined): VariantVerdict {
  const shown = bundleVariant(facts);
  const reads =
    shown.variant === undefined
      ? `its files don't show the variant (${shown.why})`
      : `it reads as ${shown.variant} (${shown.why})`;
  if (installed && facts.sha256 !== undefined) {
    if (installed.sha256 === facts.sha256) {
      return {
        ok: true,
        detail: `${installed.variant}: the build up installed (${facts.executable} sha256 ${facts.sha256.slice(0, 12)})`,
      };
    }
    return {
      ok: false,
      detail: `not the ${installed.variant} build up installed: ${facts.executable} has sha256 ${facts.sha256.slice(0, 12)}, not ${installed.sha256.slice(0, 12)}, and ${reads}`,
    };
  }
  if (shown.variant !== undefined && KNOWN.has(expected) && shown.variant !== expected) {
    return { ok: false, detail: `${shown.variant}, not the ${expected} build up makes: ${shown.why}` };
  }
  return { ok: true, detail: shown.variant === undefined ? `unknown: ${reads}` : `${shown.variant}: ${shown.why}` };
}

/** Android marks a debug build's package DEBUGGABLE, which `dumpsys package` lists in its flags. */
export function parseDebuggable(dumpsys: string): boolean | undefined {
  const flags = /\bflags=\[([^\]]*)\]/.exec(dumpsys)?.[1];
  return flags === undefined ? undefined : flags.split(/\s+/).includes('DEBUGGABLE');
}

export function judgeAndroidVariant(pkg: string, debuggable: boolean | undefined, expected: string): VariantVerdict {
  if (debuggable === undefined) return { ok: true, detail: `unknown: dumpsys package ${pkg} lists no flags` };
  const shown = debuggable ? 'Debug' : 'Release';
  const why = `${pkg} is ${debuggable ? '' : 'not '}debuggable`;
  if (KNOWN.has(expected) && shown !== expected)
    return { ok: false, detail: `${shown}, not the ${expected} build up makes: ${why}` };
  return { ok: true, detail: `${shown}: ${why}` };
}
