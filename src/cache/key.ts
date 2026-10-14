import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { CacheInput, FilesInput } from './config.ts';
import { inputsFor } from './config.ts';

const execFileAsync = promisify(execFile);

const KEY_SCHEMA = 'build-cache-key v1';
const HASH_CONCURRENCY = 32;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER = 256 * 1024 * 1024;

export interface KeyOptions {
  root: string;
  inputs: CacheInput[];
  platform: string;
  variant: string;
  toolchain: string;
  envFile?: string;
  env?: NodeJS.ProcessEnv;
}

export class CacheKeyError extends Error {
  override name = 'CacheKeyError';
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { code, signal, stderr } = error as { code?: unknown; signal?: unknown; stderr?: unknown };
  const status =
    typeof code === 'number' ? `exit code ${String(code)}` : typeof signal === 'string' ? `killed by ${signal}` : error.message;
  const detail = (typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '').trim();
  return detail ? `${status}: ${detail.slice(-2000)}` : status;
}

async function listFiles(root: string, input: FilesInput): Promise<string[]> {
  const pathspecs = [...input.paths.map(p => `:(glob)${p}`), ...(input.exclude ?? []).map(p => `:(exclude,glob)${p}`)];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
      { maxBuffer: COMMAND_MAX_BUFFER },
    ));
  } catch (error) {
    throw new CacheKeyError(`listing the files input ${JSON.stringify(input.paths)} failed: ${errorText(error)}`);
  }
  const names = [...new Set(stdout.split('\0').filter(name => name.length > 0))];
  return names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

async function describeFile(root: string, name: string): Promise<string> {
  const full = path.join(root, name);
  let stat;
  try {
    stat = await fs.lstat(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `deleted ${name}`;
    throw error;
  }
  if (stat.isSymbolicLink()) return `link ${sha256(await fs.readlink(full))} ${name}`;
  if (stat.isDirectory()) return `dir ${name}`;
  const exec = (stat.mode & 0o111) !== 0 ? 'x' : '-';
  return `file${exec} ${await sha256File(full)} ${name}`;
}

async function hashFiles(root: string, input: FilesInput): Promise<string> {
  const names = await listFiles(root, input);
  const lines: string[] = [];
  for (let i = 0; i < names.length; i += HASH_CONCURRENCY) {
    lines.push(...(await Promise.all(names.slice(i, i + HASH_CONCURRENCY).map(name => describeFile(root, name)))));
  }
  return sha256(lines.join('\n'));
}

async function hashCommand(root: string, run: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', run], {
      cwd: root,
      ...(env ? { env } : {}),
      encoding: 'buffer',
      maxBuffer: COMMAND_MAX_BUFFER,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return sha256(stdout);
  } catch (error) {
    throw new CacheKeyError(`the command input ${JSON.stringify(run)} failed: ${errorText(error)}`);
  }
}

async function hashEnvFile(root: string, envFile: string | undefined): Promise<string> {
  if (envFile === undefined) return 'none';
  try {
    return await sha256File(path.resolve(root, envFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw new CacheKeyError(`reading the env file ${envFile} failed: ${errorText(error)}`);
  }
}

async function hashInput(root: string, input: CacheInput, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  return input.kind === 'files' ? hashFiles(root, input) : hashCommand(root, input.run, env);
}

export async function computeKey(options: KeyOptions): Promise<string> {
  const lines = [
    KEY_SCHEMA,
    `platform=${JSON.stringify(options.platform)}`,
    `variant=${JSON.stringify(options.variant)}`,
    `toolchain=${JSON.stringify(options.toolchain)}`,
    `env=${await hashEnvFile(options.root, options.envFile)}`,
  ];
  const inputs = inputsFor(options.inputs, options.platform);
  const digests = await Promise.all(inputs.map(input => hashInput(options.root, input, options.env)));
  inputs.forEach((input, i) => {
    lines.push(`input=${JSON.stringify(input)} ${digests[i] ?? ''}`);
  });
  return sha256(lines.join('\n'));
}

export const ANDROID_SDK_PACKAGE_DIRS = ['build-tools', 'platforms', 'ndk', 'cmake'] as const;
export const GRADLE_WRAPPER_PROPERTIES = 'android/gradle/wrapper/gradle-wrapper.properties';

export interface AndroidToolchainOptions {
  root: string;
  javaHome: string;
  sdkRoot: string;
}

async function javaVersionText(javaHome: string): Promise<string> {
  const java = path.join(javaHome, 'bin', 'java');
  try {
    const { stdout, stderr } = await execFileAsync(java, ['-version'], { timeout: COMMAND_TIMEOUT_MS });
    return `${stderr}${stdout}`
      .trim()
      .split(/\s*\n\s*/)
      .join(' ');
  } catch (error) {
    throw new CacheKeyError(`${java} -version failed: ${errorText(error)}`);
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function packageRevision(dir: string): Promise<string> {
  try {
    const properties = await fs.readFile(path.join(dir, 'source.properties'), 'utf8');
    return /^Pkg\.Revision\s*=(.*)$/m.exec(properties)?.[1]?.trim() ?? 'unknown';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'unknown';
    throw error;
  }
}

async function sdkPackages(sdkRoot: string): Promise<string[]> {
  const lines: string[] = [];
  for (const kind of ANDROID_SDK_PACKAGE_DIRS) {
    for (const name of await subdirectories(path.join(sdkRoot, kind))) {
      lines.push(`${kind}/${name} ${await packageRevision(path.join(sdkRoot, kind, name))}`);
    }
  }
  return lines;
}

async function gradleWrapper(root: string): Promise<string> {
  const listed = await listFiles(root, { kind: 'files', paths: [GRADLE_WRAPPER_PROPERTIES] });
  if (listed.length === 0) return 'generated by the build';
  const properties = await fs.readFile(path.join(root, GRADLE_WRAPPER_PROPERTIES), 'utf8');
  return /^distributionUrl=(.*)$/m.exec(properties)?.[1]?.trim() ?? 'no distributionUrl';
}

/**
 * The Android toolchain part of a build cache key: the JDK's version, the Gradle distribution the project's wrapper
 * pins when the wrapper is a project file (a git-ignored one, generated by the build, follows the project's inputs),
 * and the revision of every installed SDK build-tools, platform, NDK and CMake package.
 */
export async function androidToolchain(options: AndroidToolchainOptions): Promise<string> {
  const [java, gradle, packages] = await Promise.all([
    javaVersionText(options.javaHome),
    gradleWrapper(options.root),
    sdkPackages(options.sdkRoot),
  ]);
  return [`jdk ${java}`, `gradle ${gradle}`, `sdk ${packages.join(', ')}`].join('; ');
}

export async function xcodeVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('xcodebuild', ['-version'], { timeout: COMMAND_TIMEOUT_MS });
    return stdout
      .trim()
      .split(/\s*\n\s*/)
      .join(' ');
  } catch (error) {
    throw new CacheKeyError(`xcodebuild -version failed: ${errorText(error)}`);
  }
}
