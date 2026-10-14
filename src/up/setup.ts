import { spawn } from 'node:child_process';
import { envName, TOOL } from '../name.ts';
import { hookEnvironment, resourceVariables } from '../hooks/env.ts';
import { resolveFolder } from '../registry-cli.ts';
import type { EnvDeps } from './deps.ts';
import { locateConfig } from './up.ts';

export interface SetupResult {
  ran: boolean;
  code: number;
  ms: number;
}

export async function runSetup(deps: Pick<EnvDeps, 'env' | 'cwd' | 'log'>, worktree: string | undefined): Promise<SetupResult> {
  const start = worktree ?? deps.cwd;
  const folder = resolveFolder(start).worktree;
  const config = locateConfig(start);
  const command = config.hooks.setup;
  if (!command) {
    deps.log(`${TOOL} setup: ${config.file} has no setup hook; nothing to run`);
    return { ran: false, code: 0, ms: 0 };
  }
  const env = hookEnvironment(deps.env, { [envName('WORKTREE')]: folder }, resourceVariables(config));
  deps.log(`${TOOL} setup: ${command}   (in ${config.dir})`);
  const started = Date.now();
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: config.dir, env, stdio: ['ignore', 2, 2] });
    child.once('error', reject);
    child.once('close', (exit, signal) => {
      resolve(exit ?? (signal ? 128 : 1));
    });
  });
  const ms = Date.now() - started;
  deps.log(`${TOOL} setup: ${code === 0 ? 'done' : `the setup hook exited ${String(code)}`} (${(ms / 1000).toFixed(1)} s)`);
  return { ran: true, code, ms };
}
