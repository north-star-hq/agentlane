import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { ProcessInfo, ProcessTable } from '../src/processes.ts';
import { identityOf, systemProcesses } from '../src/processes.ts';
import { DEFAULT_CONFIG } from '../src/registry/config.ts';
import type { Owner } from '../src/registry/owner.ts';
import { judgeProcess, ownerKey, ownerState, resolveOwner, worktreeState } from '../src/registry/owner.ts';
import { tcpProbe } from '../src/registry/ports.ts';
import { readRegistryStatus, Registry } from '../src/registry/registry.ts';
import { UsageError } from '../src/registry/refusal.ts';
import { FakeProcesses, tempDir } from './support/fakes.ts';
import { portBlock } from './support/ports.ts';

const PORTS = await portBlock();

test('a recycled pid (same pid, different start time) is pid-reused, not alive', () => {
  const procs = new FakeProcesses();
  const owner = procs.spawn();
  assert.equal(judgeProcess(owner, procs.startTimes([owner.pid])), 'alive');
  procs.recycle(owner.pid);
  assert.equal(judgeProcess(owner, procs.startTimes([owner.pid])), 'pid-reused');
  procs.kill(owner.pid);
  assert.equal(judgeProcess(owner, procs.startTimes([owner.pid])), 'dead');
  assert.equal(judgeProcess(owner, undefined), 'cant-tell');
  assert.equal(judgeProcess(null, procs.startTimes([owner.pid])), 'cant-tell');
});

test('a gone worktree is proven even for a live owner, but a dead or reused owner is reported as such', () => {
  const missing = path.join(tempDir('owner'), 'gone');
  assert.equal(worktreeState(missing), 'gone');
  assert.equal(ownerState('alive', 'gone'), 'worktree-gone');
  assert.equal(ownerState('cant-tell', 'gone'), 'worktree-gone');
  assert.equal(ownerState('dead', 'gone'), 'dead');
  assert.equal(ownerState('pid-reused', 'present'), 'pid-reused');
  assert.equal(ownerState('cant-tell', 'unknown'), 'cant-tell');
});

test('a lane recorded for a short-lived real process is classified dead once that process exits', async () => {
  const dir = tempDir('real-dead');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const pid = child.pid ?? 0;
    const identity = identityOf(systemProcesses, pid);
    assert.ok(identity, 'ps reads the child start time');
    const owner: Owner = { kind: 'process', process: identity, sessionId: null, threadId: null };
    const registry = Registry.open({
      dir,
      processes: systemProcesses,
      ports: tcpProbe,
      config: { ...DEFAULT_CONFIG, poolSize: 1, blocks: { metro: { first: PORTS, last: PORTS + 9 } } },
    });
    try {
      await registry.claim({
        owner,
        worktree: dir,
        projectRoot: dir,
        services: [{ name: 'metro', type: 'metro' }],
        device: null,
        waitMs: 0,
      });
      assert.equal(registry.status().lanes[0]?.ownerState, 'alive');
    } finally {
      registry.close();
    }
    child.kill('SIGKILL');
    await exited;
    const status = readRegistryStatus({ dir, processes: systemProcesses });
    assert.equal(status.lanes[0]?.ownerState, 'dead');
  } finally {
    child.kill('SIGKILL');
  }
});

test('ps lookups: an exited pid is absent rather than unreadable, and this process is present', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  const gone = child.pid ?? 0;
  const table = systemProcesses.startTimes([process.pid, gone]);
  assert.ok(table);
  assert.equal(table.has(gone), false);
  assert.match(table.get(process.pid) ?? '', /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  assert.deepEqual(systemProcesses.startTimes([gone]), new Map());
  assert.equal(systemProcesses.info(process.pid)?.ppid, process.ppid);
});

function chain(entries: [pid: number, ppid: number, command: string][]): ProcessTable {
  const byPid = new Map<number, ProcessInfo>(
    entries.map(([pid, ppid, command]) => [pid, { pid, ppid, command, start: `start-${String(pid)}` }]),
  );
  return {
    startTimes: pids => new Map(pids.flatMap(pid => (byPid.has(pid) ? [[pid, `start-${String(pid)}`] as const] : []))),
    info: pid => byPid.get(pid),
    cwd: () => undefined,
  };
}

test('the owner is the Claude process from CLAUDE_PID, with the session id for display', () => {
  const table = chain([[500, 1, 'claude']]);
  const owner = resolveOwner({ CLAUDE_PID: '500', CLAUDE_CODE_SESSION_ID: 'abcd' }, table, 900);
  assert.deepEqual(owner, { kind: 'claude', process: { pid: 500, start: 'start-500' }, sessionId: 'abcd', threadId: null });
  assert.equal(ownerKey(owner), 'claude:500:start-500');
  assert.throws(() => resolveOwner({ CLAUDE_PID: '501' }, table, 900), UsageError);
});

test('a CLAUDE_PID inherited from an outer session loses to the nearest claude ancestor', () => {
  const nested = chain([
    [900, 700, 'node /x/agentlane mcp'],
    [700, 650, 'claude -p smoke test'],
    [650, 500, '/bin/zsh -c claude -p'],
    [500, 1, 'claude'],
  ]);
  const owner = resolveOwner({ CLAUDE_PID: '500', CLAUDE_CODE_SESSION_ID: 'inner' }, nested, 900);
  assert.deepEqual(owner.process, { pid: 700, start: 'start-700' });
  assert.equal(owner.sessionId, 'inner');
});

test('a Codex owner keeps its thread id and its nearest codex ancestor process', () => {
  const table = chain([
    [900, 800, 'node agentlane'],
    [800, 700, '/bin/zsh -c agentlane claim'],
    [700, 1, '/opt/homebrew/bin/codex exec'],
  ]);
  const owner = resolveOwner({ CODEX_THREAD_ID: 'thread-7' }, table, 900);
  assert.deepEqual(owner, { kind: 'codex', process: { pid: 700, start: 'start-700' }, sessionId: null, threadId: 'thread-7' });
  assert.equal(ownerKey(owner), 'codex:thread:thread-7');
  const orphan = resolveOwner({ CODEX_THREAD_ID: 'thread-8' }, chain([[900, 1, 'node']]), 900);
  assert.equal(orphan.process, null);
});

test('without session variables the owner is a claude or codex ancestor, else the first ancestor that is not a package-manager wrapper', () => {
  const claudeChain = chain([
    [900, 800, 'node agentlane'],
    [800, 600, 'zsh'],
    [600, 1, 'claude'],
  ]);
  assert.equal(resolveOwner({}, claudeChain, 900).kind, 'claude');
  const terminal = chain([
    [900, 850, 'node /x/agentlane'],
    [850, 800, 'node /x/pnpm.cjs exec agentlane'],
    [800, 1, '-zsh'],
  ]);
  assert.deepEqual(resolveOwner({}, terminal, 900).process, { pid: 800, start: 'start-800' });
  assert.deepEqual(resolveOwner({ AGENTLANE_OWNER_PID: '850' }, terminal, 900), {
    kind: 'process',
    process: { pid: 850, start: 'start-850' },
    sessionId: null,
    threadId: null,
  });
  assert.throws(() => resolveOwner({ AGENTLANE_OWNER_PID: '12345' }, terminal, 900), UsageError);
  assert.throws(() => resolveOwner({}, chain([[900, 1, 'node']]), 900), UsageError);
});
