import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJdk17, installedMaestro, MAESTRO_OVERRIDE_ENV, sha256Of } from '../driver/install.ts';
import { MAESTRO_RELEASE } from '../driver/release.ts';
import type { HostInfo, MaestroInfo, ToolkitInfo } from './model.ts';
import type { LoadSample, Pressure } from './stats.ts';

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

function read(command: string, args: readonly string[], timeoutMs = 20_000): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function sysctl(name: string): string | null {
  return read('/usr/sbin/sysctl', ['-n', name]);
}

export function collectHost(): HostInfo {
  const runtimes: string[] = [];
  const listed = read('xcrun', ['simctl', 'list', 'runtimes', '-j'], 60_000);
  if (listed) {
    const parsed = JSON.parse(listed) as { runtimes?: { name?: string; buildversion?: string; isAvailable?: boolean }[] };
    for (const r of parsed.runtimes ?? []) {
      if (r.isAvailable !== false) runtimes.push(`${r.name ?? '?'} (${r.buildversion ?? '?'})`);
    }
  }
  const memsize = Number(sysctl('hw.memsize') ?? os.totalmem());
  const product = read('/usr/bin/sw_vers', ['-productVersion']);
  const build = read('/usr/bin/sw_vers', ['-buildVersion']);
  return {
    model: sysctl('hw.model') ?? 'unknown',
    chip: sysctl('machdep.cpu.brand_string') ?? os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGb: Math.round(memsize / 2 ** 30),
    macos: product ? `${product} (${build ?? '?'})` : `${os.type()} ${os.release()}`,
    xcode: (read('xcodebuild', ['-version']) ?? 'not found').replace(/\n/g, ', '),
    runtimes,
    node: process.version,
  };
}

const PRESSURE_LEVELS: Record<string, Pressure> = { '1': 'normal', '2': 'warn', '4': 'critical' };

export function parseSwapUsedMb(text: string | null): number | null {
  const used = text ? /used = ([\d.]+)M/.exec(text)?.[1] : undefined;
  return used === undefined ? null : Number(used);
}

export function parseFreePercent(text: string | null): number | null {
  const free = text ? /free percentage: (\d+)%/.exec(text)?.[1] : undefined;
  return free === undefined ? null : Number(free);
}

export function sampleLoad(): LoadSample {
  const [one = 0, five = 0, fifteen = 0] = os.loadavg();
  const level = sysctl('kern.memorystatus_vm_pressure_level');
  return {
    at: new Date().toISOString(),
    loadavg: [one, five, fifteen],
    pressure: (level === null ? undefined : PRESSURE_LEVELS[level]) ?? 'unknown',
    memoryFreePercent: parseFreePercent(read('/usr/bin/memory_pressure', ['-Q'])),
    swapUsedMb: parseSwapUsedMb(sysctl('vm.swapusage')),
  };
}

export function collectToolkit(): ToolkitInfo {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
  const commit = read('git', ['-C', PACKAGE_ROOT, 'rev-parse', 'HEAD']);
  const status = commit === null ? null : read('git', ['-C', PACKAGE_ROOT, 'status', '--porcelain', '--untracked-files=no']);
  return { version: manifest.version, commit, dirty: status === null ? null : status !== '' };
}

export async function collectMaestro(env: NodeJS.ProcessEnv): Promise<MaestroInfo> {
  const override = env[MAESTRO_OVERRIDE_ENV];
  const binary = override ?? installedMaestro(env)?.binary ?? null;
  let jarSha256: string | null = null;
  let binarySha256: string | null = null;
  let reportedVersion: string | null = null;
  if (binary && fs.existsSync(binary)) {
    binarySha256 = await sha256Of(binary);
    const lib = path.join(path.dirname(path.dirname(binary)), 'lib');
    const jar = fs.existsSync(lib) ? fs.readdirSync(lib).find(f => /^maestro-cli-.*\.jar$/.test(f)) : undefined;
    if (jar) jarSha256 = await sha256Of(path.join(lib, jar));
    const jdk = await findJdk17(env).catch(() => null);
    if (jdk) {
      const ran = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...env, JAVA_HOME: jdk.javaHome, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_DISABLE_UPDATE_CHECK: 'true' },
      });
      const line = ran.stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l !== '')
        .at(-1);
      if (ran.status === 0 && line) reportedVersion = line;
    }
  }
  return {
    version: MAESTRO_RELEASE.version,
    binary,
    override: override !== undefined,
    releaseSha256: MAESTRO_RELEASE.sha256,
    binarySha256,
    jarSha256,
    reportedVersion,
  };
}
