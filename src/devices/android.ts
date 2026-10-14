import { ANIMATION_SETTINGS, type AdbTools } from './adb.ts';
import { assertBundleId, assertScheme, DeviceStateError } from './common.ts';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_FIXTURE_LOCATION,
  HygieneError,
  type HygieneCheck,
  type HygieneOptions,
  type HygieneReport,
  type HygieneStepCheck,
  type HygieneStepReport,
} from './hygiene.ts';
import { devClientLink } from './launch.ts';
import { formatCoordinate } from './xcrun.ts';

export const REACT_NATIVE_DEVICE_PORT = 8081;
export const LOCATION_UNREADABLE = "set with adb emu geo fix; the emulator can't read its GPS fix back";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function animationsOff(values: readonly (string | undefined)[]): boolean {
  return values.every(value => value !== undefined && Number(value) === 0);
}

function formatAnimations(values: readonly (string | undefined)[]): string {
  return ANIMATION_SETTINGS.map((key, i) => `${key} ${values[i] ?? 'unset'}`).join(', ');
}

async function readAnimations(tools: AdbTools): Promise<(string | undefined)[]> {
  return Promise.all(ANIMATION_SETTINGS.map(key => tools.globalSetting(key)));
}

export async function requireEmulatorBooted(tools: AdbTools): Promise<void> {
  if (!(await tools.bootCompleted())) {
    throw new DeviceStateError(
      `emulator ${tools.serial} has not finished booting`,
      `check 'adb -s ${tools.serial} shell getprop sys.boot_completed', or release and claim again`,
    );
  }
}

export async function requireAppInstalled(tools: AdbTools, pkg: string): Promise<void> {
  assertBundleId(pkg);
  if (!(await tools.appInstalled(pkg))) {
    throw new DeviceStateError(
      `${pkg} is not installed on ${tools.serial}`,
      `install the build first ('adb -s ${tools.serial} install -r <apk>')`,
    );
  }
}

/**
 * Capture hygiene on an emulator: the fixture location, the appearance, and animations off so screen reads settle.
 * A simulator's hardware-keyboard setting and status-bar pin have no equivalent the emulator can read back.
 */
export async function applyAndroidHygiene(tools: AdbTools, options: HygieneOptions = {}): Promise<HygieneReport> {
  await requireEmulatorBooted(tools);
  const location = options.location ?? DEFAULT_FIXTURE_LOCATION;
  const appearance = options.appearance ?? DEFAULT_APPEARANCE;
  const steps: HygieneStepReport[] = [];
  const step = async (report: () => Promise<HygieneStepReport>, name: HygieneStepReport['step'], wanted: string) => {
    try {
      steps.push(await report());
    } catch (error) {
      steps.push({ step: name, wanted, before: 'unread', after: 'unread', changed: false, ok: false, error: message(error) });
    }
  };

  await step(
    async () => {
      await tools.setLocation(location);
      return {
        step: 'location',
        wanted: formatCoordinate(location),
        before: 'unreadable',
        after: LOCATION_UNREADABLE,
        changed: true,
        ok: true,
      };
    },
    'location',
    formatCoordinate(location),
  );

  await step(
    async () => {
      const before = await tools.nightMode();
      if (before === appearance) {
        return { step: 'appearance', wanted: appearance, before, after: before, changed: false, ok: true };
      }
      await tools.setNightMode(appearance);
      const after = await tools.nightMode();
      return {
        step: 'appearance',
        wanted: appearance,
        before: before ?? 'nothing',
        after: after ?? 'nothing',
        changed: true,
        ok: after === appearance,
      };
    },
    'appearance',
    appearance,
  );

  await step(
    async () => {
      const before = await readAnimations(tools);
      if (animationsOff(before)) {
        const shown = formatAnimations(before);
        return { step: 'animations', wanted: 'off', before: shown, after: shown, changed: false, ok: true };
      }
      for (const key of ANIMATION_SETTINGS) await tools.putGlobalSetting(key, '0');
      const after = await readAnimations(tools);
      return {
        step: 'animations',
        wanted: 'off',
        before: formatAnimations(before),
        after: formatAnimations(after),
        changed: true,
        ok: animationsOff(after),
      };
    },
    'animations',
    'off',
  );

  const report: HygieneReport = { udid: tools.serial, changed: steps.some(s => s.changed), steps };
  if (steps.some(s => !s.ok)) throw new HygieneError(report);
  return report;
}

export async function checkAndroidHygiene(tools: AdbTools, options: HygieneOptions = {}): Promise<HygieneCheck> {
  await requireEmulatorBooted(tools);
  const appearance = options.appearance ?? DEFAULT_APPEARANCE;
  const location = options.location ?? DEFAULT_FIXTURE_LOCATION;
  const checks: HygieneStepCheck[] = [
    { step: 'location', wanted: formatCoordinate(location), got: LOCATION_UNREADABLE, ok: true },
  ];
  try {
    const got = await tools.nightMode();
    checks.push({ step: 'appearance', wanted: appearance, got: got ?? 'nothing', ok: got === appearance });
  } catch (error) {
    checks.push({ step: 'appearance', wanted: appearance, got: `unreadable (${message(error)})`, ok: false });
  }
  try {
    const values = await readAnimations(tools);
    checks.push({ step: 'animations', wanted: 'off', got: formatAnimations(values), ok: animationsOff(values) });
  } catch (error) {
    checks.push({ step: 'animations', wanted: 'off', got: `unreadable (${message(error)})`, ok: false });
  }
  return { udid: tools.serial, ok: checks.every(c => c.ok), steps: checks };
}

