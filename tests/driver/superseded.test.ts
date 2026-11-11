import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { namedDataDir } from '../../src/driver/install.ts';
import { compareVersions, removeOlderVersions, type RemoveOptions } from '../../src/driver/superseded.ts';
import type { ProcessTable } from '../../src/processes.ts';
import { tempDir } from '../support/fakes.ts';

test('versions order by their parts, numbers as numbers', () => {
  const sorted = ['2.11.0-agentlane.2', '2.9.0', '2.11.0-agentlane.1', '2.12.1-agentlane.1', '2.11.0', '1.64.0', '1300', '1248'];
  assert.deepEqual(sorted.sort(compareVersions), [
    '1.64.0',
    '2.9.0',
    '2.11.0',
    '2.11.0-agentlane.1',
    '2.11.0-agentlane.2',
    '2.12.1-agentlane.1',
    '1248',
    '1300',
  ]);
  assert.equal(compareVersions('2.11.0-agentlane.1', '2.11.0-agentlane.1'), 0);
});

const nobody: ProcessTable = { startTimes: () => new Map(), info: () => undefined, cwd: () => undefined };

function options(root: string | undefined, lines: string[]): RemoveOptions {
  return {
    root,
    me: { pid: process.pid, start: 'me' },
    processes: nobody,
    commandLines: () => [],
    log: line => lines.push(line),
  };
}

function version(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'tool'), '');
  return dir;
}

test('an environment that names no data folder, by HOME or XDG_DATA_HOME, removes nothing', () => {
  assert.equal(namedDataDir({}), undefined);
  assert.equal(namedDataDir({ XDG_DATA_HOME: 'relative/data' }), undefined);
  assert.equal(namedDataDir({ HOME: '/home/x' }), path.join('/home/x', '.local', 'share', 'agentlane'));
  assert.equal(namedDataDir({ XDG_DATA_HOME: '/data' }), path.join('/data', 'agentlane'));
  const root = fs.realpathSync(tempDir('superseded'));
  const old = version(path.join(root, 'maestro'), '1.0.0');
  const lines: string[] = [];
  assert.deepEqual(removeOlderVersions([{ dir: old }], options(namedDataDir({ PATH: '/bin' }), lines)), []);
  assert.equal(fs.existsSync(old), true);
  assert.match(lines.join('\n'), /neither HOME nor XDG_DATA_HOME is set/);
});

test('a version outside the install root, or reached through a link out of it, is never removed', () => {
  const root = fs.realpathSync(tempDir('superseded-root'));
  const elsewhere = fs.realpathSync(tempDir('superseded-elsewhere'));
  const outside = version(elsewhere, '1.0.0');
  const linked = path.join(root, 'maestro', '1.0.1');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(version(elsewhere, '1.0.1'), linked);
  const inside = version(path.join(root, 'maestro'), '1.0.2');
  const removed = removeOlderVersions([{ dir: outside }, { dir: linked }, { dir: inside }, { dir: root }], options(root, []));
  assert.deepEqual(removed, [inside]);
  assert.equal(fs.existsSync(path.join(outside, 'bin', 'tool')), true);
  assert.equal(fs.existsSync(path.join(elsewhere, '1.0.1', 'bin', 'tool')), true);
  assert.equal(fs.existsSync(root), true);
});
