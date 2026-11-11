import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Platform } from '../../src/devices/backend.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import type { RegistryConfig } from '../../src/registry/config.ts';
import type { Owner } from '../../src/registry/owner.ts';
import type { Step } from '../../src/registry/registry.ts';
import { Registry } from '../../src/registry/registry.ts';
import type { SlowCall } from './fakes.ts';
import { FakeDevices, FakeProbe, tempDir } from './fakes.ts';

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

export interface SlowDevices {
  ms: Readonly<Record<SlowCall, number>>;
  journal: string;
}

export interface DeviceGate {
  dir: string;
  calls: SlowCall[];
}

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
  slow?: SlowDevices;
  gate?: DeviceGate;
}

export const EXIT_REFUSED = 3;
export const EXIT_LIVE_LANE_FREED = 7;
export const EXIT_DEVICE_MISSING = 8;
export const EXIT_OVER_BUDGET = 9;
export const EXIT_HELD_IN_FLIGHT = 10;
export const EXIT_GATE_NEVER_OPENED = 11;

export function gateEntered(gate: DeviceGate, call: SlowCall): string {
  return path.join(gate.dir, `${call}.entered`);
}

export function gateOpen(gate: DeviceGate, call: SlowCall): string {
  return path.join(gate.dir, `${call}.open`);
}

export interface ClaimerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunningClaimer {
  pid: number;
  exited: Promise<ClaimerExit>;
  kill(): void;
}

const CLAIMER = path.join(import.meta.dirname, 'stress-claimer.ts');

export function startClaimer(plan: ClaimerPlan): RunningClaimer {
  const child = spawn(process.execPath, [CLAIMER, JSON.stringify(plan)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<ClaimerExit>(resolve => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    pid: child.pid ?? 0,
    exited,
    kill: () => child.kill('SIGKILL'),
  };
}

export function runClaimer(plan: ClaimerPlan): Promise<ClaimerExit> {
  return startClaimer(plan).exited;
}

export interface SharedRegistry {
  stateDir: string;
  config: RegistryConfig;
  sims: FakeDevices;
  emulators: FakeDevices;
  gate: DeviceGate;
  owner: Owner;
  registry(): Registry;
  folder(name: string): string;
  plan(ops: StressOp[], options?: { gate?: SlowCall[]; crashAt?: Step[] }): ClaimerPlan;
  reached(call: SlowCall, claimer: RunningClaimer): Promise<string>;
  open(call: SlowCall): void;
  close(): void;
}

export function sharedRegistry(config: RegistryConfig): SharedRegistry {
  const root = tempDir('shared');
  const stateDir = path.join(root, 'state');
  const devicesDir = path.join(root, 'devices');
  const emulatorsDir = path.join(root, 'emulators');
  const gate: DeviceGate = { dir: path.join(root, 'gate'), calls: [] };
  fs.mkdirSync(gate.dir, { recursive: true });
  const self = identityOf(systemProcesses, process.pid);
  if (!self) throw new Error('ps could not read the test process');
  const sims = new FakeDevices(devicesDir);
  const emulators = new FakeDevices(emulatorsDir, 'android');
  const opened: Registry[] = [];
  const running: RunningClaimer[] = [];
  return {
    stateDir,
    config,
    sims,
    emulators,
    gate,
    owner: { kind: 'process', process: self, sessionId: null, threadId: null },
    registry() {
      const registry = Registry.open({
        dir: stateDir,
        processes: systemProcesses,
        ports: new FakeProbe(),
        devices: { ios: sims, android: emulators },
        config,
        lockWaitMs: 2000,
        self,
      });
      opened.push(registry);
      return registry;
    },
    folder(name) {
      const dir = path.join(root, 'worktrees', name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    plan(ops, options = {}) {
      return {
        stateDir,
        devicesDir,
        emulatorsDir,
        config,
        ownerPid: null,
        threadOwner: null,
        startMs: 0,
        ops,
        crashAt: options.crashAt ?? [],
        crashOccurrence: 1,
        gate: { ...gate, calls: options.gate ?? [] },
      };
    },
    async reached(call, claimer) {
      running.push(claimer);
      const file = gateEntered(gate, call);
      const seen: { exit: ClaimerExit | null } = { exit: null };
      void claimer.exited.then(e => (seen.exit = e));
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(file)) {
        if (seen.exit) throw new Error(`the claimer exited before its ${call} began: ${JSON.stringify(seen.exit)}`);
        if (Date.now() > deadline) throw new Error(`the claimer never began its ${call}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return fs.readFileSync(file, 'utf8');
    },
    open(call) {
      fs.writeFileSync(gateOpen(gate, call), '');
    },
    close() {
      for (const r of opened) r.close();
      for (const c of running) c.kill();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
