import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { tcpProbe } from '../../src/registry/ports.ts';
import { portBlock } from '../support/ports.ts';

const BASE = await portBlock();

function stall(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('a port nobody listens on reads as free and one a server listens on as taken, though the event loop stalls past the probe’s timeout', async () => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(BASE + 1, '127.0.0.1', resolve));
  try {
    const probed = tcpProbe.listening([BASE, BASE + 1, BASE + 2, BASE + 3]);
    stall(800);
    assert.deepEqual([...(await probed)], [BASE + 1]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
