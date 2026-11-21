import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killGroup } from '../processes.ts';

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  timedOut?: boolean;
}

export interface HookRun extends CommandResult {
  hook: string;
  command: string;
  log: string;
  timeoutMs?: number;
}

export function describeExit(run: HookRun): string {
  if (run.timedOut) return `ran past its ${String((run.timeoutMs ?? 0) / 1000)} s and was stopped`;
  return run.signal ? `was killed by ${run.signal}` : `exited ${String(run.code)}`;
}

export class HookFailed extends Error {
  readonly run: HookRun;

  constructor(run: HookRun, tail: string) {
    super(`the ${run.hook} hook ${describeExit(run)}: ${run.command}\n${tail}\nfull log: ${run.log}`);
    this.name = 'HookFailed';
    this.run = run;
  }
}

export function tail(file: string, lines = 30): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '(no output)';
  }
  const all = text.trimEnd().split('\n');
  return all
    .slice(-lines)
    .map(line => `  | ${line}`)
    .join('\n');
}

/** Where a hook runs, and where its output goes. */
interface HookPlace {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: string;
}

/**
 * How long a hook may run, and whether it is fenced. With a timeout, its shell leads a process group of its own, which
 * is ended whole once the timeout passes. A fenced hook always has one.
 */
type HookLimit =
  | { timeoutMs?: number; beforeRun?: undefined }
  | {
      timeoutMs: number;
      /**
       * Called with the shell's pid, which is also its process group's, before the command runs. The command runs once
       * it returns, and never when it throws or this process dies first.
       */
      beforeRun: (pid: number) => void;
    };

type HookOptions = HookPlace & HookLimit;

function endGroupOf(child: ChildProcess): void {
  if (child.pid === undefined || !killGroup(child.pid)) child.kill('SIGKILL');
}

function runShell(command: string, out: number, options: HookOptions): Promise<CommandResult> {
  const started = Date.now();
  const { beforeRun, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', beforeRun ? `read -r _ || exit 125\n${command}` : command], {
      cwd: options.cwd,
      env: options.env,
      stdio: [beforeRun ? 'pipe' : 'ignore', out, out],
      detached: timeoutMs !== undefined,
    });
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            endGroupOf(child);
          }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - started, ...(timedOut ? { timedOut } : {}) });
    });
    if (!beforeRun || child.pid === undefined) return;
    child.stdin?.on('error', () => undefined);
    try {
      beforeRun(child.pid);
    } catch (error) {
      clearTimeout(timer);
      endGroupOf(child);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.stdin?.end('\n');
  });
}

export async function runHook(hook: string, command: string, options: HookOptions): Promise<HookRun> {
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  fs.appendFileSync(options.log, `--- ${new Date().toISOString()} ${hook}: ${command}\n`);
  const fd = fs.openSync(options.log, 'a');
  let result: CommandResult;
  try {
    result = await runShell(command, fd, options);
  } finally {
    fs.closeSync(fd);
  }
  const run: HookRun = {
    hook,
    command,
    log: options.log,
    ...result,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  if (result.code !== 0) throw new HookFailed(run, tail(options.log));
  return run;
}

export interface CheckOutcome extends CommandResult {
  output: string;
}

export function runCheck(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /**
     * Runs it in a process group of its own, ended whole at the timeout, so a pipeline or a background process holding
     * its output can't keep it running past the timeout. A signal to this process's group, such as Ctrl-C, then misses it.
     */
    ownGroup?: boolean;
  },
): Promise<CheckOutcome> {
  const started = Date.now();
  const ownGroup = options.ownGroup === true;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: ownGroup,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      if (ownGroup) endGroupOf(child);
      else child.kill('SIGKILL');
    }, options.timeoutMs ?? 30_000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - started, output: Buffer.concat(chunks).toString('utf8').trim() });
    });
  });
}
