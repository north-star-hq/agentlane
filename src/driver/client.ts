import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CLI } from '../name.ts';
import { identityOf, systemProcesses, type ProcessIdentity, type ProcessTable } from '../processes.ts';
import { NotClaimed } from '../registry/refusal.ts';
import type { Lane } from '../registry/types.ts';
import type { EngineConfig, EngineRequest, EngineResponse } from './engine.ts';
import { DriverError } from './errors.ts';
import { isAlive, tail } from './exec.ts';
import { describeIdle, readDriverSettings, takeIdleStop, type IdleStop } from './idle.ts';
import { ensureMaestro, findJdk17, MAESTRO_OVERRIDE_ENV } from './install.ts';
import { liveHolder, lockHolder, tryLock } from './lock.ts';
import { enginePaths, ensurePrivateDir, type EnginePaths } from './paths.ts';

export const ENGINE_MAIN = path.join(import.meta.dirname, `engine-main${path.extname(import.meta.filename)}`);

export interface Toolchain {
  maestro: string;
  javaHome: string;
}

export interface EngineTarget {
  stateDir: string;
  lane: Lane;
  env: NodeJS.ProcessEnv;
  /** Progress lines for a slow first start (the first-use Maestro download). */
  progress?: (line: string) => void;
  /** Skips the install and JDK lookup; for tests. */
  toolchain?: Toolchain;
  /** Engine timings; for tests. `idleMs` overrides the Mac's driver.json. */
  tuning?: Pick<EngineConfig, 'lanePollMs' | 'ownerPollMs' | 'touchEveryMs' | 'runnerWatchMs' | 'idleSampleMs' | 'idleMs'>;
  /** For judging whether a release in progress still runs; the system's process table when absent. */
  processes?: ProcessTable;
}

const START_TIMEOUT_MS = 20_000;
const STOP_WAIT_MS = 35_000;
const RESPONSE_TIMEOUT_MS: Record<EngineRequest['op'], number> = {
  ping: 10_000,
  status: 30_000,
  stop: 30_000,
  look: 150_000,
  screenshot: 150_000,
  run: 900_000,
  record: 30_000,
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function logTail(file: string): string {
  try {
    return tail(fs.readFileSync(file, 'utf8'), 15);
  } catch {
    return '(no log)';
  }
}

function answerIn(buffer: string): EngineResponse | undefined {
  const end = buffer.indexOf('\n');
  if (end < 0) return undefined;
  try {
    return JSON.parse(buffer.slice(0, end)) as EngineResponse;
  } catch {
    return undefined;
  }
}

/**
 * Sends one request; resolves undefined when no engine took it: nothing listens on the socket, or the connection broke
 * before any answer with a reset (Linux resets a connection whose peer closes with the request unread) or a broken
 * pipe (the request could not be written at all). An answer received in full stands, whatever the connection does next.
 */
function send(paths: EnginePaths, request: EngineRequest, timeoutMs: number): Promise<EngineResponse | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(paths.socket);
    let buffer = '';
    let connected = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new DriverError(
          `the driver didn't answer ${request.op} within ${String(Math.round(timeoutMs / 1000))} s`,
          `read its log, ${paths.log}; '${CLI} driver stop' restarts it on the next call`,
        ),
      );
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const answer = answerIn(buffer);
      if (answer) resolve(answer);
      else if (!connected || (buffer === '' && (error.code === 'ECONNRESET' || error.code === 'EPIPE'))) resolve(undefined);
      else reject(new DriverError(`lost the driver mid-call (${error.message})`, `read its log, ${paths.log}`));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!connected) return;
      const answer = answerIn(`${buffer}\n`);
      if (answer) resolve(answer);
      else
        reject(
          new DriverError(
            `the driver closed without answering ${request.op}`,
            `read its log, ${paths.log}:\n${logTail(paths.log)}`,
          ),
        );
    });
  });
}

async function resolveToolchain(target: EngineTarget): Promise<Toolchain> {
  if (target.toolchain) return target.toolchain;
  const jdk = await findJdk17(target.env);
  const override = target.env[MAESTRO_OVERRIDE_ENV];
  if (override) return { maestro: override, javaHome: jdk.javaHome };
  const installed = await ensureMaestro({ env: target.env, ...(target.progress ? { log: target.progress } : {}) });
  return { maestro: installed.binary, javaHome: jdk.javaHome };
}

function refOf(lane: Lane): { id: string; token: string } {
  return { id: lane.id, token: lane.token };
}

