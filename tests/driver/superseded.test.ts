import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { namedDataDir } from '../../src/driver/install.ts';
import { commandLinesOf, compareVersions, removeOlderVersions, type RemoveOptions } from '../../src/driver/superseded.ts';
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

test('a prerelease orders before its release, and the toolkit’s own builds after it, the later name and number last', () => {
  assert.ok(compareVersions('1.65.0-alpha-1767000000000', '1.65.0') < 0);
  assert.ok(compareVersions('1.65.0', '1.65.0-alpha-1767000000000') > 0);
  assert.ok(compareVersions('1.65.0-alpha-1767000000000', '1.64.0') > 0);
  assert.ok(compareVersions('1.65.0-alpha.2', '1.65.0-alpha.10') < 0);
  assert.ok(compareVersions('1.65.0-alpha', '1.65.0-beta') < 0);
  const sorted = ['2.11.0-agentlane.1', '2.12.1-agentlane.1', '2.11.0-agentenv.3', '2.11.0-agentlane.2', '2.11.0', '2.11.0-rc.1'];
  assert.deepEqual(sorted.sort(compareVersions), [
    '2.11.0-rc.1',
    '2.11.0',
    '2.11.0-agentenv.3',
    '2.11.0-agentlane.1',
    '2.11.0-agentlane.2',
    '2.12.1-agentlane.1',
  ]);
  assert.ok(compareVersions('2.11.0-agentenv.10', '2.11.0-agentenv.9') > 0);
  assert.ok(compareVersions('2.12.1-agentenv.1', '2.11.0-agentlane.9') > 0);
});

test('a process table that does not show pid 1 counts as unreadable', () => {
  assert.equal(commandLinesOf('  412 /usr/bin/node cli.js\n  413 sleep 30\n'), undefined);
  assert.equal(commandLinesOf(''), undefined);
  assert.deepEqual(commandLinesOf('    1 /sbin/launchd\n  412 /usr/bin/node cli.js\n  999 \n'), [
    '/sbin/launchd',
    '/usr/bin/node cli.js',
  ]);
});

const nobody: ProcessTable = { startTimes: () => new Map(), info: () => undefined, cwd: () => undefined };

function options(root: string | undefined, lines: string[]): RemoveOptions {
  return {
    root,
    me: { pid: process.pid, start: 'me' },
    processes: nobody,
    commandLines: () => [],
    laneMaestros: () => [],
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

test('a version kept for any reason keeps the folders it needs, and one removed does not', () => {
  const root = fs.realpathSync(tempDir('superseded-needs'));
  const browser = (name: string) => version(path.join(root, 'browsers'), name);
  const [used, locked, unused] = ['1.0.0', '1.0.1', '1.0.2'].map(name => version(path.join(root, 'core'), name));
  const [forUsed, forLocked, forUnused, forShim] = ['chromium-1', 'chromium-2', 'chromium-3', 'chromium-4'].map(browser);
  const shim = version(path.join(root, 'core'), '1.0.3');
  const lockDir = path.join(root, 'core', '.1.0.1.lock');
  fs.writeFileSync(lockDir, JSON.stringify({ pid: 999_999, start: 'other' }));
  const lines: string[] = [];
  const removed = removeOlderVersions(
    [
      { dir: forUsed ?? '' },
      { dir: forLocked ?? '' },
      { dir: forUnused ?? '' },
      { dir: forShim ?? '' },
      { dir: used ?? '', needs: [forUsed ?? ''] },
      { dir: locked ?? '', lock: lockDir, needs: [forLocked ?? ''] },
      { dir: unused ?? '', needs: [forUnused ?? ''] },
      { dir: shim, needs: [forShim ?? ''] },
    ],
    {
      ...options(root, lines),
      processes: { startTimes: () => new Map([[999_999, 'other']]), info: () => undefined, cwd: () => undefined },
      commandLines: () => [`node ${used ?? ''}/package/cli.js daemon`],
      laneMaestros: () => [`#!/bin/sh\nmaestro='${shim}/bin/tool'\n`],
    },
  );
  assert.deepEqual(removed.sort(), [unused, forUnused].sort(), lines.join('\n'));
  assert.ok(lines.includes(`kept ${forUsed ?? ''}, which a kept version runs`), lines.join('\n'));
  assert.ok(lines.includes(`kept ${shim}, which a lane that is up runs`), lines.join('\n'));
});

test('a registry that cannot say whether a lane uses a version keeps every version', () => {
  const root = fs.realpathSync(tempDir('superseded-registry'));
  const old = version(path.join(root, 'maestro'), '1.0.0');
  const lines: string[] = [];
  assert.deepEqual(removeOlderVersions([{ dir: old }], { ...options(root, lines), laneMaestros: () => undefined }), []);
  assert.equal(fs.existsSync(old), true);
  assert.match(lines.join('\n'), /a registry could not say whether a lane uses them/);
});
