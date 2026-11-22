import type { Platform } from '../devices/backend.ts';
import { isAlive, killGroup } from './exec.ts';
import {
  CallTimeout,
  ChildGone,
  INITIALIZE_TIMEOUT_MS,
  MaestroChild,
  RUNNER_STARTUP_MS,
  textOf,
  type MaestroChildOptions,
  type ToolResult,
} from './maestro-child.ts';
import { listeningPorts, processRows, runnersOn, type ProcessRow } from './runner.ts';

export type SessionFailureKind = 'session-died' | 'timeout' | 'start-failed' | 'unreachable';

/** A Maestro session that failed again after one restart, or a call that can't safely be retried. */
export class SessionFailure extends Error {
  override name = 'SessionFailure';
  readonly kind: SessionFailureKind;
  readonly attempts: string[];
  /** What the caller can do next, when the failure has a known way forward. */
  readonly advice: string | undefined;

  constructor(kind: SessionFailureKind, attempts: string[], advice?: string) {
    super(attempts.join('; then '));
    this.kind = kind;
    this.attempts = attempts;
    this.advice = advice;
  }

  /** The attempts, then the advice when there is any. */
  get detail(): string {
    return this.advice === undefined ? this.message : `${this.message}. ${this.advice}`;
  }
}

export interface SupervisorOptions extends Omit<MaestroChildOptions, 'log'> {
  platform: Platform;
  /** The id Maestro knows the device by: a simulator's UDID, or an emulator's adb serial. */
  deviceId: string;
  log: (line: string) => void;
  /** Runs when Maestro exits without being asked to, and after a clean stop: the device side of a crash cleanup. */
  cleanup?: () => Promise<void>;
  pauseMs?: number;
  runnerWatchMs?: number;
  rows?: () => Promise<ProcessRow[]>;
  timeouts?: Partial<Record<string, number>>;
  /** What the first call on a fresh Maestro gets on top of its tool's limit on iOS, for the XCTest runner to start. */
  runnerStartupMs?: number;
}

export interface CallOptions {
  /**
   * Whether the call may be sent again on a fresh Maestro (reads and screenshots; never a flow): after Maestro died
   * under it, lost the device, or, on iOS, timed out on the first call that waited for the XCTest runner.
   */
  retry: boolean;
}

export interface SupervisorStatus {
  maestroPid: number | undefined;
  runnerPid: number | undefined;
  runnerPorts: number[];
  starts: number;
  restarts: string[];
}

const DEFAULT_TIMEOUTS: Record<string, number> = { inspect_screen: 60_000, take_screenshot: 60_000, run: 600_000 };

/** How long a call to a Maestro that has already answered one may take. */
export function warmCallMs(name: string): number {
  return DEFAULT_TIMEOUTS[name] ?? 60_000;
}

/**
 * The longest an iOS call can take before it answers or fails: Maestro's start and a first call that waits for the
 * XCTest runner, twice when a timed-out call is retried on a fresh Maestro.
 */
export function longestIosCallMs(name: string, options: CallOptions): number {
  const once = INITIALIZE_TIMEOUT_MS + warmCallMs(name) + RUNNER_STARTUP_MS;
  return options.retry ? 2 * once : once;
}

// Maestro reports a device it lost this way, and a fresh session reaches it again.
const UNREACHABLE = /Device became unreachable/i;
// Maestro's LocalXCTestInstaller.start() throws this, with advice to raise MAESTRO_DRIVER_STARTUP_TIMEOUT, when the
// runner hasn't answered within that time.
const RUNNER_NOT_READY = /iOS driver not ready in time/i;
const MAESTRO_STARTUP_ADVICE = /,?\s*consider increasing timeout by configuring MAESTRO_DRIVER_STARTUP_TIMEOUT env variable/i;
const RUNNER_NOT_READY_ADVICE = 'The next call starts a fresh Maestro and XCTest runner';

function runnerNotReady(text: string): string {
  return `${text.replace(MAESTRO_STARTUP_ADVICE, '')} (the XCTest runner didn't answer within ${String(RUNNER_STARTUP_MS / 1000)} s)`;
}
// Maestro's MCP server says this when it opens a session for a device adb doesn't list at that moment. An emulator's
// adb transport drops now and then; the next call rebuilds the session (patch 0002) and reinstalls the driver.
const NOT_CONNECTED = /Device with id \S+ is not connected/i;

