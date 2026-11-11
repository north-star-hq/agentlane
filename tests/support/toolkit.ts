import fs from 'node:fs';
import path from 'node:path';
import { toolVersion } from '../../src/agents/package.ts';

export function writeToolkit(dir: string, script: string, version: string = toolVersion()): string {
  const manifest = path.join(dir, 'node_modules/agentlane/package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify({ name: 'agentlane', version })}\n`);
  const bin = path.join(dir, 'node_modules/.bin/agentlane');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}
