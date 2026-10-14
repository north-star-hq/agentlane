import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Agent } from '../registry/owner.ts';
import { agentMarker, AGENTS } from '../registry/owner.ts';

export const AGENT_NAMES: Record<Agent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
};

export const AGENT_FILES: Record<Agent, readonly string[]> = {
  claude: ['CLAUDE.md', 'CLAUDE.local.md', '.claude'],
  codex: ['.codex'],
  cursor: ['.cursor', '.cursorrules'],
  copilot: ['.github/copilot-instructions.md', '.github/instructions', '.github/copilot', '.github/hooks'],
  gemini: ['GEMINI.md', '.gemini'],
  antigravity: ['.agents/rules', '.agents/workflows', '.agents/mcp_config.json', '.agents/hooks.json', '.agent'],
};

export interface Detection {
  agent: Agent;
  signal: string;
}

function fileSignal(root: string, agent: Agent): string | null {
  for (const file of AGENT_FILES[agent]) {
    const stat = fs.statSync(path.join(root, file), { throwIfNoEntry: false });
    if (stat) return stat.isDirectory() ? `${file}/` : file;
  }
  return null;
}

export function detectAgents(root: string, env: NodeJS.ProcessEnv): Detection[] {
  return AGENTS.flatMap((agent): Detection[] => {
    const variable = agentMarker(env, agent);
    if (variable !== null) return [{ agent, signal: `${variable} is set, so ${AGENT_NAMES[agent]} runs this command` }];
    const file = fileSignal(root, agent);
    return file === null ? [] : [{ agent, signal: file }];
  });
}

export function describeDetections(detected: readonly Detection[]): string {
  const width = Math.max(...detected.map(d => d.agent.length));
  return detected.map(d => `  ${d.agent.padEnd(width)}  ${d.signal}\n`).join('');
}

export interface Terminal {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

function menu(detected: readonly Detection[]): string {
  const width = Math.max(...AGENTS.map(agent => agent.length));
  const lines = AGENTS.map((agent, i) => {
    const found = detected.find(d => d.agent === agent);
    return `  ${String(i + 1)}. [${found ? 'x' : ' '}] ${agent.padEnd(width)}  ${found?.signal ?? ''}`.trimEnd();
  });
  return `Which agents do you use in this project?\n${lines.join('\n')}\n`;
}

function question(detected: readonly Detection[]): string {
  const example = '(such as 1,3 or claude,codex)';
  return detected.length > 0
    ? `Press Enter to wire ${detected.map(d => d.agent).join(', ')}, or type the numbers or names to wire instead ${example}: `
    : `Type the numbers or names of the agents to wire ${example}: `;
}

function parseChoice(line: string, detected: readonly Detection[]): Agent[] | string {
  const words = line
    .trim()
    .split(/[\s,]+/)
    .filter(word => word !== '');
  if (words.length === 0)
    return detected.length > 0 ? detected.map(d => d.agent) : 'Nothing is checked, so name at least one agent.';
  const chosen = new Set<Agent>();
  for (const word of words) {
    const agent = /^\d+$/.test(word) ? AGENTS[Number(word) - 1] : AGENTS.find(name => name === word.toLowerCase());
    if (agent === undefined) return `'${word}' is not one of the agents above.`;
    chosen.add(agent);
  }
  return AGENTS.filter(agent => chosen.has(agent));
}

export async function chooseAgents(detected: readonly Detection[], terminal: Terminal): Promise<Agent[] | null> {
  const lines = createInterface({ input: terminal.input, terminal: false });
  const answers = lines[Symbol.asyncIterator]();
  try {
    terminal.output.write(`${menu(detected)}${question(detected)}`);
    for (let next = await answers.next(); next.done !== true; next = await answers.next()) {
      const answer = parseChoice(next.value, detected);
      if (typeof answer !== 'string') return answer;
      terminal.output.write(`${answer}\n${question(detected)}`);
    }
    return null;
  } finally {
    lines.close();
  }
}
