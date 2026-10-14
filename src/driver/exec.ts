import { spawn } from 'node:child_process';

export interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string | undefined;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
}

/** Runs a command to completion, collecting its output; never throws. A timeout kills the command's process group. */
export function runCommand(command: string, args: readonly string[], options: RunOptions = {}): Promise<Ran> {
  return new Promise(resolve => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let error: string | undefined;
    const child = spawn(command, [...args], {
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            error = `timed out after ${String(Math.round((options.timeoutMs ?? 0) / 1000))} s`;
            killGroup(child.pid);
          }, options.timeoutMs);
    child.on('error', failure => {
      error = failure.message;
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error,
      });
    });
  });
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function tail(text: string, lines = 15): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
