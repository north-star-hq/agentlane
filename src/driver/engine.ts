import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { adbPath, createAdbTools, forceStopMaestro, type AdbTools } from '../devices/adb.ts';
import type { Platform } from '../devices/backend.ts';
import { findAndroidSdk } from '../devices/emulator.ts';
import { identityOf, systemProcesses, type ProcessIdentity, type ProcessTable } from '../processes.ts';
import { isProven, judgeProcess, worktreeState, type Owner } from '../registry/owner.ts';
import { tcpProbe } from '../registry/ports.ts';
import { Refusal } from '../registry/refusal.ts';
import { Registry } from '../registry/registry.ts';
import { messageOf } from './errors.ts';
import { IdleWatch, writeIdleStop, describeIdle } from './idle.ts';
import { sipsImages, type ImageTools } from './images.ts';
import { liveHolder, tryLock, unlock } from './lock.ts';
import { enginePaths, ensurePrivateDir, type EnginePaths } from './paths.ts';
import type { ProcessRow } from './runner.ts';
import { DriverSession, type LookArgs, type OpResult, type RecordArgs, type RunArgs, type ScreenshotArgs } from './session.ts';
import { SessionFailure, Supervisor, type SupervisorStatus } from './supervisor.ts';

export interface EngineConfig {
  laneId: string;
  token: string;
  platform: Platform;
  /** The lane's device: a simulator's UDID, or an emulator's AVD name. */
  deviceId: string;
  /** An emulator's adb serial, which is also the id Maestro knows it by; null for a simulator. */
  serial: string | null;
  owner: Owner;
  worktree: string;
  stateDir: string;
  maestro: string;
  javaHome: string;
  env: NodeJS.ProcessEnv;
  lanePollMs?: number;
  ownerPollMs?: number;
  touchEveryMs?: number;
  /** How long the engine waits, idle, before one more read that teaches it which numbers tick on their own. */
  idleSampleMs?: number;
  runnerWatchMs?: number;
  /** How long without a tool call before the engine stops Maestro and exits, keeping the lane; 0 never. */
  idleMs?: number;
}

export interface LaneRef {
  id: string;
  token: string;
}

export type EngineRequest =
  | { op: 'ping'; lane: LaneRef }
  | { op: 'status'; lane: LaneRef }
  | { op: 'stop'; lane: LaneRef }
  | { op: 'look'; lane: LaneRef; args: LookArgs }
  | { op: 'screenshot'; lane: LaneRef; args: ScreenshotArgs }
  | { op: 'run'; lane: LaneRef; args: RunArgs }
  | { op: 'record'; lane: LaneRef; args: RecordArgs };

export interface EngineStatus extends SupervisorStatus {
  enginePid: number;
  device: string;
  laneId: string;
  startedAt: number;
  log: string;
}

export interface EngineResponse extends Partial<OpResult> {
  ok: boolean;
  pid: number;
  error?: string;
  /** Set when the engine was stopping and either didn't start the request or cut short a read: the caller may send it again. */
  stopping?: string;
  /** Set when the engine stopped partway through a request that can change the device, a run: the caller must not send it again. */
  interrupted?: string;
  /** Set by the client when it had to start the engine for this call. */
  coldStart?: { ms: number; idleStop?: { stoppedAt: number; idleMs: number } };
  sessionFailure?: { kind: string; attempts: string[] };
  status?: EngineStatus;
}

export interface EngineDeps {
  processes?: ProcessTable;
  images?: ImageTools;
  rows?: () => Promise<ProcessRow[]>;
  adb?: AdbTools;
}

const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

function canConnect(socket: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.connect(socket);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
}

const ANSWER_WAIT_MS = 2000;

function actsOnDevice(op: EngineRequest['op']): boolean {
  return op === 'look' || op === 'screenshot' || op === 'run';
}

function onlyReads(op: EngineRequest['op']): boolean {
  return op === 'ping' || op === 'status' || op === 'look' || op === 'screenshot';
}

