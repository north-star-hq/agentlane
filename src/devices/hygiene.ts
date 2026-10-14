import { DeviceStateError, requireBooted } from './common.ts';
import type { Appearance, Coordinate, SimTools, StatusBarFields } from './tools.ts';
import { formatCoordinate } from './xcrun.ts';

export const DEFAULT_FIXTURE_LOCATION: Coordinate = { latitude: 37.3349, longitude: -122.009 };
export const DEFAULT_APPEARANCE: Appearance = 'light';

export const STATUS_BAR_PIN_FLAGS: readonly string[] = [
  '--time',
  '09:41',
  '--dataNetwork',
  'wifi',
  '--wifiMode',
  'active',
  '--wifiBars',
  '3',
  '--cellularMode',
  'active',
  '--cellularBars',
  '4',
  '--batteryState',
  'charged',
  '--batteryLevel',
  '100',
];

export const STATUS_BAR_PIN_FIELDS: Readonly<StatusBarFields> = {
  Time: '09:41',
  DataNetworkType: '11',
  'WiFi Mode': '3',
  'WiFi Bars': '3',
  'Cell Mode': '3',
  'Cell Bars': '4',
  'Battery State': '2',
  'Battery Level': '100',
};

const LOCATION_FRESH_MS = 3000;
const LOCATION_HEARD_MS = 300_000;
const COORDINATE_TOLERANCE = 5e-8;

export type HygieneStepName = 'location' | 'keyboard' | 'keyboard-intro' | 'status-bar' | 'appearance' | 'animations';

export interface HygieneOptions {
  location?: Coordinate;
  appearance?: Appearance;
  locationReadAttempts?: number;
  locationPollMs?: number;
  locationSetAttempts?: number;
  /** How far back a location reading counts. locationd logs one only while an app is receiving updates. */
  locationLookbackMs?: number;
}

export interface HygieneStepCheck {
  step: HygieneStepName;
  wanted: string;
  got: string;
  ok: boolean;
}

export interface HygieneCheck {
  udid: string;
  ok: boolean;
  steps: HygieneStepCheck[];
}

export interface HygieneStepReport {
  step: HygieneStepName;
  wanted: string;
  before: string;
  after: string;
  changed: boolean;
  ok: boolean;
  tries?: string;
  error?: string;
}

export interface HygieneReport {
  udid: string;
  changed: boolean;
  steps: HygieneStepReport[];
}

export class HygieneError extends DeviceStateError {
  override name = 'HygieneError';
  readonly report: HygieneReport;

  constructor(report: HygieneReport) {
    const failed = report.steps.filter(step => !step.ok);
    super(
      `capture hygiene did not take on ${report.udid}: ${failed
        .map(
          step =>
            `${step.step} reads back ${step.after}, not ${step.wanted}${step.tries ? ` ${step.tries}` : ''}${step.error ? ` (${step.error})` : ''}`,
        )
        .join('; ')}`,
    );
    this.report = report;
  }
}

interface Step<T> {
  name: HygieneStepName;
  wanted: string;
  read(): Promise<T | undefined>;
  matches(value: T | undefined): boolean;
  format(value: T | undefined): string;
  apply(): Promise<void>;
  readBack(): Promise<T | undefined>;
  tries?(): string;
}

export function sameCoordinate(a: Coordinate | undefined, b: Coordinate): boolean {
  return (
    a !== undefined &&
    Math.abs(a.latitude - b.latitude) <= COORDINATE_TOLERANCE &&
    Math.abs(a.longitude - b.longitude) <= COORDINATE_TOLERANCE
  );
}

export function statusBarPinned(fields: StatusBarFields | undefined): boolean {
  return fields !== undefined && Object.entries(STATUS_BAR_PIN_FIELDS).every(([key, value]) => fields[key] === value);
}

