import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolVersion } from '../../src/agents/package.ts';

const CLI_SOURCE = path.resolve(import.meta.dirname, '..', '..', 'src', 'cli.ts');

/** The file the fixture's manifest names as its `bin`, which runs this checkout's CLI from source. */
export function toolkitEntry(dir: string): string {
  return path.join(dir, 'node_modules/agentlane/dist/cli.js');
}

/**
 * A toolkit laid out as pnpm installs one: `node_modules/agentlane` holds the manifest and its `bin` entry, and
 * `node_modules/.bin/agentlane` is a shell shim running `script`.
 */
export function writeToolkit(dir: string, script: string, version: string = toolVersion()): string {
  const manifest = path.join(dir, 'node_modules/agentlane/package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({ name: 'agentlane', version, type: 'module', bin: { agentlane: 'dist/cli.js' } })}\n`,
  );
  const entry = toolkitEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(CLI_SOURCE).href)};\n`);
  const bin = path.join(dir, 'node_modules/.bin/agentlane');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}
