import fs from 'node:fs';
import path from 'node:path';
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
  found: string;
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
    if (variable !== null)
      return [{ agent, signal: `${variable} is set, so ${AGENT_NAMES[agent]} runs this command`, found: 'this session' }];
    const file = fileSignal(root, agent);
    return file === null ? [] : [{ agent, signal: file, found: file }];
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