async function startEngine(target: EngineTarget, paths: EnginePaths): Promise<void> {
  const device = target.lane.device;
  if (!device) throw new DriverError(`lane ${target.lane.id} holds no device`, `${CLI} release, then ${CLI} claim --boot`);
  if (device.platform === 'android' && device.serial === null) {
    throw new DriverError(
      `lane ${target.lane.id}'s emulator ${device.name} has no adb serial, so it isn't running`,
      `${CLI} release, then ${CLI} claim --platform android`,
    );
  }
  const toolchain = await resolveToolchain(target);
  const { idleMs } = readDriverSettings(target.stateDir);
  const config: EngineConfig = {
    laneId: target.lane.id,
    token: target.lane.token,
    platform: device.platform,
    deviceId: device.id,
    serial: device.platform === 'android' ? device.serial : null,
    owner: target.lane.owner,
    worktree: target.lane.worktree,
    stateDir: target.stateDir,
    maestro: toolchain.maestro,
    javaHome: toolchain.javaHome,
    env: target.env,
    idleMs,
    ...target.tuning,
  };
  ensurePrivateDir(paths.dir);
  const spawnEngine = (): (() => string | undefined) => {
    const out = fs.openSync(paths.log, 'a', 0o600);
    let exit: string | undefined;
    try {
      const engine = spawn(process.execPath, [ENGINE_MAIN], {
        cwd: paths.dir,
        env: target.env,
        detached: true,
        stdio: ['pipe', out, out],
      });
      engine.on('error', error => {
        exit = error.message;
      });
      engine.on('exit', (code, signal) => {
        exit = signal ?? `code ${String(code)}`;
      });
      engine.stdin?.on('error', () => undefined);
      engine.stdin?.end(JSON.stringify(config));
      engine.unref();
    } finally {
      fs.closeSync(out);
    }
    return () => exit;
  };
  let exited = spawnEngine();
  let waitedOnHolder = false;
  let respawned = false;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const answer = await send(paths, { op: 'ping', lane: refOf(target.lane) }, 5000).catch(() => undefined);
    if (answer && answer.stopping === undefined) return;
    const exit = exited();
    if (exit !== undefined) {
      const holder = lockHolder(paths.lock);
      if (holder && holder.pid !== process.pid && isAlive(holder.pid)) {
        waitedOnHolder = true;
        await sleep(50);
        continue;
      }
      if (waitedOnHolder && !respawned) {
        respawned = true;
        exited = spawnEngine();
        continue;
      }
      throw new DriverError(
        `the driver for lane ${target.lane.id} exited while starting (${exit})`,
        `read its log, ${paths.log}:\n${logTail(paths.log)}`,
      );
    }
    await sleep(25);
  }
  throw new DriverError(
    `the driver for lane ${target.lane.id} didn't open ${paths.socket} within ${String(START_TIMEOUT_MS / 1000)} s`,
    `read its log, ${paths.log}`,
  );
}

export type ToolRequest = Exclude<EngineRequest, { op: 'ping' | 'status' | 'stop' }>;

function refuseWhileReleasing(target: EngineTarget, paths: EnginePaths): void {
  const releaser = liveHolder(paths.releasing, target.processes ?? systemProcesses);
  if (!releaser) return;
  throw new NotClaimed(
    `lane ${target.lane.id} in ${target.lane.worktree} has ended: it is being released (by pid ${String(releaser.pid)})`,
    `${CLI} claim --boot   (run in ${target.lane.worktree}; it claims a simulator for this session), then call again`,
  );
}

async function untilUnlocked(paths: EnginePaths, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const holder = lockHolder(paths.lock);
    if (!holder || !isAlive(holder.pid)) return;
    await sleep(50);
  }
}

function coldStartNote(ms: number, idleStop: IdleStop): string {
  return `The driver had stopped after ${describeIdle(idleStop.idleMs)} without a call; this call started it again (${(ms / 1000).toFixed(1)} s).`;
}

/** Sends a tool call to the lane's engine, starting the engine (and installing Maestro) first if none is running. */
export async function callEngine(
  target: EngineTarget,
  request: Omit<ToolRequest, 'lane'> | { op: 'status' },
): Promise<EngineResponse> {
  const paths = enginePaths(target.stateDir, target.lane.id);
  const full = { ...request, lane: refOf(target.lane) } as EngineRequest;
  for (let round = 0; round < 3; round++) {
    refuseWhileReleasing(target, paths);
    let response = await send(paths, full, RESPONSE_TIMEOUT_MS[full.op]);
    let coldStart: EngineResponse['coldStart'];
    if (!response) {
      const idleStop = takeIdleStop(paths.idle);
      const started = Date.now();
      try {
        await startEngine(target, paths);
      } catch (error) {
        refuseWhileReleasing(target, paths);
        throw error;
      }
      response = await send(paths, full, RESPONSE_TIMEOUT_MS[full.op]);
      if (response) {
        const ms = Date.now() - started;
        coldStart = { ms, ...(idleStop ? { idleStop: { stoppedAt: idleStop.stoppedAt, idleMs: idleStop.idleMs } } : {}) };
        if (idleStop && full.op !== 'status') response.text = [coldStartNote(ms, idleStop), response.text ?? ''].join('\n');
      }
    }
    if (response?.stopping !== undefined) {
      await untilUnlocked(paths, STOP_WAIT_MS);
      continue;
    }
    if (response) return coldStart ? { ...response, coldStart } : response;
  }
  refuseWhileReleasing(target, paths);
  throw new DriverError(`couldn't reach the driver for lane ${target.lane.id}`, `read its log, ${paths.log}`);
}

