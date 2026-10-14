import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { procListeners } from '../../src/services/system.ts';
import { tempDir } from '../support/fakes.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

function socketLine(local: string, state: string, inode: string): string {
  return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

function fakeProc(t: { after: (fn: () => void) => void }): string {
  const proc = tempDir('proc');
  t.after(() => {
    fs.rmSync(proc, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(proc, 'net'));
  fs.writeFileSync(
    path.join(proc, 'net', 'tcp'),
    [
      HEADER,
      socketLine('0100007F:A0F0', '0A', '5551'),
      socketLine('0100007F:A0F0', '01', '5552'),
      socketLine('0100007F:A0F1', '0A', '5553'),
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(proc, 'net', 'tcp6'),
    [HEADER, socketLine('00000000000000000000000000000000:A0F0', '0A', '5554'), ''].join('\n'),
  );
  const holds = (pid: string, fd: string, target: string) => {
    fs.mkdirSync(path.join(proc, pid, 'fd'), { recursive: true });
    fs.symlinkSync(target, path.join(proc, pid, 'fd', fd));
  };
  holds('100', '3', 'socket:[5551]');
  holds('200', '7', 'socket:[5554]');
  holds('300', '4', 'socket:[5552]');
  holds('400', '5', 'socket:[5553]');
  holds('500', '1', '/dev/null');
  fs.mkdirSync(path.join(proc, 'self'));
  return proc;
}

test('procListeners finds the processes holding a port’s listening sockets, over IPv4 and IPv6, and no other socket', t => {
  const proc = fakeProc(t);
  assert.deepEqual(procListeners(0xa0f0, proc)?.sort(), [100, 200]);
  assert.deepEqual(procListeners(0xa0f1, proc), [400]);
  assert.deepEqual(procListeners(0xa0f2, proc), []);
});

test('procListeners cannot tell who listens when no readable process holds the socket', t => {
  const proc = fakeProc(t);
  fs.rmSync(path.join(proc, '400'), { recursive: true });
  assert.equal(procListeners(0xa0f1, proc), undefined);
});

test(
  'procListeners finds this process listening, from the real procfs',
  { skip: process.platform !== 'linux' && 'procfs is Linux’s' },
  async t => {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.deepEqual(procListeners(address.port), [process.pid]);
  },
);
