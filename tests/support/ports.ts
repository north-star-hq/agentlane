import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { tryLock, unlock } from '../../src/driver/lock.ts';
import { identityOf, systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';

// Below the ephemeral ranges of Linux (32768 up) and macOS (49152 up), so no outgoing connection takes one.
const FIRST = 20_000;
const LAST = 31_999;
export const BLOCK_SIZE = 32;
const SLOTS = Math.floor((LAST - FIRST + 1) / BLOCK_SIZE);
const RESERVATIONS = path.join(os.tmpdir(), 'agentlane-test-ports');

function bindable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

async function free(base: number): Promise<boolean> {
  const ports = Array.from({ length: BLOCK_SIZE }, (_, i) => base + i);
  if ((await tcpProbe.listening(ports)).size > 0) return false;
  return (await Promise.all(ports.map(bindable))).every(Boolean);
}

/** The first of BLOCK_SIZE free real ports, reserved for this test process against every other one on the host. */
export async function portBlock(): Promise<number> {
  const me = identityOf(systemProcesses, process.pid);
  if (!me) throw new Error('ps could not read this test process');
  fs.mkdirSync(RESERVATIONS, { recursive: true });
  for (let i = 0; i < SLOTS; i++) {
    const slot = (process.pid + i) % SLOTS;
    const file = path.join(RESERVATIONS, String(slot));
    if (!tryLock(file, me, systemProcesses).acquired) continue;
    const base = FIRST + slot * BLOCK_SIZE;
    if (await free(base)) {
      process.once('exit', () => {
        unlock(file, me);
      });
      return base;
    }
    unlock(file, me);
  }
  throw new Error(`no free block of ${String(BLOCK_SIZE)} ports between ${String(FIRST)} and ${String(LAST)}`);
}
