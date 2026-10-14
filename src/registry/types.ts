import type { BrowserDriverName } from '../browser/kinds.ts';
import type { Platform } from '../devices/backend.ts';
import type { RegistryConfig } from './config.ts';
import type { Owner, OwnerState, ProvenState } from './owner.ts';

export interface ServiceRequest {
  name: string;
  type: string;
}

export interface DeviceRequest {
  platform: Platform;
  deviceType?: string | undefined;
  runtime?: string | undefined;
  strict?: boolean | undefined;
}

export interface BrowserRequest {
  driver: BrowserDriverName;
}

export interface LaneRequest {
  owner: Owner;
  worktree: string;
  projectRoot: string;
  services: readonly ServiceRequest[];
  device: DeviceRequest | null;
  /** A browser for the lane; null leaves the lane's browser, if it has one, as it is. */
  browser?: BrowserRequest | null;
  waitMs: number;
  boot?: boolean;
  action?: string;
}

export interface LaneRef {
  id: string;
  token: string;
}

export interface ClaimedPort {
  service: string;
  type: string;
  port: number;
}

export interface ClaimedDevice {
  platform: Platform;
  id: string;
  name: string;
  deviceType: string;
  deviceTypeName: string;
  runtime: string;
  runtimeName: string;
  serial: string | null;
}

/** The lane's own browser: its driver session, and the ports in the lane's ports. */
export interface ClaimedBrowser {
  driver: BrowserDriverName;
  /** The driver's session name, which no other lane uses. */
  session: string;
  debugPort: number;
  /** agent-browser's live-view stream; null for Playwright. */
  streamPort: number | null;
  createdAt: number;
}

/** A browser whose lane has ended, by release or reap, and whose processes may still run. */
export interface EndedBrowser {
  lane: string;
  driver: BrowserDriverName;
  session: string;
  worktree: string;
  createdAt: number;
}

export interface ServiceProcess {
  service: string;
  pid: number;
  start: string;
  cwd: string | null;
}

export type ResourceValues = Record<string, string>;

export interface LaneResource {
  name: string;
  /** What create exported; null while its create has not finished: it is running, it failed, or its run died. */
  exports: ResourceValues | null;
}

/** What `up` records when a resource's create starts, so its teardown can run without the config. */
export interface ResourceSpec {
  name: string;
  cwd: string;
  teardown: string;
  timeoutMs: number;
  env: ResourceValues;
  /** Every variable the config's resources export: unset for teardown unless it has a recorded value. */
  cleared: string[];
}

export type ResourceStart =
  { kind: 'kept'; exports: ResourceValues; createdAt: number } | { kind: 'create'; retry: string | null };

/** A resource of an ended lane, leased to this process to tear down. */
export interface ResourceTeardown extends ResourceSpec {
  lane: string;
  worktree: string;
  exports: ResourceValues | null;
  createdAt: number;
  attempts: number;
}

export interface PendingTeardown {
  lane: string;
  name: string;
  worktree: string;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  problem: string | null;
}

export interface LaneInfo {
  id: string;
  owner: Owner;
  ownerKey: string;
  projectRoot: string;
  worktree: string;
  createdAt: number;
  lastUsedAt: number;
  lastAction: string;
  device: ClaimedDevice | null;
  browser: ClaimedBrowser | null;
  ports: ClaimedPort[];
  processes: ServiceProcess[];
  resources: LaneResource[];
}

export interface Lane extends LaneInfo {
  token: string;
}

export type EndReason = ProvenState | 'released' | 'forced' | 'taken-over';

export interface EndedLane {
  id: string;
  owner: string;
  worktree: string;
  device: string | null;
  reason: EndReason;
  createdAt: number;
  lastUsedAt: number;
  lastAction: string;
  endedAt: number;
  by: string;
  processes?: ServiceProcess[];
}

export interface LaneOutcome {
  lane: Lane;
  created: boolean;
  tookOver: EndedLane[];
  freed: EndedLane[];
  notes: string[];
  /** The driver the lane's browser had before this lane changed it; null when it kept its driver. */
  replacedDriver: BrowserDriverName | null;
}

export type DeviceState = 'booted' | 'shutdown' | 'missing' | 'unknown';

export interface LaneStatus extends LaneInfo {
  ownerState: OwnerState;
  idleMs: number;
  deviceState: DeviceState | null;
}

export interface PoolDeviceStatus {
  name: string;
  platform: Platform;
  id: string | null;
  deviceTypeName: string;
  runtimeName: string;
  laneId: string | null;
  state: DeviceState | 'creating';
}

export interface QueueEntry {
  ticket: number;
  owner: string;
  worktree: string;
  enqueuedAt: number;
  waiterPid: number;
}

export interface StatusReport {
  stateDir: string;
  now: number;
  config: RegistryConfig;
  lanes: LaneStatus[];
  pool: PoolDeviceStatus[];
  queue: QueueEntry[];
  recent: EndedLane[];
  /** Resources of ended lanes whose teardown has not run, or failed and waits for the next try. */
  teardowns: PendingTeardown[];
}
