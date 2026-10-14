import process from 'node:process';
import { createInterface } from 'node:readline';

const project = process.argv[2] ?? process.cwd();
const problem =
  `This project doesn't have the toolkit installed: there is no node_modules/.bin/agentlane in ${project} or the folders above it, ` +
  'so the device tools (look, run, screenshot) can not start.';
const fix =
  'To fix: add the toolkit as a dev dependency at the project root (for example `pnpm add -D agentlane`), ' +
  'then run `/mcp` and reconnect the plugin:agentlane:device server, or start a new session.';
const message = `${problem}\n${fix}`;

/** @param {string} name @param {string} description */
const tool = (name, description) => ({
  name,
  description: `${description} Unavailable here: ${problem}`,
  inputSchema: { type: 'object', additionalProperties: true },
});
const TOOLS = [
  tool('look', "What's on this session's simulator screen."),
  tool('run', "Run Maestro flow YAML on this session's simulator."),
  tool('screenshot', "This session's simulator screen as a JPEG."),
];

/** @param {Record<string, unknown>} message */
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

/**
 * @param {string} line
 * @returns {{ id?: string | number | null, method?: string, params?: { protocolVersion?: string } }}
 */
function parse(line) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return {};
  }
  return typeof value === 'object' && value !== null ? value : {};
}

createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = parse(line);
  if (id === undefined || id === null) return;
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentlane (toolkit not installed)', version: '0' },
          instructions: message,
        },
      });
      return;
    case 'ping':
      send({ id, result: {} });
      return;
    case 'tools/list':
      send({ id, result: { tools: TOOLS } });
      return;
    case 'tools/call':
      send({ id, result: { content: [{ type: 'text', text: message }], isError: true } });
      return;
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method ?? '(none)'}` } });
  }
});
