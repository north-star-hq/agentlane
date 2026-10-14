import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ToolAnswer {
  ms: number;
  isError: boolean;
  text: string;
  images: number;
  bytes: number;
}

interface Message {
  id?: number;
  result?: { content?: { type: string; text?: string; data?: string }[]; isError?: boolean };
  error?: { message?: string };
}

/** A stdio MCP client for one `mcp` server process, timing each tools/call from request write to response line. */
export class McpClient {
  private readonly child: ChildProcess;
  private next = 0;
  private readonly waiting = new Map<number, (message: Message) => void>();
  private exited: string | undefined;
  private stderrTail = '';

  constructor(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    this.child.on('exit', (code, signal) => {
      this.exited = signal ?? `code ${String(code)}`;
      for (const resolve of this.waiting.values()) resolve({ error: { message: `the MCP server exited (${this.exited})` } });
      this.waiting.clear();
    });
    if (this.child.stdout) {
      createInterface({ input: this.child.stdout }).on('line', line => {
        let message: Message;
        try {
          message = JSON.parse(line) as Message;
        } catch {
          return;
        }
        if (message.id === undefined) return;
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      });
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Message> {
    if (this.exited) return Promise.resolve({ error: { message: `the MCP server exited (${this.exited}): ${this.stderrTail}` } });
    const id = ++this.next;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ error: { message: `${method} got no answer within ${String(timeoutMs / 1000)} s` } });
      }, timeoutMs);
      this.waiting.set(id, message => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    const answer = await this.request(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } },
      30_000,
    );
    if (answer.error) throw new Error(`MCP initialize failed: ${answer.error.message ?? ''} ${this.stderrTail}`);
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 180_000): Promise<ToolAnswer> {
    const started = process.hrtime.bigint();
    const answer = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (answer.error) return { ms, isError: true, text: answer.error.message ?? 'error', images: 0, bytes: 0 };
    const content = answer.result?.content ?? [];
    const text = content
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
    const bytes = content.reduce((sum, c) => sum + (c.text?.length ?? 0) + Math.round(((c.data?.length ?? 0) * 3) / 4), 0);
    return { ms, isError: answer.result?.isError === true, text, images: content.filter(c => c.type === 'image').length, bytes };
  }

  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM');
      }, 5000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin?.end();
    });
  }
}
