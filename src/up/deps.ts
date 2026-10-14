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

/** Starts the lane's driver engine and reads the screen once, so the agent's first look is warm. */
export type DriverStarter = (lane: Lane, stateDir: string) => Promise<void>;

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
  selfPid?: number;
  onCancel?: (cancel: () => void) => () => void;
}
