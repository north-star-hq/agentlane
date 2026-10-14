import fs from 'node:fs';
import path from 'node:path';
import type { InstallCommand, Installer } from '../../src/agents/package.ts';

export interface RecordingInstaller {
  install: Installer;
  calls: { command: InstallCommand; cwd: string }[];
}

export function recordingInstaller(problem: string | null = null): RecordingInstaller {
  const calls: RecordingInstaller['calls'] = [];
  const install: Installer = (command, cwd) => {
    calls.push({ command, cwd });
    if (problem !== null) return { ok: false, problem };
    const file = path.join(cwd, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const spec = command.args.at(-1) ?? '';
    const listed = (manifest.devDependencies ?? {}) as Record<string, string>;
    manifest.devDependencies = { ...listed, agentlane: spec.replace(/^agentlane@/, '^') };
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return { ok: true };
  };
  return { install, calls };
}