/**
 * Keeps one warm `maestro mcp` session for one simulator. A session that dies is restarted once and the call retried
 * when that is safe; a second failure surfaces as a SessionFailure. When the XCTest runner dies, the whole Maestro
 * process group goes with it, so its xcodebuild can't relaunch a runner later, and the next call starts fresh.
 */
export class Supervisor {
  private readonly options: SupervisorOptions;
  private starting: Promise<MaestroChild> | undefined;
  private current: MaestroChild | undefined;
  private answered: MaestroChild | undefined;
  private runnerPid: number | undefined;
  private startedAt: number | undefined;
  private readonly watch: NodeJS.Timeout;
  private stopping = false;
  private lost: string | undefined;
  starts = 0;
  readonly restarts: string[] = [];

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.watch = setInterval(() => {
      this.checkRunner();
    }, options.runnerWatchMs ?? 500);
    this.watch.unref();
  }

  private log(line: string): void {
    this.options.log(line);
  }

  private cleanUp(why: string): void {
    const cleanup = this.options.cleanup;
    if (!cleanup) return;
    cleanup().catch((error: unknown) => {
      this.log(`device cleanup after ${why} failed: ${(error as Error).message}`);
    });
  }

  private checkRunner(): void {
    const pid = this.runnerPid;
    if (pid === undefined || isAlive(pid)) return;
    this.drop(`its XCTest runner (pid ${String(pid)}) is gone`);
  }

  private drop(reason: string): void {
    const child = this.current;
    this.runnerPid = undefined;
    if (!child) return;
    this.log(`dropping maestro ${String(child.pid)}: ${reason}`);
    this.lost = reason;
    this.current = undefined;
    this.starting = undefined;
    void child.kill();
  }

  ensure(): Promise<MaestroChild> {
    if (this.stopping) return Promise.reject(new SessionFailure('start-failed', ['the driver is stopping']));
    if (this.current?.alive) return Promise.resolve(this.current);
    if (!this.starting) {
      this.starts += 1;
      const began = Date.now();
      this.startedAt = began;
      const starting = MaestroChild.start({
        ...this.options,
        log: line => {
          this.log(line);
        },
      });
      this.starting = starting;
      starting.then(
        child => {
          if (this.starting !== starting) {
            void child.kill();
            return;
          }
          this.current = child;
          this.log(`maestro ${String(child.pid)} answered initialize in ${String(Date.now() - began)} ms`);
          void child.exited.then(why => {
            if (this.current === child) {
              this.current = undefined;
              this.runnerPid = undefined;
              if (!this.stopping) {
                this.lost ??= `Maestro ${why}`;
                this.cleanUp(`Maestro ${why}`);
              }
            }
            if (this.starting === starting) this.starting = undefined;
          });
        },
        () => {
          if (this.starting === starting) this.starting = undefined;
        },
      );
    }
    return this.starting;
  }

  private async restart(reason: string): Promise<void> {
    this.log(`restarting maestro: ${reason}`);
    this.restarts.push(reason);
    const old = this.current;
    this.current = undefined;
    this.starting = undefined;
    this.runnerPid = undefined;
    if (old) await old.kill();
  }

  private async adoptRunner(): Promise<void> {
    if (this.options.platform !== 'ios' || this.runnerPid !== undefined) return;
    const rows = await (this.options.rows ?? processRows)();
    const runners = runnersOn(rows, this.options.deviceId);
    const newest = runners.reduce<ProcessRow | undefined>((best, row) => (best && best.pid > row.pid ? best : row), undefined);
    if (newest) {
      this.runnerPid = newest.pid;
      this.log(`watching the XCTest runner, pid ${String(newest.pid)}`);
    }
  }

  /**
   * Calls a Maestro tool on this simulator. Returns `respawned` when the session had to be rebuilt first, so the
   * caller can say so: a rebuilt session lost whatever the old runner held.
   */
  async call(name: string, args: object, options: CallOptions): Promise<{ result: ToolResult; respawned: boolean }> {
    const attempts: string[] = [];
    let respawned = this.lost !== undefined;
    if (this.lost !== undefined) attempts.push(this.lost);
    this.lost = undefined;
    const limitMs = this.options.timeouts?.[name] ?? warmCallMs(name);
    for (let attempt = 0; attempt < 2; attempt++) {
      let child: MaestroChild;
      try {
        child = await this.ensure();
      } catch (error) {
        attempts.push(`Maestro didn't start: ${(error as Error).message}`);
        if (attempt === 0 && !this.stopping) {
          respawned = true;
          continue;
        }
        throw new SessionFailure('start-failed', attempts);
      }
      const waitsForRunner = this.options.platform === 'ios' && child !== this.answered;
      const timeoutMs = waitsForRunner ? limitMs + (this.options.runnerStartupMs ?? RUNNER_STARTUP_MS) : limitMs;
      let result: ToolResult;
      try {
        result = await child.callTool(name, { ...args, device_id: this.options.deviceId }, timeoutMs);
      } catch (error) {
        if (error instanceof CallTimeout) {
          attempts.push(error.message);
          await this.restart(error.message);
          if (waitsForRunner && options.retry && attempt === 0 && !this.stopping) {
            respawned = true;
            continue;
          }
          throw new SessionFailure('timeout', attempts);
        }
        if (error instanceof ChildGone) {
          attempts.push(`${error.message} during ${name}`);
          await this.restart(error.message);
          if (options.retry && attempt === 0 && !this.stopping) {
            respawned = true;
            continue;
          }
          throw new SessionFailure('session-died', attempts);
        }
        throw error;
      }
      if (result.isError && waitsForRunner && RUNNER_NOT_READY.test(textOf(result))) {
        attempts.push(runnerNotReady(textOf(result)));
        await this.restart(textOf(result));
        if (options.retry && attempt === 0 && !this.stopping) {
          respawned = true;
          continue;
        }
        throw new SessionFailure('timeout', attempts, RUNNER_NOT_READY_ADVICE);
      }
      if (result.isError && NOT_CONNECTED.test(textOf(result))) {
        attempts.push(textOf(result));
        this.log(`${name}: ${textOf(result)}`);
        if (options.retry && attempt === 0 && !this.stopping) {
          await new Promise(resolve => setTimeout(resolve, this.options.pauseMs ?? 500));
          respawned = true;
          continue;
        }
        throw new SessionFailure('unreachable', attempts);
      }
      if (result.isError && UNREACHABLE.test(textOf(result))) {
        attempts.push(textOf(result));
        await this.restart(textOf(result));
        if (options.retry && attempt === 0 && !this.stopping) {
          respawned = true;
          continue;
        }
        throw new SessionFailure('unreachable', attempts);
      }
      if (this.startedAt !== undefined) {
        this.log(`first ${name} on this Maestro answered ${String(Date.now() - this.startedAt)} ms after it was spawned`);
        this.startedAt = undefined;
      }
      await this.adoptRunner();
      if (!result.isError || this.runnerPid !== undefined) this.answered = child;
      return { result, respawned };
    }
    throw new SessionFailure('session-died', attempts);
  }

  async status(): Promise<SupervisorStatus> {
    return {
      maestroPid: this.current?.pid,
      runnerPid: this.runnerPid,
      runnerPorts: this.runnerPid === undefined ? [] : await listeningPorts(this.runnerPid),
      starts: this.starts,
      restarts: [...this.restarts],
    };
  }

  /**
   * Stops Maestro (which stops its runner and xcodebuild, or on Android uninstalls its driver), then kills whatever of
   * that is left. `clean: false` kills Maestro without its own shutdown and leaves the device alone: for a device the
   * lane no longer holds, where that shutdown would uninstall the driver from under its new holder.
   */
  async stop(options: { clean?: boolean } = {}): Promise<void> {
    const clean = options.clean !== false;
    this.stopping = true;
    clearInterval(this.watch);
    const runner = this.runnerPid;
    const pending = this.starting;
    const child = this.current ?? (pending ? await pending.catch(() => undefined) : undefined);
    if (child) {
      const pid = child.pid;
      if (clean) await child.stop();
      else await child.kill();
      killGroup(pid);
    }
    if (clean && this.options.platform === 'android' && this.options.cleanup) {
      await this.options.cleanup().catch((error: unknown) => {
        this.log(`device cleanup after the stop failed: ${(error as Error).message}`);
      });
    }
    if (runner !== undefined && isAlive(runner)) {
      this.log(`stopping the XCTest runner, pid ${String(runner)}`);
      killGroup(runner, 'SIGTERM');
      for (let waited = 0; waited < 2000 && isAlive(runner); waited += 100)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (isAlive(runner)) killGroup(runner);
    }
  }
}
