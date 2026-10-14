import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { killGroup } from './exec.ts';

export interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export class ChildGone extends Error {
  override name = 'ChildGone';
}

export class CallTimeout extends Error {
  override name = 'CallTimeout';
}

export interface MaestroChildOptions {
  maestro: string;
  javaHome: string;
  /** The Android SDK root, when this Maestro drives an emulator. */
  androidSdk?: string | undefined;
  token: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
  logFd: number | 'ignore';
  log: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
}

export function textOf(result: ToolResult): string {
  return result.content
    .filter(item => item.type === 'text')
    .map(item => item.text ?? '')
    .join('\n');
}

export function imageOf(result: ToolResult): { data: string; mimeType: string } | undefined {
  const item = result.content.find(entry => entry.type === 'image' && entry.data);
  return item?.data === undefined ? undefined : { data: item.data, mimeType: item.mimeType ?? 'image/jpeg' };
}

export const RUNNER_TOKEN_ENV = 'MAESTRO_RUNNER_TOKEN';

/**
 * The environment Maestro runs in: JDK 17 first on PATH, the lane's runner token, and for a simulator an `adb` that
 * fails fast ahead of any real one; for an emulator, the SDK's own adb, emulator and avdmanager instead.
 */
export function maestroEnv(
  options: Pick<MaestroChildOptions, 'javaHome' | 'env' | 'token' | 'androidSdk'>,
  stubDir: string,
  tempDir: string,
) {
  const sdk = options.androidSdk;
  const head = sdk
    ? [
        path.join(options.javaHome, 'bin'),
        path.join(sdk, 'platform-tools'),
        path.join(sdk, 'emulator'),
        path.join(sdk, 'cmdline-tools', 'latest', 'bin'),
      ]
    : [stubDir, path.join(options.javaHome, 'bin')];
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    JAVA_HOME: options.javaHome,
    PATH: [...head, options.env.PATH ?? '/usr/bin:/bin'].join(path.delimiter),
    MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_DISABLE_UPDATE_CHECK: 'true',
    [RUNNER_TOKEN_ENV]: options.token,
    ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}),
  };
  env.MAESTRO_OPTS = [options.env.MAESTRO_OPTS, `-Djava.io.tmpdir=${tempDir}`].filter(Boolean).join(' ');
  return env;
}

// Maestro lists adb devices during device discovery even when it drives iOS, and a hung adb stalls the session:
// https://github.com/mobile-dev-inc/Maestro/issues/3635
function writeAdbStub(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `adb.${String(process.pid)}.tmp`);
  fs.writeFileSync(temp, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.renameSync(temp, path.join(dir, 'adb'));
}

/** One `maestro mcp --no-viewer` process, spoken to over stdio JSON-RPC, in its own process group. */
export class MaestroChild {
  readonly process: ChildProcess;
  private readonly stdin: Writable;
  readonly exited: Promise<string>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private gone: string | undefined;
  private readonly tempDir: string;

  private constructor(options: MaestroChildOptions) {
    fs.mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
    const stubDir = path.join(options.workDir, 'bin');
    if (!options.androidSdk) writeAdbStub(stubDir);
    this.tempDir = fs.mkdtempSync(path.join(options.workDir, `tmp-${String(process.pid)}-`));
    const args = ['mcp', '--no-viewer', '--working-dir', options.workDir];
    this.process = spawn(options.maestro, args, {
      cwd: options.workDir,
      env: maestroEnv(options, stubDir, this.tempDir),
      stdio: ['pipe', 'pipe', options.logFd],
      detached: true,
    });
    const { stdin, stdout } = this.process;
    if (!stdin || !stdout) throw new Error('spawn gave Maestro no stdin or stdout pipe');
    this.stdin = stdin;
    options.log(`maestro ${String(this.process.pid)}: ${options.maestro} ${args.join(' ')}`);
    stdin.on('error', () => undefined);
    createInterface({ input: stdout }).on('line', line => {
      this.onLine(line, options.log);
    });
    this.exited = new Promise(resolve => {
      const finish = (why: string) => {
        if (this.gone !== undefined) return;
        this.gone = why;
        options.log(`maestro ${String(this.process.pid)} ${why}`);
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new ChildGone(`Maestro ${why}`));
        }
        this.pending.clear();
        killGroup(this.process.pid);
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        resolve(why);
      };
      this.process.on('exit', (code, signal) => {
        finish(`exited (${signal ?? `code ${String(code)}`})`);
      });
      this.process.on('error', error => {
        finish(`failed to start: ${error.message}`);
      });
    });
  }

  static async start(options: MaestroChildOptions, timeoutMs = 60_000): Promise<MaestroChild> {
    const child = new MaestroChild(options);
    try {
      await child.request(
        'initialize',
        { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentlane-driver', version: '1' } },
        timeoutMs,
      );
      child.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return child;
    } catch (error) {
      await child.kill();
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get alive(): boolean {
    return this.gone === undefined;
  }

  private onLine(line: string, log: (line: string) => void): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      log(`maestro stdout: ${line.slice(0, 500)}`);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      this.write(
        message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported' } },
      );
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }

  private write(message: object): void {
    if (this.gone === undefined) this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: object, timeoutMs: number): Promise<unknown> {
    if (this.gone !== undefined) return Promise.reject(new ChildGone(`Maestro ${this.gone}`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CallTimeout(`Maestro didn't answer ${method} within ${String(Math.round(timeoutMs / 1000))} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async callTool(name: string, args: object, timeoutMs: number): Promise<ToolResult> {
    const result = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as Partial<ToolResult> | undefined;
    return { content: Array.isArray(result?.content) ? result.content : [], isError: result?.isError === true };
  }

  /** Closes stdin so Maestro shuts its sessions down (runner, xcodebuild, port); kills the group if it takes too long. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.gone !== undefined) return;
    this.stdin.end();
    const timer = setTimeout(() => {
      killGroup(this.process.pid);
    }, graceMs);
    await this.exited;
    clearTimeout(timer);
  }

  async kill(): Promise<void> {
    if (this.gone !== undefined) return;
    killGroup(this.process.pid);
    await this.exited;
  }
}
