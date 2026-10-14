import fs from 'node:fs';
import path from 'node:path';
import type { RegistryConfig } from '../../src/registry/config.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import type { Owner } from '../../src/registry/owner.ts';
import type { RegistryOptions, Step } from '../../src/registry/registry.ts';
import { Registry } from '../../src/registry/registry.ts';
import type { LaneRequest } from '../../src/registry/types.ts';
import { FakeClock, FakeDevices, FakeProbe, FakeProcesses, tempDir } from './fakes.ts';

export interface World {
  dir: string;
  procs: FakeProcesses;
  clock: FakeClock;
  probe: FakeProbe;
  devices: FakeDevices;
  emulators: FakeDevices;
  config: RegistryConfig;
  registry(options?: Partial<RegistryOptions>): Registry;
  folder(name: string): string;
  request(owner: Owner, worktree: string, extra?: Partial<LaneRequest>): LaneRequest;
  close(): void;
}

export function world(config: Partial<RegistryConfig> = {}): World {
  const root = tempDir('world');
  const dir = path.join(root, 'state');
  const procs = new FakeProcesses();
  const clock = new FakeClock();
  const probe = new FakeProbe();
  const devices = new FakeDevices(path.join(root, 'devices'));
  const emulators = new FakeDevices(path.join(root, 'emulators'), 'android');
  const merged: RegistryConfig = { ...DEFAULT_CONFIG, ...config };
  const open: Registry[] = [];
  return {
    dir,
    procs,
    clock,
    probe,
    devices,
    emulators,
    config: merged,
    registry(options = {}) {
      const registry = Registry.open({
        dir,
        processes: procs,
        ports: probe,
        devices: { ios: devices, android: emulators },
        config: merged,
        clock,
        pollMs: 500,
        self: procs.spawn(),
        ...options,
      });
      open.push(registry);
      return registry;
    },
    folder(name) {
      const folder = path.join(root, 'worktrees', name);
      fs.mkdirSync(folder, { recursive: true });
      return folder;
    },
    request(owner, worktree, extra = {}) {
      return {
        owner,
        worktree,
        projectRoot: worktree,
        services: [
          { name: 'metro', type: 'metro' },
          { name: 'api', type: 'api' },
        ],
        device: { platform: 'ios' },
        waitMs: 0,
        ...extra,
      };
    },
    close() {
      for (const r of open) r.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function waitForStep(step: Step): { onStep: (s: Step) => void; reached: Promise<void> } {
  let resolve: () => void = () => undefined;
  const reached = new Promise<void>(r => {
    resolve = r;
  });
  return {
    onStep: s => {
      if (s === step) resolve();
    },
    reached,
  };
}
