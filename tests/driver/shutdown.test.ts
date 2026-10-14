import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { callEngine, engineStatus, stopEngine } from '../../src/driver/client.ts';
import type { EngineResponse } from '../../src/driver/engine.ts';
import { enginePaths, ensurePrivateDir } from '../../src/driver/paths.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import { driverWorld, sleeper, until, type DriverWorld } from '../support/driver-world.ts';

async function withWorld(options: Parameters<typeof driverWorld>[0], body: (world: DriverWorld) => Promise<void>): Promise<void> {
  const world = await driverWorld(options);
  try {
    await body(world);
  } finally {
    await world.close();
  }
}

const calls = (world: DriverWorld) => world.events().filter(event => event.event === 'call');

/** Connects to a socket and writes `line`, resolving once both are done; `reply` is what came back, or how it ended. */
async function connectAndWrite(socketPath: string, line: string): Promise<{ reply: Promise<string> }> {
  const socket = net.connect(socketPath);
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    data += chunk;
  });
  const reply = new Promise<string>(resolve => {
    socket.on('error', (error: NodeJS.ErrnoException) => {
      resolve(data || `error ${error.code ?? ''}`);
    });
    socket.on('close', () => {
      resolve(data || 'closed with nothing');
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    socket.write(line, error => {
      if (error) reject(error);
      else resolve();
    });
  });
  return { reply };
}

function errorOf(reply: string): string {
  try {
    return (JSON.parse(reply.split('\n')[0] ?? '') as EngineResponse).error ?? reply;
  } catch {
    return reply;
  }
}

const stopped = (pid: number) =>
  spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    .stdout.trim()
    .startsWith('T');

test('calls queued on the socket when the engine stops for an ended lane are each answered, none dropped', () =>
  withWorld({ platform: 'android', tuning: { lanePollMs: 60_000 } }, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    await until(() => world.registry().find(world.lane.owner, world.worktree)?.lastAction === 'look', 3000, 'the touch');
    const before = calls(world).length;
    const socket = enginePaths(world.stateDir, world.lane.id).socket;
    const request = `${JSON.stringify({ op: 'look', lane: { id: world.lane.id, token: world.lane.token }, args: {} })}\n`;
    process.kill(first.pid, 'SIGSTOP');
    let queued: { reply: Promise<string> }[];
    try {
      await until(() => stopped(first.pid), 3000, 'the engine to pause');
      world.registry().release({ id: world.lane.id, token: world.lane.token }, world.lane.owner);
      queued = await Promise.all(Array.from({ length: 40 }, () => connectAndWrite(socket, request)));
    } finally {
      process.kill(first.pid, 'SIGCONT');
    }
    const errors = await Promise.all(queued.map(async call => errorOf(await call.reply)));
    assert.deepEqual(
      errors.filter(error => !/no longer holds emulator-\d+, so the driver stopped without acting/.test(error)),
      [],
    );
    assert.equal(calls(world).length, before);
  }));

test('a connection whose request has not come when the engine exits gets the stopping answer, not a closed socket', () =>
  withWorld({}, async world => {
    const first = await callEngine(world.target(), { op: 'look', args: {} });
    assert.equal(first.ok, true, first.error);
    const idle = await connectAndWrite(enginePaths(world.stateDir, world.lane.id).socket, '');
    assert.equal(await stopEngine(world.stateDir, world.lane, 8000), true);
    const reply = await idle.reply;
    assert.deepEqual(JSON.parse(reply), {
      pid: first.pid,
      ok: false,
      error: 'the driver is stopping (asked to stop)',
      stopping: 'asked to stop',
    });
  }));

async function listenOnEngineSocket(world: DriverWorld, server: net.Server): Promise<void> {
  const socket = enginePaths(world.stateDir, world.lane.id).socket;
  ensurePrivateDir(path.dirname(socket));
  await new Promise<void>(resolve => {
    server.listen(socket, resolve);
  });
}

test('a call whose connection is dropped before anything reads it is told no engine took it', () =>
  withWorld({}, async world => {
    const listener = net.createServer();
    await listenOnEngineSocket(world, listener);
    const status = engineStatus(world.stateDir, world.lane);
    listener.close();
    assert.equal(await status, undefined);
  }));

test('an answer received in full stands, though the engine then closes with the request unread', () =>
  withWorld({}, async world => {
    const answer: EngineResponse = { pid: 1, ok: false, error: 'the driver is stopping (x)', stopping: 'x' };
    const listener = net.createServer({ pauseOnConnect: true }, socket => {
      setImmediate(() => {
        socket.write(`${JSON.stringify(answer)}\n`);
        socket.destroy();
      });
    });
    await listenOnEngineSocket(world, listener);
    try {
      assert.deepEqual(await engineStatus(world.stateDir, world.lane), answer);
    } finally {
      listener.close();
    }
  }));

const RUN = { yaml: 'appId: com.apple.Preferences\n---\n- tapOn:\n    id: com.apple.settings.general\n' };

const hangsOnFirst = (tool: string) => ({ env: { FAKE_HANG_TOOL: tool } });

const callsOf = (world: DriverWorld, name: string) => calls(world).filter(event => event.name === name);