const ACTIONS: Record<Exclude<EngineRequest['op'], 'stop'>, string> = {
  ping: 'driver ping',
  status: 'driver status',
  look: 'look',
  screenshot: 'screenshot',
  run: 'run',
  record: 'record',
};

/**
 * The long-lived driver engine of one lane. It owns the lane's `maestro mcp` session, answers tool calls on a Unix
 * socket one at a time, records activity on the lane, and stops (freeing Maestro, its xcodebuild and its runner)
 * when the lane ends or its owner is proven gone.
 */
export async function runEngine(config: EngineConfig, deps: EngineDeps = {}): Promise<string> {
  const processes = deps.processes ?? systemProcesses;
  const paths: EnginePaths = enginePaths(config.stateDir, config.laneId);
  ensurePrivateDir(paths.dir);
  ensurePrivateDir(path.dirname(paths.socket));
  const me: ProcessIdentity | undefined = identityOf(processes, process.pid);
  if (!me) return `ps could not read this engine's start time (pid ${String(process.pid)})`;
  if (!tryLock(paths.lock, me, processes).acquired) return 'another engine holds the lock';
  const releaser = liveHolder(paths.releasing, processes);
  if (releaser) {
    unlock(paths.lock, me);
    return `lane ${config.laneId} is being released (by pid ${String(releaser.pid)})`;
  }

  const logFd = fs.openSync(paths.log, 'a', 0o600);
  if (fs.fstatSync(logFd).size > LOG_LIMIT_BYTES) fs.ftruncateSync(logFd, 0);
  let logOpen = true;
  const log = (line: string) => {
    const entry = `${new Date().toISOString()} [engine ${String(process.pid)}] ${line}\n`;
    if (logOpen) fs.writeSync(logFd, entry);
    else process.stderr.write(entry);
  };
  const closeLog = () => {
    logOpen = false;
    fs.closeSync(logFd);
  };
  const device = config.serial ?? config.deviceId;
  log(`starting for lane ${config.laneId} on ${device} in ${config.worktree}`);

  const registry = Registry.open({ dir: config.stateDir, processes, ports: tcpProbe, devices: {}, lockWaitMs: 250 });
  const held = (): boolean => {
    const lane = registry.find(config.owner, config.worktree);
    return (
      lane?.id === config.laneId &&
      lane.token === config.token &&
      lane.device?.id === config.deviceId &&
      (lane.device.serial ?? null) === config.serial
    );
  };
  if (!held()) {
    registry.close();
    unlock(paths.lock, me);
    closeLog();
    return `lane ${config.laneId} is not held for ${device}`;
  }
  const androidSdk = config.platform === 'android' ? (findAndroidSdk(config.env)?.root ?? undefined) : undefined;
  const adb =
    config.platform === 'android' && config.serial !== null
      ? (deps.adb ?? createAdbTools(config.serial, { adb: adbPath(config.env) }))
      : undefined;
  const stillHeld = (): boolean => {
    try {
      return held();
    } catch (error) {
      log(`lane check failed: ${messageOf(error)}`);
      return false;
    }
  };
  const cleanup = async (): Promise<void> => {
    if (!adb || !stillHeld()) return;
    await forceStopMaestro(adb);
    log(`force-stopped Maestro's driver on ${adb.serial}`);
  };

  if (fs.existsSync(paths.socket)) {
    if (await canConnect(paths.socket)) {
      registry.close();
      unlock(paths.lock, me);
      closeLog();
      return 'an engine already answers on the socket';
    }
    fs.rmSync(paths.socket, { force: true });
  }

  const supervisor = new Supervisor({
    platform: config.platform,
    deviceId: device,
    androidSdk,
    cleanup,
    maestro: config.maestro,
    javaHome: config.javaHome,
    token: config.token,
    workDir: paths.work,
    env: config.env,
    logFd,
    log,
    ...(config.runnerWatchMs === undefined ? {} : { runnerWatchMs: config.runnerWatchMs }),
    ...(deps.rows ? { rows: deps.rows } : {}),
  });
  const session = new DriverSession(
    supervisor,
    deps.images ?? sipsImages(path.join(paths.work, 'images')),
    { steps: paths.steps, volatile: paths.volatile, work: paths.work, shots: paths.shots },
    log,
  );
  const idle = new IdleWatch(config.idleMs ?? 0, { now: () => Date.now() });
  const startedAt = Date.now();

  let stopping: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let pendingTouch: string | undefined;
  let lastTouch = 0;
  let resolveDone: (reason: string) => void = () => undefined;
  const done = new Promise<string>(resolve => {
    resolveDone = resolve;
  });
  const timers: NodeJS.Timeout[] = [];

  const flushTouch = () => {
    if (pendingTouch === undefined || stopping !== undefined) return;
    const action = pendingTouch;
    try {
      registry.touch({ id: config.laneId, token: config.token }, action);
      pendingTouch = undefined;
      lastTouch = Date.now();
    } catch (error) {
      if (error instanceof Refusal && error.code === 'registry-busy') return;
      if (!stillHeld()) endLane();
      else void shutdown(`the lane can't be touched: ${messageOf(error).split('\n')[0] ?? ''}`);
    }
  };

  const touchSoon = (action: string) => {
    pendingTouch = action;
    if (Date.now() - lastTouch >= (config.touchEveryMs ?? 5000)) setImmediate(flushTouch);
  };

  let laneEnded = false;
  const laneGone = (): EngineResponse => ({
    pid: process.pid,
    ok: false,
    error: `lane ${config.laneId} no longer holds ${device}, so the driver stopped without acting`,
  });
  const stoppingAnswer = (reason: string): EngineResponse => ({
    pid: process.pid,
    ok: false,
    error: `the driver is stopping (${reason})`,
    stopping: reason,
  });
  const endLane = () => {
    laneEnded = true;
    void shutdown(`lane ${config.laneId} has ended`);
  };
  const refusal = (request: EngineRequest, reason: string): EngineResponse =>
    laneEnded && actsOnDevice(request.op) ? laneGone() : stoppingAnswer(reason);
  const cutShort = (request: EngineRequest, reason: string): EngineResponse =>
    onlyReads(request.op)
      ? { pid: process.pid, ok: false, error: `the driver stopped during ${request.op} (${reason})`, stopping: reason }
      : {
          pid: process.pid,
          ok: false,
          error: `the driver stopped partway through ${request.op} (${reason}). Some of it may have run on the device, so it was not sent again; read the screen before you repeat it`,
          interrupted: reason,
        };

  const perform = async (request: Exclude<EngineRequest, { op: 'stop' }>): Promise<EngineResponse> => {
    const base = { pid: process.pid };
    if (actsOnDevice(request.op) && !stillHeld()) {
      endLane();
      return laneGone();
    }
    switch (request.op) {
      case 'ping':
        return { ...base, ok: true };
      case 'status':
        return {
          ...base,
          ok: true,
          status: {
            ...(await supervisor.status()),
            enginePid: process.pid,
            device,
            laneId: config.laneId,
            startedAt,
            log: paths.log,
          },
        };
      case 'look':
        return { ...base, ...(await session.look(request.args)) };
      case 'screenshot':
        return { ...base, ...(await session.screenshot(request.args)) };
      case 'run':
        return { ...base, ...(await session.run(request.args)) };
      case 'record':
        return { ...base, ...session.recording(request.args) };
    }
  };

  let sampleTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const scheduleIdleCheck = () => {
    clearTimeout(idleTimer);
    const remaining = idle.remainingMs();
    if (remaining === undefined || stopping !== undefined) return;
    idleTimer = setTimeout(() => {
      if (stopping !== undefined) return;
      if (idle.remainingMs() !== 0) {
        scheduleIdleCheck();
        return;
      }
      const idleMs = config.idleMs ?? 0;
      try {
        writeIdleStop(paths.idle, { version: 1, stoppedAt: Date.now(), idleMs });
      } catch (error) {
        log(`could not note the idle stop: ${messageOf(error)}`);
      }
      void shutdown(`no tool call for ${describeIdle(idleMs)}; the lane stays, and the next call starts the driver again`);
    }, remaining);
    idleTimer.unref();
  };
  const sampleWhenIdle = () => {
    clearTimeout(sampleTimer);
    sampleTimer = setTimeout(() => {
      if (stopping !== undefined) return;
      tail = tail
        .then(() => session.idleSample())
        .catch((error: unknown) => {
          log(`idle read failed: ${messageOf(error)}`);
        });
    }, config.idleSampleMs ?? 1500);
    sampleTimer.unref();
  };

  const isToolCall = (op: EngineRequest['op']) => op === 'look' || op === 'run' || op === 'screenshot' || op === 'record';

  const serialized = (request: Exclude<EngineRequest, { op: 'stop' }>): Promise<EngineResponse> => {
    clearTimeout(sampleTimer);
    const tool = isToolCall(request.op);
    if (tool) idle.begin();
    const job = tail.then(() => (stopping === undefined ? perform(request) : refusal(request, stopping)));
    tail = job.catch(() => undefined);
    return job
      .then(
        (response): EngineResponse => {
          touchSoon(ACTIONS[request.op]);
          if (request.op === 'look' || request.op === 'run' || request.op === 'screenshot') sampleWhenIdle();
          return response;
        },
        (error: unknown): EngineResponse => {
          log(`${request.op} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          if (stopping !== undefined) return cutShort(request, stopping);
          if (error instanceof SessionFailure) {
            return {
              pid: process.pid,
              ok: false,
              error: `Maestro's session failed (${error.kind}) and failed again after a restart: ${error.message}. The driver's log: ${paths.log}`,
              sessionFailure: { kind: error.kind, attempts: error.attempts },
            };
          }
          return { pid: process.pid, ok: false, error: messageOf(error) };
        },
      )
      .finally(() => {
        if (tool) {
          idle.end();
          scheduleIdleCheck();
        }
      });
  };

  const handle = (line: string): Promise<EngineResponse> => {
    let request: EngineRequest;
    try {
      request = JSON.parse(line) as EngineRequest;
    } catch {
      return Promise.resolve({ pid: process.pid, ok: false, error: 'the driver got a request that is not JSON' });
    }
    const ours = request.lane.id === config.laneId && request.lane.token === config.token;
    if (stopping !== undefined) return Promise.resolve(ours ? refusal(request, stopping) : stoppingAnswer(stopping));
    if (!ours) {
      return Promise.resolve({
        pid: process.pid,
        ok: false,
        error: `this driver serves lane ${config.laneId}, with its own token`,
      });
    }
    if (request.op === 'stop') {
      void shutdown('asked to stop');
      return Promise.resolve({ pid: process.pid, ok: true, text: 'Stopping the driver.' });
    }
    return serialized(request);
  };

  const drainMark = randomUUID();
  let markAccepted: () => void = () => undefined;
  const open = new Set<net.Socket>();
  const unread = new Set<net.Socket>();
  let allClosed: () => void = () => undefined;
  const server = net.createServer(socket => {
    open.add(socket);
    unread.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => {
      open.delete(socket);
      unread.delete(socket);
      if (open.size === 0) allClosed();
    });
    const lines = createInterface({ input: socket });
    lines.once('line', line => {
      lines.close();
      unread.delete(socket);
      if (line === drainMark) {
        socket.destroy();
        markAccepted();
        return;
      }
      void handle(line).then(response => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  });

  const removeOurs = (file: string): void => {
    try {
      if (fs.statSync(file).ino === socketIno) fs.rmSync(file);
    } catch {
      log(`${file} was already gone`);
    }
  };

  // A listener that closes drops the connections it has not accepted yet (Linux resets them, macOS ends them
  // unanswered), and libuv accepts one connection per loop turn. With the socket moved off its public path no new
  // connection arrives, and the kernel accepts in arrival order, so once a mark sent through the moved path is
  // accepted, so is every connection that was waiting before it.
  const acceptQueued = (): Promise<void> =>
    new Promise(resolve => {
      let finished = false;
      let moved = false;
      let mark: net.Socket | undefined;
      const unmove = () => {
        if (moved) removeOurs(paths.stoppingSocket);
        moved = false;
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        mark?.destroy();
        unmove();
        resolve();
      };
      const deadline = setTimeout(() => {
        log('connections queued on the socket were not all accepted in time');
        finish();
      }, ANSWER_WAIT_MS);
      markAccepted = finish;
      try {
        if (fs.statSync(paths.socket).ino !== socketIno) throw new Error('replaced');
        fs.renameSync(paths.socket, paths.stoppingSocket);
        moved = true;
      } catch {
        log('the socket was already gone');
        finish();
        return;
      }
      const sendMark = () => {
        const socket = net.connect(paths.stoppingSocket);
        mark = socket;
        socket.on('connect', () => {
          unmove();
          socket.write(`${drainMark}\n`);
        });
        socket.on('error', (error: NodeJS.ErrnoException) => {
          if (finished) return;
          if (error.code === 'EAGAIN' || error.code === 'ECONNREFUSED') setImmediate(sendMark);
          else finish();
        });
      };
      sendMark();
    });

  const connectionsClosed = (): Promise<void> =>
    new Promise(resolve => {
      const timer = setTimeout(resolve, ANSWER_WAIT_MS);
      allClosed = () => {
        clearTimeout(timer);
        resolve();
      };
      if (open.size === 0) allClosed();
    });

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping !== undefined) return;
    stopping = reason;
    const clean = config.platform !== 'android' || stillHeld();
    log(`stopping: ${reason}`);
    for (const timer of timers) clearInterval(timer);
    clearTimeout(sampleTimer);
    clearTimeout(idleTimer);
    const queued = acceptQueued();
    await Promise.race([tail, new Promise(resolve => setTimeout(resolve, 2000))]);
    await supervisor.stop({ clean });
    await queued;
    fs.rmSync(paths.work, { recursive: true, force: true });
    registry.close();
    unlock(paths.lock, me);
    await connectionsClosed();
    for (const socket of unread) socket.end(`${JSON.stringify(stoppingAnswer(reason))}\n`);
    log('stopped');
    closeLog();
    server.close();
    resolveDone(reason);
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => {
      resolve();
    });
  });
  fs.chmodSync(paths.socket, 0o600);
  const socketIno = fs.statSync(paths.socket).ino;
  log(`listening on ${paths.socket}`);

  timers.push(
    setInterval(() => {
      if (stopping !== undefined) return;
      try {
        if (!held()) endLane();
      } catch (error) {
        log(`lane check failed: ${messageOf(error)}`);
      }
      flushTouch();
    }, config.lanePollMs ?? 500),
    setInterval(() => {
      if (stopping !== undefined) return;
      const owner = config.owner.process;
      const verdict = owner ? judgeProcess(owner, processes.startTimes([owner.pid])) : 'cant-tell';
      if (isProven(verdict)) void shutdown(`the lane's owner (pid ${String(owner?.pid)}) is ${verdict}`);
      else if (worktreeState(config.worktree) === 'gone') void shutdown(`the lane's folder ${config.worktree} is gone`);
    }, config.ownerPollMs ?? 2000),
  );

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
  scheduleIdleCheck();
  supervisor.ensure().catch((error: unknown) => {
    log(`maestro did not start: ${messageOf(error)}`);
  });
  return done;
}
