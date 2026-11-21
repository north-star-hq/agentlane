import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  out: number,
  timeoutMs: number | undefined,
  beforeRun: ((pid: number) => void) | undefined,
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', beforeRun ? `read -r _ || exit 125\n${command}` : command], {
      cwd,
      env,
      stdio: [beforeRun ? 'pipe' : 'ignore', out, out],
      detached: timeoutMs !== undefined,
    });
    let timedOut = false;
    const killAll = () => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killAll();
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
      killAll();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.stdin?.end('\n');
  });
}

export async function runHook(
  hook: string,
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    log: string;
    timeoutMs?: number;
    /**
     * Called with the shell's pid before the command runs. The command runs once it returns, and never when it throws
     * or this process dies first. With a timeout, the shell leads a process group of its own.
     */
    beforeRun?: (pid: number) => void;
  },
): Promise<HookRun> {
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  fs.appendFileSync(options.log, `--- ${new Date().toISOString()} ${hook}: ${command}\n`);
  const fd = fs.openSync(options.log, 'a');
  let result: CommandResult;
  try {
    result = await runShell(command, options.cwd, options.env, fd, options.timeoutMs, options.beforeRun);
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
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CheckOutcome> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
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
