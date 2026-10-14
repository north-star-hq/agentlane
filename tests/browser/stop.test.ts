import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { browserPaths } from '../../src/browser/paths.ts';
import {
  browserProcesses,
  onProfile,
  stopBrowserProcesses,
  type BrowserProcessSystem,
  type ProcessEntry,
} from '../../src/browser/stop.ts';
import type { Clock } from '../../src/clock.ts';
import { tempDir } from '../support/fakes.ts';

const LANE = 'aaaa1111';
const OTHER = 'bbbb2222';
const SESSION = `agentlane-${LANE}`;

function steppingClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: ms => {
      t += ms;
      return Promise.resolve();
    },
  };
}

class Table implements BrowserProcessSystem {
  readonly entries: ProcessEntry[];
  readonly env = new Map<number, string>();
  readonly sent: string[] = [];
  readonly ignoresTerm = new Set<number>();
  readonly unkillable = new Set<number>();

  constructor(entries: ProcessEntry[]) {
    this.entries = entries;
  }

  list(): ProcessEntry[] {
    return this.entries.map(e => ({ ...e }));
  }

  environment(pid: number): string | undefined {
    return this.env.get(pid);
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.sent.push(`${String(pid)} ${signal}`);
    if (this.unkillable.has(pid) || (signal === 'SIGTERM' && this.ignoresTerm.has(pid))) return;
    const at = this.entries.findIndex(e => e.pid === pid);
    if (at !== -1) this.entries.splice(at, 1);
  }
}

function entry(pid: number, ppid: number, args: string): ProcessEntry {
  return { pid, ppid, pgid: ppid === 1 ? pid : ppid, args };
}

function machine(state: string) {
  const mine = browserPaths(state, LANE, SESSION);
  const theirs = browserPaths(state, OTHER, `agentlane-${OTHER}`);
  const table = new Table([
    entry(100, 1, `node /pw/lib/tools/cli-client/cliDaemon.js ${SESSION}`),
    entry(101, 100, `/b/Google Chrome for Testing --user-data-dir=${mine.profile} --remote-debugging-port=41400`),
    entry(102, 101, '/b/Google Chrome for Testing Helper --type=renderer'),
    entry(103, 102, '/b/Google Chrome for Testing Helper --type=gpu-process'),
    entry(200, 1, `node /pw/lib/tools/cli-client/cliDaemon.js agentlane-${OTHER}`),
    entry(201, 200, `/b/Google Chrome for Testing --user-data-dir=${theirs.profile} --remote-debugging-port=41401`),
    entry(300, 1, `/b/Google Chrome for Testing --user-data-dir=${mine.profile}-old`),
    entry(400, 1, 'node /pw/lib/tools/cli-client/cliDaemon.js default'),
    entry(500, 1, '/ab/bin/agent-browser-darwin-arm64'),
    entry(501, 500, `/b/Google Chrome for Testing --user-data-dir=${mine.profile}`),
    entry(600, 1, '/ab/bin/agent-browser-darwin-arm64'),
    entry(601, 1, '/ab/bin/agent-browser-darwin-arm64'),
  ]);
  table.env.set(
    600,
    `AGENT_BROWSER_DAEMON=1 AGENT_BROWSER_SESSION=${SESSION} AGENT_BROWSER_SOCKET_DIR=${mine.agentBrowserSockets}`,
  );
  table.env.set(601, `AGENT_BROWSER_DAEMON=1 AGENT_BROWSER_SESSION=${SESSION} AGENT_BROWSER_SOCKET_DIR=/somewhere/else`);
  return { mine, table, marks: { session: SESSION, paths: mine } };
}

test("the sweep finds a lane's browser, its helpers and its driver daemons from the process table, and nothing of another lane's", () => {
  const { table, marks } = machine(tempDir('stop'));
  const found = browserProcesses(table, marks, 999_999)
    ?.map(e => e.pid)
    .sort((a, b) => a - b);
  assert.deepEqual(found, [100, 101, 102, 103, 500, 501, 600]);
});

test("agent-browser's daemon is found by the pid file in the lane's socket folder", t => {
  const state = tempDir('stop');
  const { mine, table, marks } = machine(state);
  t.after(() => {
    for (const dir of [mine.agentBrowserSockets, state]) fs.rmSync(dir, { recursive: true, force: true });
  });
  table.entries.push(entry(700, 1, '/ab/bin/agent-browser-darwin-arm64'));
  fs.mkdirSync(mine.agentBrowserSockets, { recursive: true });
  fs.writeFileSync(path.join(mine.agentBrowserSockets, `${SESSION}.pid`), '700\n');
  assert.ok(browserProcesses(table, marks, 999_999)?.some(e => e.pid === 700));
});

test('the sweep spares the process running it and its ancestors', () => {
  const { table, marks } = machine(tempDir('stop'));
  assert.equal(
    browserProcesses(table, marks, 102)?.some(e => [100, 101, 102].includes(e.pid)),
    false,
  );
});

test('a stop sends SIGTERM, then SIGKILL to what outlives the grace period, and reports what survives', async () => {
  const { table, marks } = machine(tempDir('stop'));
  table.ignoresTerm.add(101);
  const stopped = await stopBrowserProcesses(table, marks, steppingClock(), 3000);
  assert.deepEqual(stopped.left, []);
  assert.ok(table.sent.includes('101 SIGTERM') && table.sent.includes('101 SIGKILL'), table.sent.join(', '));
  assert.equal(table.sent.includes('201 SIGTERM'), false, "the stop signalled another lane's browser");
  assert.deepEqual(
    table.entries.map(e => e.pid).sort((a, b) => a - b),
    [200, 201, 300, 400, 601],
  );

  const again = machine(tempDir('stop'));
  again.table.unkillable.add(501);
  const stuck = await stopBrowserProcesses(again.table, again.marks, steppingClock(), 3000);
  assert.deepEqual(
    stuck.left?.map(e => e.pid),
    [501],
  );
});

test('an unreadable process table is reported, not taken as nothing running', async () => {
  const { marks } = machine(tempDir('stop'));
  const blind: BrowserProcessSystem = { list: () => undefined, environment: () => undefined, signal: () => undefined };
  assert.deepEqual(await stopBrowserProcesses(blind, marks, steppingClock()), { stopped: [], left: undefined });
});

test('the profile flag matches its folder exactly', () => {
  assert.equal(onProfile('chrome --user-data-dir=/a/profile --x', '/a/profile'), true);
  assert.equal(onProfile('chrome --user-data-dir=/a/profile', '/a/profile'), true);
  assert.equal(onProfile('chrome --user-data-dir=/a/profile2 --x', '/a/profile'), false);
  assert.equal(onProfile('chrome --user-data-dir=/a/profile-old --user-data-dir=/a/profile', '/a/profile'), true);
});
