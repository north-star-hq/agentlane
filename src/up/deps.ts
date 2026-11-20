import type { BrowserTools } from '../browser/tools.ts';
import type { EvidenceSystem } from '../evidence/device.ts';
import type { Clock } from '../clock.ts';
import type { AdbFactory } from '../devices/adb.ts';
import type { DeviceBackend, Platform } from '../devices/backend.ts';
import type { SimTools } from '../devices/tools.ts';
import type { ProcessTable } from '../processes.ts';
import type { Lane } from '../registry/types.ts';
import type { PortProbe } from '../registry/ports.ts';
import type { ServiceSystem } from '../services/system.ts';
import type { Toolchain } from './preflight.ts';

/**
 * Starts the lane's driver engine and reads the screen once, so the agent's first look is warm. `javaHome` is a JDK 17
 * home already found; the driver searches for one when it is absent.
 */
export type DriverStarter = (lane: Lane, stateDir: string, javaHome?: string) => Promise<void>;

export interface EnvDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  log: (line: string) => void;
  processes: ProcessTable;
  ports: PortProbe;
  devices: Partial<Record<Platform, DeviceBackend>>;
  sim: SimTools | null;
  adb?: AdbFactory;
  system: ServiceSystem;
  toolchain: Toolchain;
  startDriver: DriverStarter;
  /** How lanes' browsers are installed, driven and stopped; the real drivers when absent. */
  browser?: BrowserTools;
  /** How device recordings and logs are taken; the real commands when absent. */
  evidence?: EvidenceSystem;
  clock: Clock;
  pollMs?: number;
  /** How often a long `exec` command or `up` hook counts as a call on the lane while it runs; HEARTBEAT_MS when absent. */
  heartbeatMs?: number;
  /** This process's parent pid, read anew on each call; `process.ppid` when absent. `exec` takes a change as its caller being gone. */
  parentPid?: () => number;
  /** How often `exec` checks that its caller is still there while its command runs; CALLER_POLL_MS when absent. */
  callerPollMs?: number;
  /** How long `exec` gives the processes of a command whose caller is gone to end after SIGTERM before SIGKILL; STOP_GRACE_MS when absent. */
  stopGraceMs?: number;
  selfPid?: number;
  onCancel?: (cancel: () => void) => () => void;
  /** Starts the sweep when it has work, as every command does at its start; a claim calls it when it finds work for it. */
  passBy?: () => void;
}
