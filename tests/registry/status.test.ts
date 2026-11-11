import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { describeStart } from '../../src/processes.ts';
import type { ProcessState } from '../../src/registry/types.ts';
import { world, type World } from '../support/world.ts';

const NO_DEVICE = { device: null } as const;

async function laneWithProcesses(w: World) {
  const out = await w.registry().claim(w.request(w.procs.owner(), w.folder('a'), NO_DEVICE));
  const ref = { id: out.lane.id, token: out.lane.token };
  const metro = w.procs.spawn('metro');
  const api = w.procs.spawn('api');
  const web = w.procs.spawn('web');
  for (const [service, proc] of [
    ['metro', metro],
    ['api', api],
    ['web', web],
  ] as const)
    w.registry().recordProcess(ref, { service, ...proc, cwd: out.lane.worktree });
  return { lane: out.lane, metro, api, web };
}

async function run(w: World, command: string, args: string[] = []) {
  const home = path.join(path.dirname(w.dir), 'home');
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRegistryCommand(command, args, {
    env: {
      AGENTLANE_STATE_DIR: w.dir,
      HOME: home,
      XDG_STATE_HOME: path.join(home, 'state'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CONFIG_HOME: path.join(home, 'config'),
      CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      CODEX_HOME: path.join(home, 'codex'),
    },
    cwd: home,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    processes: w.procs,
    ports: w.probe,
    devices: {},
    clock: w.clock,
  });
  assert.equal(code, 0, err.join(''));
  return out.join('');
}

function processLine(stdout: string, service: string): string {
  return stdout.split('\n').find(line => new RegExp(`^ +process +${service} pid `).test(line)) ?? '';
}

test('status says a recorded process is gone when its pid has exited or been reused, and running when it is alive', async () => {
  const w = world();
  try {
    const { metro, api, web } = await laneWithProcesses(w);
    w.procs.kill(api.pid);
    w.procs.recycle(web.pid);
    const stdout = await run(w, 'status');
    assert.equal(
      processLine(stdout, 'metro'),
      `      process      metro pid ${String(metro.pid)} (started ${describeStart(metro.start)})  running`,
    );
    assert.match(processLine(stdout, 'api'), new RegExp(`pid ${String(api.pid)} .*\\)  gone$`));
    assert.match(processLine(stdout, 'web'), new RegExp(`pid ${String(web.pid)} .*\\)  gone$`));
  } finally {
    w.close();
  }
});

test('lanes --json gives each recorded process a state of running, gone or unknown', async () => {
  const w = world();
  try {
    const { lane, metro, api, web } = await laneWithProcesses(w);
    w.procs.kill(api.pid);
    w.procs.recycle(web.pid);
    const states = async () => {
      const report = JSON.parse(await run(w, 'lanes', ['--json'])) as {
        lanes: { id: string; processes: { service: string; pid: number; state: ProcessState }[] }[];
      };
      return report.lanes.find(c => c.id === lane.id)?.processes.map(p => [p.service, p.pid, p.state]);
    };
    assert.deepEqual(await states(), [
      ['api', api.pid, 'gone'],
      ['metro', metro.pid, 'running'],
      ['web', web.pid, 'gone'],
    ]);
    w.procs.blind = true;
    assert.deepEqual(await states(), [
      ['api', api.pid, 'unknown'],
      ['metro', metro.pid, 'unknown'],
      ['web', web.pid, 'unknown'],
    ]);
  } finally {
    w.close();
  }
});

test('status lists every recorded process with one process listing', async () => {
  const w = world();
  try {
    await laneWithProcesses(w);
    await w.registry().claim(w.request(w.procs.owner(), w.folder('b'), NO_DEVICE));
    const calls: number[][] = [];
    const startTimes = w.procs.startTimes.bind(w.procs);
    w.procs.startTimes = pids => {
      calls.push([...pids]);
      return startTimes(pids);
    };
    w.registry().status();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.length, 5);
  } finally {
    w.close();
  }
});
