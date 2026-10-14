import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

export const CLOCK = new Date('2026-03-01T12:00:00.000Z');

export function tempDir(t: TestContext, prefix = 'cache-test-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

export function makeOutput(dir: string, name: string, tag: string, files = 20): string {
  const output = path.join(dir, name);
  for (let i = 0; i < files; i += 1) writeFiles(output, { [`part-${String(i)}/file.txt`]: `${tag}\n` });
  writeFiles(output, { 'Info.plist': `${tag}\n` });
  return output;
}

export function readOutput(output: string): { tags: Set<string>; files: number } {
  const tags = new Set<string>();
  let files = 0;
  for (const entry of fs.readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    tags.add(fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'));
    files += 1;
  }
  return { tags, files };
}

export function snapshot(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .map(entry => {
      const full = path.join(entry.parentPath, entry.name);
      const stat = fs.lstatSync(full);
      return `${path.relative(root, full)} ${String(stat.mtimeMs)} ${String(stat.size)}`;
    })
    .sort();
}
