import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { namedDataDir } from '../../src/driver/install.ts';
import { commandLinesOf, compareVersions, removeOlderVersions, type RemoveOptions } from '../../src/driver/superseded.ts';
import type { ProcessTable } from '../../src/processes.ts';
import { runningCommands, tempDir } from '../support/fakes.ts';

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

test('a process table that does not show pid 1, or shows it without its arguments, counts as unreadable', () => {
  assert.equal(commandLinesOf('  412 /usr/bin/node cli.js\n  413 sleep 30\n'), undefined);
  assert.equal(commandLinesOf(''), undefined);
  assert.equal(commandLinesOf('    1 (launchd)\n  412 /usr/bin/node cli.js\n'), undefined);
  assert.deepEqual(commandLinesOf('    1 /sbin/launchd\n  412 /usr/bin/node cli.js\n  999 \n'), [
    { pid: 1, args: '/sbin/launchd' },
    { pid: 412, args: '/usr/bin/node cli.js' },
  ]);
});

const nobody: ProcessTable = { startTimes: () => new Map(), info: () => undefined, cwd: () => undefined };

function options(root: string | undefined, lines: string[]): RemoveOptions {
  return {
    root,
    me: { pid: process.pid, start: 'me' },
    processes: nobody,
    commandLines: () => [],
    laneTools: () => [],
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
      commandLines: runningCommands(`node ${used ?? ''}/package/cli.js daemon`),
      laneTools: () => [[`#!/bin/sh\nmaestro='${shim}/bin/tool'\n`]],
    },
  );
  assert.deepEqual(removed.sort(), [unused, forUnused].sort(), lines.join('\n'));
  assert.ok(lines.includes(`kept ${forUsed ?? ''}, which a kept version runs`), lines.join('\n'));
  assert.ok(lines.includes(`kept ${shim}, which a lane that is up runs`), lines.join('\n'));
});

test("a launcher's needs stay while a process or lane file runs it without naming what it launches, judged for each", () => {
  const root = fs.realpathSync(tempDir('superseded-launcher'));
  const [launched, other] = ['shell-1', 'shell-0'].map(name => version(path.join(root, 'browsers'), name));
  const tool = path.join(root, 'tool');
  const binary = path.join(tool, '1.0.0', 'bin', 'tool');
  const launcher = { dir: tool, launches: [launched ?? ''], variable: 'EXECUTABLE', needs: [launched ?? '', other ?? ''] };
  const run = (commands: string[], lanes: string[][]) => {
    const lines: string[] = [];
    const removed = removeOlderVersions([{ dir: launched ?? '' }, { dir: other ?? '' }], {
      ...options(root, lines),
      commandLines: runningCommands(...commands),
      laneTools: () => lanes,
      launchers: [launcher],
      log: line => lines.push(line),
    });
    for (const dir of removed) fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    return { removed, lines };
  };
  const naming = `exec ${binary}\nEXECUTABLE=${launched ?? ''}/bin/tool`;
  assert.deepEqual(run([], [[naming]]).removed, [other], 'a lane file that names what it launches keeps only that');
  assert.deepEqual(run([], [[naming], [`exec ${binary}`]]).removed, [], 'another file that names nothing keeps both');
  assert.deepEqual(run([`${binary} daemon`], [[naming]]).removed, [], 'so does a running process');
  assert.deepEqual(run([`exec ${binary}`, `${launched ?? ''}/bin/tool --headless`], []).removed, [], 'judged per process');
  const { lines } = run([`${binary} daemon`], []);
  assert.ok(lines.includes(`kept ${other ?? ''}, which tool may run`), lines.join('\n'));
});

test('a running process whose environment names what a launcher launches keeps that, and one whose environment says nothing keeps every need', () => {
  const root = fs.realpathSync(tempDir('superseded-environment'));
  const [launched, other] = ['shell-1', 'shell-0'].map(name => version(path.join(root, 'browsers'), name));
  const tool = path.join(root, 'tool');
  const binary = path.join(tool, '1.0.0', 'bin', 'tool');
  const launcher = {
    dir: tool,
    launches: [launched ?? '', other ?? ''],
    variable: 'EXECUTABLE',
    needs: [launched ?? '', other ?? ''],
  };
  const run = (environment: string | undefined) => {
    const lines: string[] = [];
    const read: string[] = [];
    const removed = removeOlderVersions([{ dir: launched ?? '' }, { dir: other ?? '' }], {
      ...options(root, lines),
      commandLines: () => [
        {
          args: `${binary} --session lane`,
          environment: () => {
            read.push('daemon');
            return environment;
          },
        },
        {
          args: '/bin/sleep 30',
          environment: () => {
            read.push('sleep');
            return undefined;
          },
        },
      ],
      launchers: [launcher],
    });
    for (const dir of removed) fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    return { removed, lines, read };
  };
  const named = run(`${binary} --session lane PATH=/bin EXECUTABLE=${launched ?? ''}/bin/tool HOME=/h`);
  assert.deepEqual(named.removed, [other], named.lines.join('\n'));
  assert.ok(named.lines.includes(`kept ${launched ?? ''}, which a running tool launches`), named.lines.join('\n'));
  assert.deepEqual(named.read, ['daemon'], 'only a process that runs the launcher has its environment read');
  assert.deepEqual(
    run(`EXECUTABLE=${launched ?? ''}/bin/tool`).removed,
    [other],
    'an environment read from /proc, with no command before it',
  );
  for (const environment of [
    undefined,
    `${binary} --session lane`,
    'PATH=/bin',
    `XEXECUTABLE=${launched ?? ''}/bin/tool`,
    `EXECUTABLE=${launched ?? ''}0/bin/tool`,
  ]) {
    const { removed, lines } = run(environment);
    assert.deepEqual(removed, [], `${environment ?? 'unreadable'}\n${lines.join('\n')}`);
    assert.ok(lines.includes(`kept ${other ?? ''}, which tool may run`), lines.join('\n'));
  }
});

test('a registry that cannot say whether a lane uses a version keeps every version', () => {
  const root = fs.realpathSync(tempDir('superseded-registry'));
  const old = version(path.join(root, 'maestro'), '1.0.0');
  const lines: string[] = [];
  assert.deepEqual(removeOlderVersions([{ dir: old }], { ...options(root, lines), laneTools: () => undefined }), []);
  assert.equal(fs.existsSync(old), true);
  assert.match(lines.join('\n'), /a registry could not say whether a lane uses them/);
});
