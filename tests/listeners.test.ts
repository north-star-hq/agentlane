import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { systemProcesses } from '../src/processes.ts';
import { tcpProbe } from '../src/registry/ports.ts';
import { runRegistryCommand } from '../src/registry-cli.ts';
import { FakeDevices, tempDir } from './support/fakes.ts';
import { portBlock } from './support/ports.ts';

const PORTS = await portBlock();

function listener(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer(s => s.end()).listen(${String(port)}, '127.0.0.1', () => console.log('ready')); setInterval(() => {}, 1e9);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => {
      resolve(child);
    });
    child.once('exit', code => {
      reject(new Error(`listener on ${String(port)} exited with ${String(code)}`));
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

test('a listener the toolkit did not start survives every registry command, on a claimed port and on a free one', async () => {
  const root = tempDir('listeners');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ poolSize: 2, ports: { metro: [PORTS, PORTS + 2], api: [PORTS + 10, PORTS + 12] } }),
  );
  const devices = new FakeDevices(path.join(root, 'devices'));
  const owners = [sleeper(), sleeper(), sleeper()];
  const listeners: ChildProcess[] = [];
  const out: string[] = [];
  const as =
    (owner: ChildProcess, folder: string) =>
    (command: string, ...args: string[]) =>
      runRegistryCommand(
        command,
        [...args, ...(['claim', 'touch', 'release'].includes(command) && !args.includes('--lane') ? ['--worktree', folder] : [])],
        {
          env: { AGENTLANE_STATE_DIR: stateDir, AGENTLANE_OWNER_PID: String(owner.pid) },
          cwd: folder,
          stdout: text => out.push(text),
          stderr: text => out.push(text),
          processes: systemProcesses,
          ports: tcpProbe,
          devices: { ios: devices },
        },
      );
  const folder = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };
  const survivors = async (when: string) => {
    for (const l of listeners) {
      assert.equal(l.exitCode, null, `a listener exited after ${when}`);
      assert.equal(l.signalCode, null, `a listener was signalled after ${when}`);
    }
    for (const port of listening) assert.equal(await answers(port), true, `${String(port)} stopped answering after ${when}`);
  };
  const listening: number[] = [];
  const listen = async (port: number) => {
    listeners.push(await listener(port));
    listening.push(port);
  };
  const [ownerA, ownerB, ownerC] = owners as [ChildProcess, ChildProcess, ChildProcess];
  try {
    await listen(PORTS);
    const a = as(ownerA, folder('a'));
    assert.equal(await a('claim'), 0, out.join(''));
    const laneA = out.join('');
    assert.match(laneA, new RegExp(`export AGENTLANE_METRO_PORT=${String(PORTS + 1)}`));
    assert.match(laneA, new RegExp(`export AGENTLANE_API_PORT=${String(PORTS + 10)}`));
    await listen(PORTS + 10);
    await survivors('a lane next to a foreign listener');

    for (const [command, args] of [
      ['status', []],
      ['lanes', ['--json']],
      ['touch', []],
      ['claim', []],
    ] as const) {
      assert.equal(await a(command, ...args), 0, out.join(''));
      await survivors(`${command} ${args.join(' ')}`);
    }

    const b = as(ownerB, folder('b'));
    out.length = 0;
    assert.equal(await b('claim'), 0, out.join(''));
    assert.match(out.join(''), new RegExp(`export AGENTLANE_METRO_PORT=${String(PORTS + 2)}`));
    assert.match(out.join(''), new RegExp(`export AGENTLANE_API_PORT=${String(PORTS + 11)}`));
    await listen(PORTS + 11);
    await survivors("another session's lane");

    const exited = new Promise(resolve => ownerB.once('exit', resolve));
    ownerB.kill('SIGKILL');
    await exited;
    const c = as(ownerC, folder('c'));
    out.length = 0;
    assert.equal(await c('claim', '--no-device', '--services', 'api'), 0, out.join(''));
    assert.match(out.join(''), /freed lane .* owner dead/);
    assert.match(out.join(''), new RegExp(`export AGENTLANE_API_PORT=${String(PORTS + 12)}`));
    await survivors('a sweep that freed the lane under a listener');

    const id = /claimed lane (\w+) for process/.exec(laneA)?.[1] ?? '';
    out.length = 0;
    assert.equal(await c('release', '--lane', id), 3, out.join(''));
    await survivors('a refused release');
    assert.equal(await c('release', '--lane', id, '--force'), 0, out.join(''));
    await survivors('a forced release');
    assert.equal(await c('release'), 0, out.join(''));
    assert.equal(await a('release'), 0, out.join(''));
    await survivors('every release');

    out.length = 0;
    assert.equal(await a('claim', '--no-device'), 0, out.join(''));
    assert.match(out.join(''), new RegExp(`export AGENTLANE_METRO_PORT=${String(PORTS + 1)}`));
    assert.match(out.join(''), new RegExp(`export AGENTLANE_API_PORT=${String(PORTS + 12)}`));
    await survivors('a lane after everything was released');
  } finally {
    for (const p of [...listeners, ...owners]) p.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
