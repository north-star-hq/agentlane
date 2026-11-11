import type { Clock } from '../clock.ts';
import { describeStart, startMs } from '../processes.ts';
import { stopDeviceVideo, type EvidenceSystem } from './device.ts';
import { clearInProgress, deviceRecordingMarked, readInProgress, writeInProgress, type InProgress } from './files.ts';

/** How long after a sweep left an ended lane's recorder running, unproven, the next sweep looks at it again. */
export const STRAY_RETRY_MS = 5 * 60_000;
/** How long before its marker's `startedAt` a recorder may have started: ps reports a start to the second, and spawn takes time. */
const RECORDER_START_MS = 2000;

export type StrayRecorder =
  | { kind: 'stopped'; lane: string; pid: number; file: string | null; problems: string[] }
  | { kind: 'exited'; lane: string; pid: number }
  | { kind: 'not-ours'; lane: string; pid: number; reason: string }
  | { kind: 'cant-tell'; lane: string; pid: number; reason: string }
  | { kind: 'survived'; lane: string; pid: number; problems: string[] };

type Recording = InProgress & { pid: number };

type Verdict = { kind: 'ours' } | { kind: 'gone' } | { kind: 'not-ours'; reason: string } | { kind: 'cant-tell'; reason: string };

function startedAround(start: string, startedAt: number): Verdict {
  const at = startMs(start);
  if (Number.isNaN(at)) return { kind: 'cant-tell', reason: `ps gave its start time as '${start}'` };
  if (at <= startedAt && at > startedAt - RECORDER_START_MS) return { kind: 'ours' };
  return {
    kind: 'not-ours',
    reason: `it started ${describeStart(start)}, not as the recording began at ${new Date(startedAt).toISOString()}`,
  };
}

/**
 * Whether the process at the recording's pid is its recorder: the command it ran, and the start time recorded with it
 * or, in a marker written before start times were, a start in the second the recording began.
 */
function judgeRecorder(system: EvidenceSystem, recording: Recording): Verdict {
  const starts = system.startTimes([recording.pid]);
  if (!starts) return { kind: 'cant-tell', reason: 'ps could not read when it started' };
  const start = starts.get(recording.pid);
  if (start === undefined) return { kind: 'gone' };
  const command = system.commandOf(recording.pid);
  if (command === undefined) return { kind: 'gone' };
  if (recording.command !== undefined && command !== recording.command)
    return { kind: 'not-ours', reason: `it runs ${command.slice(0, 80)}, not ${recording.command.slice(0, 80)}` };
  if (recording.start === undefined) return startedAround(start, recording.startedAt);
  if (start === recording.start) return { kind: 'ours' };
  return { kind: 'not-ours', reason: `it started ${describeStart(start)}, not ${describeStart(recording.start)}` };
}

function deviceRecording(evidence: string): Recording | null {
  const recording = readInProgress(evidence, 'video', 'device');
  return recording?.pid === undefined ? null : { ...recording, pid: recording.pid };
}

/** Whether the evidence folder of an ended lane marks a device recorder a sweep is to look at now. */
export function strayDue(evidence: string, now: number): boolean {
  if (!deviceRecordingMarked(evidence)) return false;
  const recording = deviceRecording(evidence);
  return recording !== null && (recording.leftAt === undefined || recording.leftAt <= now - STRAY_RETRY_MS);
}

/**
 * Stops the device recorder an ended lane left running, once its pid is proven to be that recorder, so its file is
 * complete. Signals only the recorder on this Mac, never the device, which another lane may hold now. A process the
 * pid names that is not the recorder is left running; one it can't tell about is left marked for a later sweep.
 */
export async function stopStrayRecorder(
  system: EvidenceSystem,
  evidence: string,
  lane: string,
  clock: Clock,
): Promise<StrayRecorder | null> {
  const recording = deviceRecording(evidence);
  if (!recording) return null;
  const { pid } = recording;
  const leave = () => {
    writeInProgress(evidence, 'video', { ...recording, leftAt: clock.now() });
  };
  const verdict = judgeRecorder(system, recording);
  if (verdict.kind === 'cant-tell') {
    leave();
    return { kind: 'cant-tell', lane, pid, reason: `${verdict.reason}, so it was sent nothing` };
  }
  if (verdict.kind !== 'ours') {
    clearInProgress(evidence, 'video', 'device');
    return verdict.kind === 'gone' ? { kind: 'exited', lane, pid } : { kind: 'not-ours', lane, pid, reason: verdict.reason };
  }
  const stopped = await stopDeviceVideo(system, recording, clock);
  const problems = [
    ...stopped.problems,
    ...(recording.platform === 'android' && recording.remote !== undefined
      ? [`the video stays at ${recording.remote} on emulator ${recording.device ?? '(unknown)'}, which may be another lane's now`]
      : []),
  ];
  const after = judgeRecorder(system, recording);
  if (after.kind === 'ours') {
    leave();
    return { kind: 'survived', lane, pid, problems };
  }
  if (after.kind === 'cant-tell') {
    leave();
    return { kind: 'cant-tell', lane, pid, reason: `it was sent SIGINT, but then ${after.reason}` };
  }
  clearInProgress(evidence, 'video', 'device');
  return { kind: 'stopped', lane, pid, file: stopped.file, problems };
}

export function describeStray(stray: StrayRecorder): string {
  const who = `the device recorder (pid ${String(stray.pid)}) lane ${stray.lane} left running`;
  switch (stray.kind) {
    case 'stopped':
      return stray.file ? `stopped ${who}; its video is ${stray.file}` : `stopped ${who}`;
    case 'exited':
      return `${who} had already exited`;
    case 'not-ours':
      return `left pid ${String(stray.pid)} alone: it is not ${who}, since ${stray.reason}`;
    case 'cant-tell':
      return `could not prove pid ${String(stray.pid)} is ${who}: ${stray.reason}; a later sweep looks again`;
    case 'survived':
      return `${who} is still running after SIGINT and SIGKILL`;
  }
}
