import net from 'node:net';

export interface PortProbe {
  listening(ports: readonly number[]): Promise<ReadonlySet<number>>;
}

const NOTHING_THERE = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT', 'EHOSTUNREACH']);

function answers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => {
      done(true);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(!NOTHING_THERE.has(error.code ?? ''));
    });
  });
}

export const tcpProbe: PortProbe = {
  async listening(ports) {
    const results = await Promise.all(
      ports.map(async port => ((await answers('127.0.0.1', port, 500)) || (await answers('::1', port, 500)) ? port : null)),
    );
    return new Set(results.filter((p): p is number => p !== null));
  },
};
