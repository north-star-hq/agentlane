import { randomBytes } from 'node:crypto';
import { hasBrowser, stopLaneBrowser } from '../browser/lane-browser.ts';
import { realBrowserTools, type BrowserTools } from '../browser/tools.ts';
import type { Clock } from '../clock.ts';
import type { AdbFactory } from '../devices/adb.ts';
import type { DeviceBackend, Platform } from '../devices/backend.ts';
import type { SimTools } from '../devices/tools.ts';
import { stopLaneEngine } from '../driver/client.ts';
import { messageOf } from '../driver/errors.ts';
import { realEvidenceSystem, type EvidenceSystem } from '../evidence/device.ts';
import { stopRecordings } from '../evidence/evidence.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { isProven, judgeProcess } from '../registry/owner.ts';
import type { LanePark, ParkedDevice, ParkRestarts } from '../registry/parks.ts';
import { mergeRestarts } from '../registry/parks.ts';
import type { ParkCandidate, Registry } from '../registry/registry.ts';
import { laneHasEnded, laneLastCall } from '../registry/touch.ts';
import type { Lane } from '../registry/types.ts';
import { describeStop, judgeLeader, stopService } from '../services/services.ts';
import type { ServiceSystem } from '../services/system.ts';
import { laneDir, readUpRecord } from './lane-files.ts';
import { browserControl, clearDeviceState } from './release.ts';

/** How long a park or wake may stand unfinished before the sweep looks at it again, and between its tries at a lane it could not park in full. */
export const PARK_RETRY_MS = 5 * 60_000;

const NOUN: Readonly<Record<Platform, string>> = { ios: 'simulator', android: 'emulator' };

export interface ParkDeps {
  env: NodeJS.ProcessEnv;
  processes: ProcessTable;
  system: ServiceSystem;
  clock: Clock;
  devices: Partial<Record<Platform, DeviceBackend>>;
  browser?: BrowserTools;
  evidence?: EvidenceSystem;
  /** How the bundler pin and dial defaults `up` wrote are cleared from a simulator before it goes back to the pool. */
  sim?: SimTools | null;
  adb?: AdbFactory;
}

export type ParkOutcome =
  | { kind: 'parked'; lane: string; restarts: ParkRestarts; notes: string[]; problems: string[] }
  | { kind: 'left'; lane: string; reason: string };

export function attemptId(): string {
  return randomBytes(6).toString('hex');
}

export function deadHolder(park: LanePark | null, processes: ProcessTable): ProcessIdentity | null {
  const holder = park?.holder ?? null;
  if (!holder) return null;
  return isProven(judgeProcess(holder, processes.startTimes([holder.pid]))) ? holder : null;
}

function bootedNow(backend: DeviceBackend | undefined, id: string): boolean | null {
  if (!backend) return null;
  try {
    const listed = backend.list().find(d => d.id === id);
    return listed ? listed.booted : null;
  } catch {
    return null;
  }
}

function restartsOf(deps: ParkDeps, dir: string, lane: Lane): ParkRestarts {
  const device = lane.device;
  const parked: ParkedDevice | null = device
    ? {
        platform: device.platform,
        name: device.name,
        id: device.id,
        deviceType: device.deviceType,
        deviceTypeName: device.deviceTypeName,
        runtime: device.runtime,
        runtimeName: device.runtimeName,
        booted: bootedNow(deps.devices[device.platform], device.id) ?? true,
      }
    : null;
  return {
    device: parked,
    services: lane.processes.map(p => p.service),
    browser: lane.browser?.driver ?? null,
    app: readUpRecord(laneDir(dir, lane.id))?.bundleId ?? null,
  };
}

