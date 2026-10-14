import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { lockHolder, tryLock, unlock } from '../../src/driver/lock.ts';
import { enginePaths } from '../../src/driver/paths.ts';
import { FakeProcesses, tempDir } from '../support/fakes.ts';

test('the socket sits in the state dir when its path fits a Unix socket, and in a hashed temp folder when not', () => {
  const short = enginePaths('/s/state', 'a1b2c3d4', '/t');
  assert.equal(short.socket, '/s/state/driver/a1b2c3d4.sock');
  assert.equal(short.stoppingSocket, '/s/state/driver/a1b2c3d4.stop');
  assert.equal(short.log, '/s/state/driver/a1b2c3d4.log');
  const deep = `/private/tmp/${'x'.repeat(90)}/state`;
  const long = enginePaths(deep, 'a1b2c3d4', '/t');
  assert.match(long.socket, /^\/t\/agentlane-[0-9a-f]{16}\/a1b2c3d4\.sock$/);
  assert.ok(Buffer.byteLength(long.socket) <= 100);
  assert.equal(long.stoppingSocket, long.socket.replace(/\.sock$/, '.stop'));
  assert.equal(long.lock, `${deep}/driver/a1b2c3d4.lock`);
  assert.notEqual(enginePaths(`${deep}2`, 'a1b2c3d4', '/t').socket, long.socket, 'each state dir gets its own sockets');
  assert.throws(() => enginePaths('/s', '../x', '/t'), /not a lane id/);
});

test('a lock is held by a live holder, broken when its holder is proven gone, and released only by its holder', () => {
  const dir = tempDir('lock');
  const file = path.join(dir, 'x.lock');
  const procs = new FakeProcesses();
  const first = procs.spawn();
  const second = procs.spawn();
  assert.deepEqual(tryLock(file, first, procs), { acquired: true });
  assert.deepEqual(tryLock(file, second, procs), { acquired: false, holder: first });
  unlock(file, second);
  assert.deepEqual(lockHolder(file), first);
  procs.recycle(first.pid);
  assert.deepEqual(tryLock(file, second, procs), { acquired: true }, 'a recycled pid no longer holds it');
  procs.kill(second.pid);
  const third = procs.spawn();
  assert.deepEqual(tryLock(file, third, procs), { acquired: true }, 'a dead holder no longer holds it');
  procs.blind = true;
  const fourth = procs.spawn();
  assert.equal(tryLock(file, fourth, procs).acquired, false, "a holder ps can't judge keeps it");
  unlock(file, third);
  assert.equal(fs.existsSync(file), false);
});
