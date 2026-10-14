import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { envName, TOOL } from '../name.ts';
import { jsonObjectAt } from './claude-plugin.ts';

export const PACKAGE_MANAGERS = ['pnpm', 'yarn', 'bun', 'npm'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const PACKAGE_SPEC_ENV = envName('INIT_PACKAGE');

export interface InstallCommand {
  program: string;
  args: string[];
}

export type Installer = (command: InstallCommand, cwd: string) => { ok: true } | { ok: false; problem: string };

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

export function toolVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

function isPackageManager(name: string): name is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(name);
}

export interface ManagerChoice {
  manager: PackageManager;
  source: string;
  classicYarn: boolean;
}

function folders(from: string, top: string): string[] {
  const out = [from];
  let dir = from;
  while (dir !== top && path.dirname(dir) !== dir && dir.startsWith(`${top}${path.sep}`)) {
    dir = path.dirname(dir);
    out.push(dir);
  }
  return out;
}

function classicYarn(dir: string, field: string | null): boolean {
  if (field !== null) return field.startsWith('yarn@1.');
  try {
    return fs.readFileSync(path.join(dir, 'yarn.lock'), 'utf8').slice(0, 200).includes('yarn lockfile v1');
  } catch {
    return false;
  }
}

export function packageManagerOf(packageDir: string, top: string, env: NodeJS.ProcessEnv): ManagerChoice {
  for (const dir of folders(packageDir, top)) {
    const field = jsonObjectAt(path.join(dir, 'package.json'))?.packageManager;
    if (typeof field === 'string') {
      const name = field.split('@', 1)[0] ?? '';
      if (isPackageManager(name))
        return {
          manager: name,
          source: `the packageManager field in ${path.relative(packageDir, path.join(dir, 'package.json'))} says ${name}`,
          classicYarn: classicYarn(dir, field),
        };
    }
    for (const [lockfile, manager] of LOCKFILES)
      if (fs.existsSync(path.join(dir, lockfile)))
        return {
          manager,
          source: `${path.relative(packageDir, path.join(dir, lockfile))} is its lockfile`,
          classicYarn: manager === 'yarn' && classicYarn(dir, null),
        };
  }
  const agent = /^(\w+)\//.exec(env.npm_config_user_agent ?? '')?.[1] ?? '';
  if (isPackageManager(agent)) return { manager: agent, source: `${agent} ran init`, classicYarn: false };
  return { manager: 'npm', source: 'no lockfile or packageManager field names another', classicYarn: false };
}

export function addCommand(choice: ManagerChoice, packageDir: string, spec: string): InstallCommand {
  const manifest = jsonObjectAt(path.join(packageDir, 'package.json'));
  switch (choice.manager) {
    case 'pnpm': {
      const workspaceRoot = fs.existsSync(path.join(packageDir, 'pnpm-workspace.yaml'));
      return { program: 'pnpm', args: ['add', '--save-dev', ...(workspaceRoot ? ['--workspace-root'] : []), spec] };
    }
    case 'yarn': {
      const workspaceRoot = choice.classicYarn && manifest?.workspaces !== undefined;
      return { program: 'yarn', args: ['add', '--dev', ...(workspaceRoot ? ['--ignore-workspace-root-check'] : []), spec] };
    }
    case 'bun':
      return { program: 'bun', args: ['add', '--dev', spec] };
    case 'npm':
      return { program: 'npm', args: ['install', '--save-dev', spec] };
  }
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function shellLine(command: InstallCommand): string {
  return [command.program, ...command.args].map(quote).join(' ');
}

export function nearestPackage(root: string, top: string): string | null {
  for (const dir of folders(root, top)) if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  return null;
}

export function listedRange(packageDir: string): string | null {
  const manifest = jsonObjectAt(path.join(packageDir, 'package.json'));
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest?.[field];
    if (typeof deps === 'object' && deps !== null && TOOL in deps) {
      const range = (deps as Record<string, unknown>)[TOOL];
      return typeof range === 'string' ? range : '';
    }
  }
  return null;
}

export function installedVersion(packageDir: string): string | null {
  const version = jsonObjectAt(path.join(packageDir, 'node_modules', TOOL, 'package.json'))?.version;
  return typeof version === 'string' ? version : null;
}

export const realInstaller: Installer = (command, cwd) => {
  const result = spawnSync(command.program, command.args, { cwd, stdio: ['ignore', process.stderr, process.stderr] });
  if (result.error) return { ok: false, problem: result.error.message };
  if (result.status !== 0)
    return { ok: false, problem: result.signal ? `killed by ${result.signal}` : `exit ${String(result.status)}` };
  return { ok: true };
};