/** Starts the lane's engine if it isn't running and reads the screen once, so the next call is warm. */
export async function prewarmEngine(target: EngineTarget): Promise<EngineResponse> {
  const response = await callEngine(target, { op: 'look', args: { interactiveOnly: true } });
  if (!response.ok)
    throw new DriverError(
      `the driver's first read failed: ${response.error ?? response.text ?? ''}`,
      `read its log, ${enginePaths(target.stateDir, target.lane.id).log}`,
    );
  return response;
}

/** Asks a running engine about itself; undefined when none runs. */
export async function engineStatus(stateDir: string, lane: Lane): Promise<EngineResponse | undefined> {
  return send(enginePaths(stateDir, lane.id), { op: 'status', lane: refOf(lane) }, RESPONSE_TIMEOUT_MS.status);
}

function exited(engine: ProcessIdentity, processes: ProcessTable): boolean {
  if (!isAlive(engine.pid)) return true;
  const starts = processes.startTimes([engine.pid]);
  return starts !== undefined && starts.get(engine.pid) !== engine.start;
}

/** Stops a lane's engine and waits until its process has exited; false when none was running. */
export async function stopEngine(stateDir: string, lane: Lane, waitMs = 30_000): Promise<boolean> {
  const paths = enginePaths(stateDir, lane.id);
  const answer = await send(paths, { op: 'stop', lane: refOf(lane) }, RESPONSE_TIMEOUT_MS.stop).catch(() => undefined);
  if (!answer) return false;
  const engine = identityOf(systemProcesses, answer.pid);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const holder = lockHolder(paths.lock);
    if ((!holder || !isAlive(holder.pid)) && (!engine || exited(engine, systemProcesses))) return true;
    await sleep(100);
  }
  throw new DriverError(
    `the driver (pid ${String(answer.pid)}) didn't stop within ${String(waitMs / 1000)} s`,
    `read its log, ${paths.log}`,
  );
}

export interface StopForLane {
  processes: ProcessTable;
  waitMs?: number;
  /** The lane is ending: hold off new engines until this process exits, and forget what the engine learned. */
  ending?: boolean;
}

/**
 * Stops a lane's engine without its token, by signalling the process its lock names (pid and start time both
 * checked). With `ending`, it first marks the lane as being released, so no engine starts for it while this
 * process lives, and afterwards drops the lane's learned state. Resolves true when an engine was stopped, once its
 * process has exited.
 */
export async function stopLaneEngine(stateDir: string, laneId: string, options: StopForLane): Promise<boolean> {
  const paths = enginePaths(stateDir, laneId);
  if (!fs.existsSync(paths.dir)) return false;
  if (options.ending) {
    const me = identityOf(options.processes, process.pid);
    if (me) tryLock(paths.releasing, me, options.processes);
  }
  const deadline = Date.now() + (options.waitMs ?? 30_000);
  const signalled: ProcessIdentity[] = [];
  for (;;) {
    const holder = liveHolder(paths.lock, options.processes);
    const lingering = holder ?? signalled.find(engine => !exited(engine, options.processes));
    if (!lingering) break;
    if (holder && !signalled.some(engine => engine.pid === holder.pid && engine.start === holder.start)) {
      try {
        process.kill(holder.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      signalled.push(holder);
    }
    if (Date.now() > deadline) {
      throw new DriverError(
        `the driver of lane ${laneId} (pid ${String(lingering.pid)}) didn't stop within ${String(Math.round((options.waitMs ?? 30_000) / 1000))} s`,
        `read its log, ${paths.log}`,
      );
    }
    await sleep(100);
  }
  if (options.ending) forgetLaneState(paths);
  return signalled.length > 0;
}

/** Drops what the engines of an ended lane learned; the log and recorded steps stay until they are pruned. */
export function forgetLaneState(paths: EnginePaths): void {
  for (const file of [paths.volatile, paths.idle]) fs.rmSync(file, { force: true });
}
