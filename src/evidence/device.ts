import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Clock } from '../clock.ts';
import { DriverError } from '../driver/errors.ts';
import { isAlive, runCommand, tail, type Ran } from '../driver/exec.ts';
import { TOOL } from '../name.ts';
import type { InProgress } from './files.ts';

/** The commands device evidence runs, and the processes it starts and stops; tests replace it. */
export interface EvidenceSystem {
  run(command: string, args: readonly string[], timeoutMs: number): Promise<Ran>;
  /** Starts a command that outlives this process, its output going to `log`; returns its pid. */
  start(command: string, args: readonly string[], log: string): number | undefined;
  /** The command line a process runs, or undefined when it doesn't. */
  commandOf(pid: number): string | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export const realEvidenceSystem: EvidenceSystem = {
  run: (command, args, timeoutMs) => runCommand(command, args, { timeoutMs }),
  start(command, args, log) {
    const out = fs.openSync(log, 'a', 0o600);
    try {
      const child = spawn(command, [...args], { detached: true, stdio: ['ignore', out, out] });
      child.on('error', () => undefined);
      child.unref();
      return child.pid;
    } finally {
      fs.closeSync(out);
    }
  },
  commandOf(pid) {
    if (!isAlive(pid)) return undefined;
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      timeout: 10_000,
    });
    return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : undefined;
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  },
};

/** The lane's simulator or emulator, as device evidence needs it. */
export interface DeviceTarget {
  platform: 'ios' | 'android';
  /** The simulator's UDID or the emulator's serial. */
  device: string;
  /** adb, for an emulator. */
  adb?: string;
  /** The app `up` runs, whose log lines a simulator's log is narrowed to. */
  bundleId: string | null;
}

function failure(what: string, ran: Ran, fix: string): DriverError {
  const said = tail(`${ran.stdout}\n${ran.stderr}`.trim(), 6);
  return new DriverError(`${what} ${ran.error ?? `exited ${String(ran.code)}`}${said ? `:\n${said}` : ''}`, fix);
}

function adbOf(target: DeviceTarget): string {
  if (target.adb === undefined) throw new Error(`no adb for emulator ${target.device}`);
  return target.adb;
}

export function recordCommand(target: DeviceTarget, file: string, remote: string): { command: string; args: string[] } {
  return target.platform === 'ios'
    ? { command: 'xcrun', args: ['simctl', 'io', target.device, 'recordVideo', '--codec=h264', '--force', file] }
    : { command: adbOf(target), args: ['-s', target.device, 'shell', 'screenrecord', '--time-limit', '180', remote] };
}

/** Starts recording the device's screen into `file`; returns what its stop needs. */
export async function startDeviceVideo(
  system: EvidenceSystem,
  target: DeviceTarget,
  file: string,
  clock: Clock,
): Promise<InProgress> {
  const remote = `/sdcard/${TOOL}-${String(clock.now())}.mp4`;
  const { command, args } = recordCommand(target, file, remote);
  const log = `${file}.log`;
  const pid = system.start(command, args, log);
  const startedAt = clock.now();
  if (pid === undefined) throw new DriverError(`could not start ${command}`, 'check that Xcode or the Android SDK is installed');
  const until = startedAt + 5000;
  const started = () =>
    target.platform === 'android' || (fs.existsSync(log) && /Recording started/i.test(fs.readFileSync(log, 'utf8')));
  let running = system.commandOf(pid);
  while (running !== undefined && clock.now() < until && !started()) {
    await clock.sleep(200);
    running = system.commandOf(pid);
  }
  if (running === undefined) {
    const said = fs.existsSync(log) ? tail(fs.readFileSync(log, 'utf8'), 6) : '';
    throw new DriverError(
      `the screen recording stopped as it started${said ? `:\n${said}` : ''}`,
      target.platform === 'ios' ? 'check that the simulator is booted' : 'check that the emulator is booted',
    );
  }
  return {
    version: 1,
    target: 'device',
    startedAt,
    file,
    pid,
    command: running,
    platform: target.platform,
    device: target.device,
    ...(target.platform === 'android' ? { remote } : {}),
  };
}

function stillOurs(system: EvidenceSystem, recording: InProgress): boolean {
  if (recording.pid === undefined) return false;
  const now = system.commandOf(recording.pid);
  return now !== undefined && now === recording.command;
}

