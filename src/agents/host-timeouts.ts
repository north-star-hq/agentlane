import { LONGEST_ENGINE_CALL_MS } from '../driver/client.ts';
import { TOOL } from '../name.ts';
import type { Agent } from '../registry/owner.ts';
import { LONGEST_ENTRY_MS } from '../up/lane-waits.ts';
import { AGENT_NAMES } from './detect.ts';

export interface HostTimeout {
  key: string;
  unit: 'ms' | 's';
  /** How long the host lets one call run without the key, in seconds. */
  callSec: number;
  /** The host's limit on connecting that the same key replaces, in seconds; null where connecting has its own setting. */
  connectSec: number | null;
  /** A negative value turns the host's limits off, and zero keeps its defaults. */
  signed: boolean;
}

/** Each host's per-server limit on one MCP call, where a project file can set it. Cursor has none. */
export const HOST_TIMEOUTS = {
  // https://code.claude.com/docs/en/env-vars: MCP_TOOL_TIMEOUT defaults to 100000000 ms; MCP_TIMEOUT limits startup on its own
  claude: { key: 'timeout', unit: 'ms', callSec: 100_000, connectSec: null, signed: false },
  // https://learn.chatgpt.com/docs/extend/mcp: tool_timeout_sec defaults to 60; startup_timeout_sec limits startup on its own
  codex: { key: 'tool_timeout_sec', unit: 's', callSec: 60, connectSec: null, signed: false },
  // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference: timeout defaults to 30000 ms and is also the connection budget, floored at 60000 ms
  copilot: { key: 'timeout', unit: 'ms', callSec: 30, connectSec: 60, signed: false },
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md: timeout defaults to 600000 ms and also limits connecting and discovery
  gemini: { key: 'timeout', unit: 'ms', callSec: 600, connectSec: 600, signed: false },
  // https://antigravity.google/docs/mcp: a positive timeoutSeconds replaces both the 180 s call and the 300 s connect limit
  antigravity: { key: 'timeoutSeconds', unit: 's', callSec: 180, connectSec: 300, signed: true },
} satisfies Partial<Record<Agent, HostTimeout>>;

export function hostTimeout(agent: Agent): HostTimeout | undefined {
  const hosts: Partial<Record<Agent, HostTimeout>> = HOST_TIMEOUTS;
  return hosts[agent];
}

const MINUTE_MS = 60_000;

/** The longest one MCP tool call waits on agentlane's bounded steps: entering its lane, then the engine. */
export const LONGEST_TOOL_CALL_MS = LONGEST_ENTRY_MS + LONGEST_ENGINE_CALL_MS;

/** agentlane's longest call with a minute to spare, rounded up to whole minutes. */
export const CALL_LIMIT_SEC = (Math.ceil((LONGEST_TOOL_CALL_MS + MINUTE_MS) / MINUTE_MS) * MINUTE_MS) / 1000;

function inUnit(host: HostTimeout, sec: number): number {
  return host.unit === 'ms' ? sec * 1000 : sec;
}

function neededSec(host: HostTimeout): number {
  return Math.max(CALL_LIMIT_SEC, host.connectSec ?? 0);
}

/** The value agentlane writes for this host, in the host's unit. */
export function timeoutValue(host: HostTimeout): number {
  return inUnit(host, neededSec(host));
}

function inEffect(host: HostTimeout, value: unknown): unknown {
  return value === undefined || (host.signed && value === 0) ? inUnit(host, host.callSec) : value;
}

/** Whether the host, with this value of its key (undefined when unset), lets agentlane's longest call finish. */
export function coversCalls(host: HostTimeout, value: unknown): boolean {
  const limit = inEffect(host, value);
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return false;
  return limit >= timeoutValue(host) || (host.signed && limit < 0);
}

function duration(sec: number): string {
  return sec % 60 === 0 ? `${String(sec / 60)} min` : `${String(sec)} s`;
}

/** Why this host would stop agentlane's longest call, or null when it wouldn't. */
export function timeoutShortfall(agent: Agent, value: unknown): string | null {
  const host = hostTimeout(agent);
  if (!host || coversCalls(host, value)) return null;
  const needs = `${host.key} ${String(timeoutValue(host))} (${host.unit === 'ms' ? 'milliseconds' : 'seconds'}, ${duration(neededSec(host))})`;
  const stops = `${AGENT_NAMES[agent]} stops a call after ${duration(host.callSec)}`;
  const has =
    value === undefined
      ? `it has no ${host.key}, so ${stops}`
      : inEffect(host, value) === value
        ? `its ${host.key} is ${JSON.stringify(value)}`
        : `its ${host.key} is 0, which keeps the default, so ${stops}`;
  return `${has}; ${TOOL} needs ${needs}`;
}
