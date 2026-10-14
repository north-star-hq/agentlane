import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Appearance, Coordinate, DeviceInfo, SimTools, StatusBarFields } from './tools.ts';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: readonly string[], options?: { input?: string }) => Promise<ExecResult>;

const COMMAND_TIMEOUT_MS = 180_000;
const SIMULATOR_DOMAIN = 'com.apple.iphonesimulator';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
/** UIKit sets this when it shows the slide-to-type intro over the first software keyboard, and skips the intro while it holds true (iOS 26.5). */
const KEYBOARD_INTRO_DEFAULT = { domain: 'com.apple.keyboard.preferences', key: 'DidShowContinuousPathIntroduction' } as const;
const EMPTY_PLIST_DICT = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict/>\n</plist>\n';

export class DeviceCommandError extends Error {
  override name = 'DeviceCommandError';
  readonly command: string;
  readonly result: ExecResult;

  constructor(command: string, args: readonly string[], result: ExecResult) {
    const detail = (result.stderr || result.stdout).trim().slice(-2000);
    super(`${[command, ...args].join(' ')} exited ${String(result.code)}${detail ? `: ${detail}` : ''}`);
    this.command = command;
    this.result = result;
  }
}

export const execCommand: Exec = (command, args, options) =>
  new Promise(resolve => {
    const child = execFile(
      command,
      [...args],
      { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: error !== null && !stderr ? error.message : stderr });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options?.input ?? '');
  });

export function parseDevices(json: string): DeviceInfo[] {
  const parsed = JSON.parse(json) as {
    devices?: Record<string, { udid: string; name: string; state: string; dataPath: string }[]>;
  };
  return Object.values(parsed.devices ?? {})
    .flat()
    .map(({ udid, name, state, dataPath }) => ({ udid, name, state, dataPath }));
}

export function parseStatusBar(text: string): StatusBarFields {
  const fields: StatusBarFields = {};
  const lines = text.split('\n');
  const rule = lines.findIndex(line => /^=+$/.test(line.trim()));
  for (const line of lines.slice(rule + 1)) {
    for (const part of line.split(/,\s+(?=[A-Z][A-Za-z ]*:)/)) {
      const match = /^\s*([^:]+?):\s*(.*?)\s*$/.exec(part);
      if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2];
    }
  }
  return fields;
}

export function parseLogTimestamp(stamp: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2}):?(\d{2})$/.exec(stamp.trim());
  if (!match) return undefined;
  const [, day, time, fraction = '0', offsetHours, offsetMinutes] = match;
  const date = new Date(
    `${day ?? ''}T${time ?? ''}.${fraction.padEnd(3, '0').slice(0, 3)}${offsetHours ?? ''}:${offsetMinutes ?? ''}`,
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const LOCATION_MESSAGE = /at location \(<([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)>\)/;

export const LOCATION_LOG_PREDICATE = 'process == "locationd" AND eventMessage CONTAINS "notifying clients"';

export function parseLocationLog(ndjson: string, since: Date): Coordinate | undefined {
  let latest: { at: Date; coordinate: Coordinate } | undefined;
  for (const line of ndjson.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event: { timestamp?: unknown; eventMessage?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.timestamp !== 'string' || typeof event.eventMessage !== 'string') continue;
    const at = parseLogTimestamp(event.timestamp);
    const match = LOCATION_MESSAGE.exec(event.eventMessage);
    if (!at || !match || at < since) continue;
    if (latest && at < latest.at) continue;
    latest = { at, coordinate: { latitude: Number(match[1]), longitude: Number(match[2]) } };
  }
  return latest?.coordinate;
}

export function parseAppPid(launchctlList: string, bundleId: string): number | undefined {
  for (const line of launchctlList.split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label?.startsWith(`UIKitApplication:${bundleId}[`) && pid !== undefined && /^\d+$/.test(pid)) return Number(pid);
  }
  return undefined;
}

export function parsePlistBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (['false', '0', 'no'].includes(value)) return false;
  if (['true', '1', 'yes'].includes(value)) return true;
  return undefined;
}

export function formatCoordinate({ latitude, longitude }: Coordinate): string {
  return `${String(latitude)},${String(longitude)}`;
}

export interface XcrunToolsOptions {
  exec?: Exec;
}

