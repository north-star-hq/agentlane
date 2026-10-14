import fs from 'node:fs';
import { BROWSER_PORT_TYPE } from '../browser/kinds.ts';
import type { Platform } from '../devices/backend.ts';
import { configPath } from './paths.ts';
import { UsageError } from './refusal.ts';

export interface PortBlock {
  first: number;
  last: number;
}

export interface RegistryConfig {
  poolSize: number;
  emulatorPoolSize: number;
  memoryBudgetMb: number;
  idleMs: number;
  blocks: Readonly<Record<string, PortBlock>>;
}

export const HOUR_MS = 3_600_000;

export const DEVICE_MEMORY_MB: Readonly<Record<Platform, number>> = { ios: 4000, android: 3400 };

export const EMULATOR_PORTS: PortBlock = { first: 5554, last: 5585 };
export const EMULATOR_SERVICE = 'emulator';

export function emulatorSerial(consolePort: number): string {
  return `emulator-${String(consolePort)}`;
}

export function poolCap(config: RegistryConfig, platform: Platform): number {
  return platform === 'ios' ? config.poolSize : config.emulatorPoolSize;
}

export const DEFAULT_CONFIG: RegistryConfig = {
  poolSize: 5,
  emulatorPoolSize: 5,
  memoryBudgetMb: 5 * DEVICE_MEMORY_MB.ios,
  idleMs: 2 * HOUR_MS,
  blocks: {
    metro: { first: 41100, last: 41119 },
    api: { first: 41200, last: 41219 },
    web: { first: 41300, last: 41319 },
    [BROWSER_PORT_TYPE]: { first: 41400, last: 41439 },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535;
}

export function parseConfig(raw: unknown, source: string): RegistryConfig {
  const bad = (problem: string, fix: string) => new UsageError(`${source}: ${problem}`, fix);
  if (!isRecord(raw)) throw bad('the file is not a JSON object', `write an object such as {"poolSize": 5}`);
  const known = ['poolSize', 'emulatorPoolSize', 'memoryBudgetGB', 'idleHours', 'ports'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw bad(`unknown setting '${key}'`, `use only ${known.join(', ')}`);
  }
  const count = (key: 'poolSize' | 'emulatorPoolSize', fallback: number): number => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw bad(`${key} must be a whole number of at least 1`, `set "${key}": ${String(fallback)} (the default) or more`);
    }
    return value as number;
  };
  const poolSize = count('poolSize', DEFAULT_CONFIG.poolSize);
  const emulatorPoolSize = count('emulatorPoolSize', DEFAULT_CONFIG.emulatorPoolSize);
  let memoryBudgetMb = DEFAULT_CONFIG.memoryBudgetMb;
  if (raw.memoryBudgetGB !== undefined) {
    const oneDevice = Math.max(...Object.values(DEVICE_MEMORY_MB)) / 1000;
    if (typeof raw.memoryBudgetGB !== 'number' || !(raw.memoryBudgetGB >= oneDevice)) {
      throw bad(
        `memoryBudgetGB must be a number of at least ${String(oneDevice)} (one simulator)`,
        `set "memoryBudgetGB": ${String(DEFAULT_CONFIG.memoryBudgetMb / 1000)} (the default)`,
      );
    }
    memoryBudgetMb = Math.round(raw.memoryBudgetGB * 1000);
  }
  let idleMs = DEFAULT_CONFIG.idleMs;
  if (raw.idleHours !== undefined) {
    if (typeof raw.idleHours !== 'number' || !(raw.idleHours > 0)) {
      throw bad('idleHours must be a positive number', 'set "idleHours": 2 (the default)');
    }
    idleMs = raw.idleHours * HOUR_MS;
  }
  const blocks: Record<string, PortBlock> = { ...DEFAULT_CONFIG.blocks };
  if (raw.ports !== undefined) {
    if (!isRecord(raw.ports))
      throw bad('ports must be an object of [first, last] ranges', 'set "ports": {"metro": [41100, 41119]}');
    for (const [type, range] of Object.entries(raw.ports)) {
      if (!/^[a-z][a-z0-9-]*$/.test(type)) {
        throw bad(`port block name '${type}' must be lowercase letters, digits and dashes`, 'rename the block, e.g. "metro"');
      }
      if (!Array.isArray(range) || range.length !== 2 || !isPort(range[0]) || !isPort(range[1]) || range[0] > range[1]) {
        throw bad(
          `ports.${type} must be [first, last] with 1024 <= first <= last <= 65535`,
          `set "ports": {"${type}": [41100, 41119]}`,
        );
      }
      blocks[type] = { first: range[0], last: range[1] };
    }
  }
  const overlap = findOverlap(blocks);
  if (overlap)
    throw bad(`port blocks '${overlap[0]}' and '${overlap[1]}' overlap`, 'give each service type its own range of ports');
  const onEmulators = emulatorOverlap(blocks);
  if (onEmulators) throw bad(emulatorOverlapProblem(onEmulators), 'move that block clear of 5554-5585');
  return { poolSize, emulatorPoolSize, memoryBudgetMb, idleMs, blocks };
}

function emulatorOverlap(blocks: Readonly<Record<string, PortBlock>>): string | null {
  const hit = Object.entries(blocks).find(([, b]) => b.first <= EMULATOR_PORTS.last && b.last >= EMULATOR_PORTS.first);
  return hit ? hit[0] : null;
}

function emulatorOverlapProblem(type: string): string {
  return `port block '${type}' overlaps the Android emulator console and adb ports ${String(EMULATOR_PORTS.first)}-${String(EMULATOR_PORTS.last)}`;
}

function findOverlap(blocks: Readonly<Record<string, PortBlock>>): [string, string] | null {
  const entries = Object.entries(blocks).sort((a, b) => a[1].first - b[1].first);
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev && cur && cur[1].first <= prev[1].last) return [prev[0], cur[0]];
  }
  return null;
}

export function withProjectBlocks(
  config: RegistryConfig,
  extra: Readonly<Record<string, PortBlock>>,
  source: string,
): RegistryConfig {
  const added = Object.entries(extra).filter(([type]) => !(type in config.blocks));
  if (added.length === 0) return config;
  const blocks = { ...config.blocks, ...Object.fromEntries(added) };
  const onEmulators = emulatorOverlap(blocks);
  if (onEmulators)
    throw new UsageError(`${source}: ${emulatorOverlapProblem(onEmulators)}`, 'move that block clear of 5554-5585');
  const overlap = findOverlap(blocks);
  if (overlap) {
    throw new UsageError(
      `${source}: port blocks '${overlap[0]}' and '${overlap[1]}' overlap`,
      `give the ${added.map(([type]) => type).join(', ')} service type its own range of ports, clear of ${Object.entries(
        config.blocks,
      )
        .map(([type, b]) => `${type} ${String(b.first)}-${String(b.last)}`)
        .join(', ')}`,
    );
  }
  return { ...config, blocks };
}

export function loadConfig(dir: string): RegistryConfig {
  const file = configPath(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError(`${file}: not valid JSON`, `fix the JSON, or delete the file to use the defaults`);
  }
  return parseConfig(raw, file);
}