test(
  'a run the engine is partway through when it is signalled to stop is answered as interrupted, never sent to a new engine',
  { timeout: 30_000 },
  () =>
    withWorld(hangsOnFirst('run'), async world => {
      const warm = await callEngine(world.target(), { op: 'look', args: {} });
      assert.equal(warm.ok, true, warm.error);
      const run = callEngine(world.target(), { op: 'run', args: RUN });
      await until(() => callsOf(world, 'run').length === 1, 5000, 'the run to reach Maestro');
      process.kill(warm.pid, 'SIGTERM');
      const answer = await run;
      assert.equal(answer.ok, false);
      assert.equal(answer.interrupted, 'SIGTERM');
      assert.equal(answer.stopping, undefined);
      assert.match(
        answer.error ?? '',
        /^the driver stopped partway through run \(SIGTERM\)\. Some of it may have run on the device, so it was not sent again/,
      );
      assert.equal(callsOf(world, 'run').length, 1);
      assert.equal(world.spawns().length, 1);
    }),
);

test(
  'driver stop stops the engine during a run instead of waiting behind it, and the run is answered as interrupted',
  { timeout: 30_000 },
  () =>
    withWorld(hangsOnFirst('run'), async world => {
      const warm = await callEngine(world.target(), { op: 'look', args: {} });
      assert.equal(warm.ok, true, warm.error);
      const run = callEngine(world.target(), { op: 'run', args: RUN });
      await until(() => callsOf(world, 'run').length === 1, 5000, 'the run to reach Maestro');
      assert.equal(await stopEngine(world.stateDir, world.lane, 15_000), true);
      const answer = await run;
      assert.equal(answer.interrupted, 'asked to stop', answer.error);
      assert.equal(callsOf(world, 'run').length, 1);
      assert.equal(world.spawns().length, 1);
    }),
);

test(
  'a call queued behind one in flight when the engine stops is never started, and is answered as safe to send again',
  { timeout: 30_000 },
  () =>
    withWorld(hangsOnFirst('run'), async world => {
      const warm = await callEngine(world.target(), { op: 'look', args: {} });
      assert.equal(warm.ok, true, warm.error);
      const socket = enginePaths(world.stateDir, world.lane.id).socket;
      const line = (args: object) =>
        `${JSON.stringify({ op: 'run', lane: { id: world.lane.id, token: world.lane.token }, args })}\n`;
      const first = await connectAndWrite(socket, line(RUN));
      await until(() => callsOf(world, 'run').length === 1, 5000, 'the first run to reach Maestro');
      const queued = await connectAndWrite(socket, line({ yaml: '- assertVisible: About\n' }));
      assert.equal(await stopEngine(world.stateDir, world.lane, 15_000), true);
      assert.equal((JSON.parse(await first.reply) as EngineResponse).interrupted, 'asked to stop');
      assert.deepEqual(JSON.parse(await queued.reply), {
        pid: warm.pid,
        ok: false,
        error: 'the driver is stopping (asked to stop)',
        stopping: 'asked to stop',
      });
      assert.equal(callsOf(world, 'run').length, 1);
    }),
);

test('a look the engine is partway through when it stops is read again by a new engine', { timeout: 30_000 }, () =>
  withWorld(hangsOnFirst('inspect_screen'), async world => {
    const look = callEngine(world.target(), { op: 'look', args: {} });
    await until(() => callsOf(world, 'inspect_screen').length === 1, 10_000, 'the look to reach Maestro');
    const lock = enginePaths(world.stateDir, world.lane.id).lock;
    const engine = (JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number }).pid;
    process.kill(engine, 'SIGTERM');
    const answer = await look;
    assert.equal(answer.ok, true, answer.error);
    assert.notEqual(answer.pid, engine);
    assert.equal(callsOf(world, 'inspect_screen').length, 2);
  }),
);

test(
  'starting an engine waits out one that answers its ping with stopping, rather than sending the call to it',
  { timeout: 30_000 },
  () =>
    withWorld({}, async world => {
      const paths = enginePaths(world.stateDir, world.lane.id);
      const holder = sleeper();
      try {
        let identity: ReturnType<typeof identityOf>;
        await until(() => (identity = identityOf(systemProcesses, holder.pid ?? 0)) !== undefined, 5000, 'the holder');
        ensurePrivateDir(paths.dir);
        fs.writeFileSync(paths.lock, JSON.stringify(identity));
        const call = callEngine(world.target(), { op: 'look', args: {} });
        await until(
          () => fs.existsSync(paths.log) && fs.readFileSync(paths.log, 'utf8').includes('exit: another engine holds the lock'),
          10_000,
          'the new engine to find the lock held',
        );
        const seen: string[] = [];
        const stoppingEngine = net.createServer(connection => {
          connection.setEncoding('utf8');
          connection.once('data', (chunk: string) => {
            const op = (JSON.parse(chunk.split('\n')[0] ?? '') as { op: string }).op;
            seen.push(op);
            connection.end(
              `${JSON.stringify({ pid: holder.pid, ok: false, error: 'the driver is stopping (x)', stopping: 'x' })}\n`,
            );
            if (op !== 'ping' || seen.length === 2) {
              stoppingEngine.close();
              fs.rmSync(paths.socket, { force: true });
              holder.kill('SIGKILL');
            }
          });
        });
        await new Promise<void>(resolve => {
          stoppingEngine.listen(paths.socket, resolve);
        });
        const answer = await call;
        assert.equal(answer.ok, true, answer.error);
        assert.deepEqual(seen, ['ping', 'ping']);
      } finally {
        holder.kill('SIGKILL');
      }
    }),
);