export function createXcrunTools(options: XcrunToolsOptions = {}): SimTools {
  const exec = options.exec ?? execCommand;

  async function run(command: string, args: readonly string[], input?: string): Promise<string> {
    const result = await exec(command, args, input === undefined ? undefined : { input });
    if (result.code !== 0) throw new DeviceCommandError(command, args, result);
    return result.stdout;
  }

  const simctl = (args: readonly string[], input?: string) => run('xcrun', ['simctl', ...args], input);

  async function exportSimulatorPrefs(): Promise<string | undefined> {
    const result = await exec('defaults', ['export', SIMULATOR_DOMAIN, '-']);
    return result.code === 0 ? result.stdout : undefined;
  }

  async function readDefault(udid: string, domain: string, key: string): Promise<string | undefined> {
    const args = ['simctl', 'spawn', udid, 'defaults', 'read', domain, key];
    const result = await exec('xcrun', args);
    if (result.code === 0) return result.stdout.trim();
    if (result.stderr.includes('does not exist')) return undefined;
    throw new DeviceCommandError('xcrun', args, result);
  }

  async function readPlistString(file: string, key: string): Promise<string | undefined> {
    try {
      await fs.access(file);
    } catch {
      return undefined;
    }
    const result = await exec(PLIST_BUDDY, ['-c', `Print :${key}`, file]);
    return result.code === 0 ? result.stdout.replace(/\n$/, '') : undefined;
  }

  return {
    async device(udid) {
      const devices = parseDevices(await simctl(['list', 'devices', '--json']));
      return devices.find(device => device.udid === udid);
    },

    async setLocation(udid, at) {
      await simctl(['location', udid, 'set', formatCoordinate(at)]);
    },

    async readLocation(udid, since) {
      const seconds = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 1000) + 1);
      const ndjson = await simctl([
        'spawn',
        udid,
        'log',
        'show',
        '--last',
        `${String(seconds)}s`,
        '--style',
        'ndjson',
        '--predicate',
        LOCATION_LOG_PREDICATE,
      ]);
      return parseLocationLog(ndjson, since);
    },

    async readHardwareKeyboard(udid) {
      const prefs = await exportSimulatorPrefs();
      if (prefs === undefined) return undefined;
      const result = await exec(
        'plutil',
        ['-extract', `DevicePreferences.${udid}.ConnectHardwareKeyboard`, 'raw', '-o', '-', '-'],
        {
          input: prefs,
        },
      );
      return result.code === 0 ? parsePlistBoolean(result.stdout) : undefined;
    },

    async writeHardwareKeyboard(udid, connected) {
      const prefs = await exportSimulatorPrefs();
      let current = EMPTY_PLIST_DICT;
      if (prefs !== undefined) {
        const extracted = await exec('plutil', ['-extract', `DevicePreferences.${udid}`, 'xml1', '-o', '-', '-'], {
          input: prefs,
        });
        if (extracted.code === 0) current = extracted.stdout;
      }
      const updated = await run(
        'plutil',
        ['-replace', 'ConnectHardwareKeyboard', '-bool', connected ? 'YES' : 'NO', '-o', '-', '-'],
        current,
      );
      await run('defaults', ['write', SIMULATOR_DOMAIN, 'DevicePreferences', '-dict-add', udid, updated]);
    },

    async readKeyboardIntroShown(udid) {
      const raw = await readDefault(udid, KEYBOARD_INTRO_DEFAULT.domain, KEYBOARD_INTRO_DEFAULT.key);
      return raw === undefined ? undefined : parsePlistBoolean(raw);
    },

    async writeKeyboardIntroShown(udid, shown) {
      await simctl([
        'spawn',
        udid,
        'defaults',
        'write',
        KEYBOARD_INTRO_DEFAULT.domain,
        KEYBOARD_INTRO_DEFAULT.key,
        '-bool',
        shown ? 'YES' : 'NO',
      ]);
    },

    async overrideStatusBar(udid, flags) {
      await simctl(['status_bar', udid, 'override', ...flags]);
    },

    async readStatusBar(udid) {
      return parseStatusBar(await simctl(['status_bar', udid, 'list']));
    },

    async setAppearance(udid, appearance: Appearance) {
      await simctl(['ui', udid, 'appearance', appearance]);
    },

    async readAppearance(udid) {
      const value = (await simctl(['ui', udid, 'appearance'])).trim();
      return value || undefined;
    },

    async appInstalled(udid, bundleId) {
      return (await exec('xcrun', ['simctl', 'get_app_container', udid, bundleId])).code === 0;
    },

    async appRunning(udid, bundleId) {
      const list = await simctl(['spawn', udid, 'launchctl', 'list']);
      return list.split('\n').some(line => line.includes(`UIKitApplication:${bundleId}[`));
    },

    async installApp(udid, appPath) {
      await simctl(['install', udid, appPath]);
    },

    async appContainer(udid, bundleId) {
      const result = await exec('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app']);
      return result.code === 0 ? result.stdout.trim() || undefined : undefined;
    },

    async appCommandLine(udid, bundleId) {
      const list = await simctl(['spawn', udid, 'launchctl', 'list']);
      const pid = parseAppPid(list, bundleId);
      if (pid === undefined) return undefined;
      const result = await exec('ps', ['-ww', '-o', 'args=', '-p', String(pid)]);
      return result.code === 0 ? result.stdout.trim() || undefined : undefined;
    },

    readAppDefault: readDefault,

    async writeAppDefault(udid, bundleId, key, value) {
      await simctl(['spawn', udid, 'defaults', 'write', bundleId, key, '-string', value]);
    },

    async deleteAppDefault(udid, bundleId, key) {
      const args = ['simctl', 'spawn', udid, 'defaults', 'delete', bundleId, key];
      const result = await exec('xcrun', args);
      if (result.code !== 0 && !result.stderr.includes('does not exist')) throw new DeviceCommandError('xcrun', args, result);
    },

    readPlistString,

    async writePlistString(file, key, value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const exists = (await readPlistString(file, key)) !== undefined;
      await run(PLIST_BUDDY, ['-c', `${exists ? 'Set' : 'Add'} :${key} ${exists ? '' : 'string '}${value}`, file]);
    },

    async launch(udid, bundleId, args) {
      await simctl(['launch', udid, bundleId, ...args]);
    },

    async terminate(udid, bundleId) {
      await exec('xcrun', ['simctl', 'terminate', udid, bundleId]);
    },

    async openUrl(udid, url) {
      await simctl(['openurl', udid, url]);
    },

    async shutdown(udid) {
      await simctl(['shutdown', udid]);
    },

    async boot(udid) {
      await simctl(['boot', udid]);
      await simctl(['bootstatus', udid, '-b']);
    },

    now: () => new Date(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}