function formatStatusBar(fields: StatusBarFields | undefined): string {
  const entries = Object.entries(fields ?? {});
  return entries.length === 0 ? 'no overrides' : entries.map(([key, value]) => `${key} ${value}`).join(', ');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readLocation(
  tools: SimTools,
  udid: string,
  lookbackMs = LOCATION_FRESH_MS,
): Promise<Coordinate | undefined> {
  return tools.readLocation(udid, new Date(tools.now().getTime() - lookbackMs));
}

function steps(tools: SimTools, udid: string, options: HygieneOptions): Step<unknown>[] {
  const location = options.location ?? DEFAULT_FIXTURE_LOCATION;
  const appearance = options.appearance ?? DEFAULT_APPEARANCE;
  const attempts = options.locationReadAttempts ?? 8;
  const pollMs = options.locationPollMs ?? 1000;
  const setAttempts = options.locationSetAttempts ?? 3;

  let locationSetAt = tools.now();
  let sets = 0;
  const locationStep: Step<Coordinate> = {
    name: 'location',
    wanted: formatCoordinate(location),
    read: () => readLocation(tools, udid, options.locationLookbackMs),
    matches: value => sameCoordinate(value, location),
    format: value => (value ? formatCoordinate(value) : 'nothing'),
    async apply() {
      locationSetAt = tools.now();
      sets = 1;
      await tools.setLocation(udid, location);
    },
    async readBack() {
      let got: Coordinate | undefined;
      for (;;) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await tools.sleep(pollMs);
          got = await tools.readLocation(udid, locationSetAt);
          if (sameCoordinate(got, location)) return got;
        }
        if (sets >= setAttempts) return got;
        sets += 1;
        await tools.setLocation(udid, location);
      }
    },
    tries: () =>
      `after setting it ${String(sets)} time${sets === 1 ? '' : 's'} over ${String(Math.round((tools.now().getTime() - locationSetAt.getTime()) / 1000))} s`,
  };

  const keyboardStep: Step<boolean> = {
    name: 'keyboard',
    wanted: 'hardware keyboard disconnected',
    read: () => tools.readHardwareKeyboard(udid),
    matches: value => value === false,
    format: value =>
      value === undefined
        ? 'no per-device setting (inherits the host)'
        : `hardware keyboard ${value ? 'connected' : 'disconnected'}`,
    apply: () => tools.writeHardwareKeyboard(udid, false),
    readBack: () => tools.readHardwareKeyboard(udid),
  };

  const keyboardIntroStep: Step<boolean> = {
    name: 'keyboard-intro',
    wanted: 'slide-to-type intro marked shown',
    read: () => tools.readKeyboardIntroShown(udid),
    matches: value => value === true,
    format: value => `slide-to-type intro ${value ? 'marked shown' : 'not shown yet'}`,
    apply: () => tools.writeKeyboardIntroShown(udid, true),
    readBack: () => tools.readKeyboardIntroShown(udid),
  };

  const statusBarStep: Step<StatusBarFields> = {
    name: 'status-bar',
    wanted: formatStatusBar(STATUS_BAR_PIN_FIELDS),
    read: () => tools.readStatusBar(udid),
    matches: statusBarPinned,
    format: formatStatusBar,
    apply: () => tools.overrideStatusBar(udid, STATUS_BAR_PIN_FLAGS),
    readBack: () => tools.readStatusBar(udid),
  };

  const appearanceStep: Step<string> = {
    name: 'appearance',
    wanted: appearance,
    read: () => tools.readAppearance(udid),
    matches: value => value === appearance,
    format: value => value ?? 'nothing',
    apply: () => tools.setAppearance(udid, appearance),
    readBack: () => tools.readAppearance(udid),
  };

  return [locationStep, keyboardStep, keyboardIntroStep, statusBarStep, appearanceStep] as Step<unknown>[];
}

export async function checkHygiene(tools: SimTools, udid: string, options: HygieneOptions = {}): Promise<HygieneCheck> {
  await requireBooted(tools, udid);
  const checks: HygieneStepCheck[] = [];
  for (const step of steps(tools, udid, { locationLookbackMs: LOCATION_HEARD_MS, ...options })) {
    try {
      const got = await step.read();
      checks.push({ step: step.name, wanted: step.wanted, got: step.format(got), ok: step.matches(got) });
    } catch (error) {
      checks.push({ step: step.name, wanted: step.wanted, got: `unreadable (${message(error)})`, ok: false });
    }
  }
  return { udid, ok: checks.every(check => check.ok), steps: checks };
}

export async function applyHygiene(tools: SimTools, udid: string, options: HygieneOptions = {}): Promise<HygieneReport> {
  await requireBooted(tools, udid);
  const reports: HygieneStepReport[] = [];
  for (const step of steps(tools, udid, options)) {
    let before = 'unread';
    try {
      const current = await step.read();
      before = step.format(current);
      if (step.matches(current)) {
        reports.push({ step: step.name, wanted: step.wanted, before, after: before, changed: false, ok: true });
        continue;
      }
      await step.apply();
      const after = await step.readBack();
      const ok = step.matches(after);
      reports.push({
        step: step.name,
        wanted: step.wanted,
        before,
        after: step.format(after),
        changed: true,
        ok,
        ...(!ok && step.tries ? { tries: step.tries() } : {}),
      });
    } catch (error) {
      reports.push({
        step: step.name,
        wanted: step.wanted,
        before,
        after: 'unread',
        changed: false,
        ok: false,
        error: message(error),
      });
    }
  }
  const report: HygieneReport = { udid, changed: reports.some(step => step.changed), steps: reports };
  if (reports.some(step => !step.ok)) throw new HygieneError(report);
  return report;
}