/** Launch arguments as `am start` string extras: `-apiBaseUrl <url>` becomes `--es apiBaseUrl <url>`. */
export function intentExtras(launchArgs: readonly string[]): string[] {
  const extras: string[] = [];
  for (let i = 0; i < launchArgs.length; i += 2) {
    const key = (launchArgs[i] ?? '').replace(/^-+/, '');
    const value = launchArgs[i + 1];
    if (key === '' || value === undefined) continue;
    extras.push('--es', key, value);
  }
  return extras;
}

async function waitRunning(tools: AdbTools, pkg: string, what: string, attempts = 20, pollMs = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await tools.appRunning(pkg)) return;
    await tools.sleep(pollMs);
  }
  throw new DeviceStateError(`${pkg} is not running on ${tools.serial} after ${what}`);
}

export interface AndroidDevClientOptions {
  pkg: string;
  scheme: string;
  port: number;
  launchArgs?: readonly string[];
}

export interface AndroidLaunchReport {
  pkg: string;
  intent: string[];
}

/**
 * Opens an Expo dev client on the bundler with one VIEW intent: the dev-client link as its data and the launch
 * arguments as its extras. expo-dev-launcher hands that intent's extras on to the app's activity when it loads the
 * bundle; a separate launch followed by the link would lose them.
 */
export async function launchAndroidDevClient(tools: AdbTools, options: AndroidDevClientOptions): Promise<AndroidLaunchReport> {
  assertBundleId(options.pkg);
  assertScheme(options.scheme);
  await requireEmulatorBooted(tools);
  await requireAppInstalled(tools, options.pkg);
  const link = devClientLink({ scheme: options.scheme, port: options.port });
  const intent = ['-a', 'android.intent.action.VIEW', '-d', link, ...intentExtras(options.launchArgs ?? []), options.pkg];
  await tools.forceStop(options.pkg);
  await tools.start(intent);
  await waitRunning(tools, options.pkg, `opening ${link}`);
  return { pkg: options.pkg, intent };
}

export async function launchAndroidApp(
  tools: AdbTools,
  options: { pkg: string; launchArgs?: readonly string[] },
): Promise<AndroidLaunchReport> {
  await requireEmulatorBooted(tools);
  await requireAppInstalled(tools, options.pkg);
  const activity = await tools.launcherActivity(options.pkg);
  if (!activity) throw new DeviceStateError(`${options.pkg} has no launcher activity on ${tools.serial}`);
  const intent = ['-n', activity, ...intentExtras(options.launchArgs ?? [])];
  await tools.forceStop(options.pkg);
  await tools.start(intent);
  await waitRunning(tools, options.pkg, `starting ${activity}`);
  return { pkg: options.pkg, intent };
}

export interface ReverseReport {
  rules: Map<number, number>;
  added: number[];
}

/**
 * Makes each port reachable from the emulator: `adb reverse` forwards the emulator's own localhost:<device port> to the
 * Mac's <host port>, so an address such as http://localhost:<port> means the same server on the emulator as on the
 * simulator. Each emulator has its own table, so two emulators can use one device port for different hosts.
 */
export async function ensureReverse(tools: AdbTools, wanted: ReadonlyMap<number, number>): Promise<ReverseReport> {
  const current = await tools.reverses();
  const added: number[] = [];
  for (const [devicePort, hostPort] of wanted) {
    if (current.get(devicePort) === hostPort) continue;
    await tools.reverse(devicePort, hostPort);
    added.push(devicePort);
  }
  const rules = await tools.reverses();
  const missing = [...wanted].filter(([devicePort, hostPort]) => rules.get(devicePort) !== hostPort);
  if (missing.length > 0) {
    throw new DeviceStateError(
      `adb reverse on ${tools.serial} reads back without ${missing.map(([d, h]) => `tcp:${String(d)} -> tcp:${String(h)}`).join(', ')}`,
      `check 'adb -s ${tools.serial} reverse --list'`,
    );
  }
  return { rules, added };
}

export function describeReverse(wanted: ReadonlyMap<number, number>): string {
  return [...wanted]
    .map(([d, h]) => (d === h ? `localhost:${String(d)}` : `localhost:${String(d)} -> Mac ${String(h)}`))
    .join(', ');
}

const TRANSPORT_WAIT_MS = 30_000;
const TRANSPORT_POLL_MS = 500;

/**
 * Puts back the reverse rules an adb transport reset dropped, once the emulator answers again: adb keeps an emulator's
 * reverse rules on its transport, so a reset loses them. Resolves to the rules it had to add.
 */
export async function restoreReverse(
  tools: AdbTools,
  wanted: ReadonlyMap<number, number>,
  after: string,
): Promise<Map<number, number>> {
  for (let waited = 0; !(await tools.bootCompleted().catch(() => false)); waited += TRANSPORT_POLL_MS) {
    if (waited >= TRANSPORT_WAIT_MS) {
      throw new DeviceStateError(
        `the adb transport to ${tools.serial} reset ${after}, and the emulator did not come back online within ${String(TRANSPORT_WAIT_MS / 1000)} s`,
        `check that 'adb devices' lists ${tools.serial} as device`,
      );
    }
    await tools.sleep(TRANSPORT_POLL_MS);
  }
  const { added } = await ensureReverse(tools, wanted);
  return new Map([...wanted].filter(([devicePort]) => added.includes(devicePort)));
}

export function describeRestored(restored: ReadonlyMap<number, number>, serial: string, after: string): string {
  return `put back adb reverse ${describeReverse(restored)} on ${serial} ${after}, which an adb transport reset had dropped`;
}
