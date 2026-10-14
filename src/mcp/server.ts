import { createInterface } from 'node:readline';
import type { ToolDefinition, ToolResult } from './tools.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface Message {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServeOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  info: { name: string; version: string };
  tools: readonly ToolDefinition[];
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** A stdio MCP server: newline-delimited JSON-RPC, tools only. Resolves when the input closes and every call has answered. */
export function serveMcp(options: ServeOptions): Promise<void> {
  const send = (message: object) => options.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const lines = createInterface({ input: options.input });
  const inFlight = new Set<Promise<void>>();
  lines.on('line', line => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (typeof message !== 'object' || Array.isArray(message)) {
      send({ id: null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    const id = message.id;
    if (id === undefined || id === null) return;
    const params = message.params ?? {};
    switch (message.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        send({
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: options.info,
          },
        });
        return;
      }
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list':
        send({ id, result: { tools: options.tools } });
        return;
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args =
          typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
        const job = options.call(name, args).then(
          result => {
            send({ id, result });
          },
          (error: unknown) => {
            send({ id, result: { content: [{ type: 'text', text: String(error) }], isError: true } });
          },
        );
        inFlight.add(job);
        void job.finally(() => inFlight.delete(job));
        return;
      }
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${message.method ?? '(none)'}` } });
    }
  });
  return new Promise(resolve => {
    lines.on('close', () => {
      void Promise.allSettled([...inFlight]).then(() => {
        resolve();
      });
    });
  });
}
