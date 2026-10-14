import type { Platform } from '../../src/devices/backend.ts';
import type { RegistryConfig } from '../../src/registry/config.ts';
import type { Step } from '../../src/registry/registry.ts';

export type StressOp =
  | {
      kind: 'claim';
      worktree: string;
      platform: Platform;
      device: string | null;
      strict: boolean;
      boot: boolean;
      waitMs: number;
    }
  | { kind: 'touch' }
  | { kind: 'release' }
  | { kind: 'pause'; ms: number };

export interface ClaimerPlan {
  stateDir: string;
  devicesDir: string;
  emulatorsDir: string;
  config: RegistryConfig;
  ownerPid: number | null;
  threadOwner: string | null;
  startMs: number;
  ops: StressOp[];
  crashAt: Step[];
  crashOccurrence: number;
}

export const EXIT_REFUSED = 3;
export const EXIT_LIVE_LANE_FREED = 7;
export const EXIT_DEVICE_MISSING = 8;
export const EXIT_OVER_BUDGET = 9;