async function stopEverything(deps: ParkDeps, registry: Registry, dir: string, lane: Lane): Promise<string[]> {
  const notes: string[] = [];
  const problems: string[] = [];
  try {
    if (await stopLaneEngine(dir, lane.id, { processes: deps.processes })) notes.push('stopped the driver');
  } catch (error) {
    problems.push(messageOf(error));
  }
  const tools = deps.browser ?? realBrowserTools;
  const into = { lane: lane.id, notes, problems };
  const control = hasBrowser(lane) ? await browserControl({ env: deps.env, browser: tools }, dir, lane, into) : null;
  const recordings = await stopRecordings(
    { stateDir: dir, lane, env: deps.env, clock: deps.clock, system: deps.evidence ?? realEvidenceSystem },
    control,
  );
  notes.push(...recordings.notes);
  problems.push(...recordings.problems);
  if (hasBrowser(lane)) {
    const stopped = await stopLaneBrowser(tools, dir, lane.id, lane.browser.session, deps.clock, control, true);
    notes.push(...stopped.notes);
    problems.push(...stopped.problems);
  }
  const ref = { id: lane.id, token: lane.token };
  for (const proc of lane.processes) {
    const outcome = await stopService(deps.system, proc, deps.clock);
    const line = describeStop(proc, outcome);
    const down =
      outcome.kind === 'stopped' ||
      outcome.kind === 'already-gone' ||
      (outcome.kind === 'not-ours' && judgeLeader(deps.system, { ...proc, cwd: null }) === 'pid-reused');
    if (down) registry.forgetProcess(ref, proc.service);
    if (outcome.kind === 'stopped' || outcome.kind === 'already-gone') notes.push(line);
    else problems.push(line);
  }
  await clearDeviceState(
    { env: deps.env, sim: deps.sim ?? null, ...(deps.adb ? { adb: deps.adb } : {}) },
    lane,
    readUpRecord(laneDir(dir, lane.id)),
    into,
  );
  return problems;
}

/**
 * Parks a lane its owner left unused since `idleSince`, or whose owner a check found gone: stops its driver, browser,
 * recordings and services, clears what `up` left on its device, then frees the device, which goes back to the pool
 * once it is shut down. Its ports, resources and record stay, and the lane is recorded as parked with what its next
 * call restarts. A call that lands meanwhile keeps an idle lane awake.
 */
export async function parkLane(
  deps: ParkDeps,
  registry: Registry,
  candidate: Pick<ParkCandidate, 'ref' | 'park'>,
  idleSince: number | 'owner-gone',
): Promise<ParkOutcome> {
  const { ref } = candidate;
  const dir = registry.dir;
  const attempt = attemptId();
  let lane: Lane | null;
  try {
    lane = registry.beginPark(ref, idleSince, attempt, deadHolder(candidate.park, deps.processes));
  } catch (error) {
    if (laneHasEnded(error)) return { kind: 'left', lane: ref.id, reason: 'it has ended' };
    throw error;
  }
  if (!lane) {
    const reason =
      idleSince === 'owner-gone'
        ? 'its owner came back, or another call is parking, waking or ending it'
        : 'it was used or held, or another call is parking or waking it';
    return { kind: 'left', lane: ref.id, reason };
  }
  if (idleSince !== 'owner-gone' && laneLastCall(dir, { ...ref, lastUsedAt: lane.lastUsedAt }) > idleSince) {
    registry.abortPark(ref, attempt);
    return { kind: 'left', lane: ref.id, reason: 'it was used' };
  }
  const restarts = mergeRestarts(candidate.park?.restarts ?? restartsOf(deps, dir, lane), restartsOf(deps, dir, lane));
  const notes: string[] = [];
  try {
    const problems = await stopEverything(deps, registry, dir, lane);
    if (!registry.finishPark(ref, attempt, restarts, problems, notes)) {
      return { kind: 'left', lane: ref.id, reason: 'another call took it while it was being parked' };
    }
    const device = restarts.device;
    if (device && lane.device && bootedNow(deps.devices[device.platform], device.id) === true) {
      const line = `${NOUN[device.platform]} ${device.name} could not be shut down, so it is back in the pool still running; the next claim on this Mac shuts it down`;
      registry.noteParkProblems(ref, [line]);
      problems.push(line);
    }
    return { kind: 'parked', lane: ref.id, restarts, notes, problems };
  } catch (error) {
    if (laneHasEnded(error)) return { kind: 'left', lane: ref.id, reason: 'it ended while it was being parked' };
    registry.giveUp(ref, attempt, [`parking stopped partway: ${messageOf(error)}`]);
    throw error;
  }
}