async function waitGone(system: EvidenceSystem, recording: InProgress, clock: Clock, ms: number): Promise<boolean> {
  const until = clock.now() + ms;
  while (stillOurs(system, recording)) {
    if (clock.now() >= until) return false;
    await clock.sleep(200);
  }
  return true;
}

/**
 * Stops a device recording so its file is complete: an interrupt, as the recorder takes it, then the file pulled off an
 * emulator. A recorder that ignores the interrupt is killed, and its file may not play.
 */
export async function stopDeviceVideo(
  system: EvidenceSystem,
  recording: InProgress,
  clock: Clock,
  adb?: string,
): Promise<{ file: string | null; problems: string[] }> {
  const problems: string[] = [];
  if (recording.platform === 'android' && recording.device !== undefined && adb !== undefined) {
    const ran = await system.run(adb, ['-s', recording.device, 'shell', 'pkill', '-INT', 'screenrecord'], 15_000);
    if (ran.code !== 0 && stillOurs(system, recording))
      problems.push(`adb could not interrupt screenrecord (exit ${String(ran.code)})`);
  } else if (stillOurs(system, recording) && recording.pid !== undefined) {
    system.signal(recording.pid, 'SIGINT');
  }
  if (!(await waitGone(system, recording, clock, 15_000)) && recording.pid !== undefined) {
    system.signal(recording.pid, 'SIGKILL');
    problems.push(`the recorder (pid ${String(recording.pid)}) ignored the interrupt and was killed; the video may not play`);
  }
  if (
    recording.platform === 'android' &&
    recording.remote !== undefined &&
    recording.device !== undefined &&
    adb !== undefined &&
    recording.file
  ) {
    await clock.sleep(1000);
    const pulled = await system.run(adb, ['-s', recording.device, 'pull', recording.remote, recording.file], 120_000);
    if (pulled.code !== 0) problems.push(failure(`adb pull ${recording.remote}`, pulled, '').message);
    await system.run(adb, ['-s', recording.device, 'shell', 'rm', '-f', recording.remote], 15_000);
  }
  const file =
    recording.file !== undefined && fs.existsSync(recording.file) && fs.statSync(recording.file).size > 0 ? recording.file : null;
  if (file === null) problems.push('the recording left no video');
  else fs.rmSync(`${file}.log`, { force: true });
  return { file, problems };
}

/** The simulator app's executable, whose name the simulator's log records its lines under. */
export async function appExecutable(system: EvidenceSystem, target: DeviceTarget): Promise<string | undefined> {
  if (target.platform !== 'ios' || target.bundleId === null) return undefined;
  const ran = await system.run('xcrun', ['simctl', 'appinfo', target.device, target.bundleId], 30_000);
  if (ran.code !== 0) return undefined;
  return /CFBundleExecutable\s*=\s*"?([^";\n]+)"?;/.exec(ran.stdout)?.[1]?.trim();
}

export function deviceLogCommand(
  target: DeviceTarget,
  sinceMs: number,
  now: number,
  executable: string | undefined,
): { command: string; args: string[] } {
  if (target.platform === 'ios') {
    const minutes = Math.max(1, Math.ceil(sinceMs / 60_000));
    return {
      command: 'xcrun',
      args: [
        'simctl',
        'spawn',
        target.device,
        'log',
        'show',
        '--style',
        'compact',
        '--last',
        `${String(minutes)}m`,
        ...(executable === undefined ? [] : ['--predicate', `process == ${JSON.stringify(executable)}`]),
      ],
    };
  }
  const since = ((now - sinceMs) / 1000).toFixed(3);
  return { command: adbOf(target), args: ['-s', target.device, 'logcat', '-d', '-v', 'threadtime', '-t', since] };
}

/** The device's log over the last `sinceMs`, narrowed to the app on a simulator when the app is known. */
export async function writeDeviceLog(
  system: EvidenceSystem,
  target: DeviceTarget,
  sinceMs: number,
  file: string,
  clock: Clock,
): Promise<string> {
  const executable = await appExecutable(system, target);
  const { command, args } = deviceLogCommand(target, sinceMs, clock.now(), executable);
  const ran = await system.run(command, args, 120_000);
  if (ran.code !== 0) {
    throw failure(
      `${command} ${args.slice(0, 4).join(' ')}`,
      ran,
      `check that the ${target.platform === 'ios' ? 'simulator' : 'emulator'} is booted`,
    );
  }
  fs.writeFileSync(file, ran.stdout, { mode: 0o600 });
  return executable === undefined ? 'the whole device' : `the app's process ${executable}`;
}
