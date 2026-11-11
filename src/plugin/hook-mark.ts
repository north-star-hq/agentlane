import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HookEvent } from '../agents/launcher.ts';
import { envName } from '../name.ts';
import type { Agent } from '../registry/owner.ts';
import { AGENTS } from '../registry/owner.ts';

export const HOOK_PROBE_ENV = envName('HOOK_PROBE');

export interface HookMark {
  agent: Agent;
  event: HookEvent;
  project: string;
  at: number;
  toolkit: string;
  version: string;
  probe: string | null;
}

function marksDir(stateDir: string): string {
  return path.join(stateDir, 'hook-marks');
}

function real(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function writeHookMark(stateDir: string, mark: HookMark): void {
  const dir = marksDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const project = real(mark.project);
  const key = crypto.createHash('sha256').update(project).digest('hex').slice(0, 16);
  const file = path.join(dir, `${mark.agent}-${key}.json`);
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ ...mark, project })}\n`);
  fs.renameSync(temp, file);
}

function parseMark(text: string): HookMark | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (
    typeof m.agent !== 'string' ||
    !(AGENTS as readonly string[]).includes(m.agent) ||
    (m.event !== 'pre-tool-use' && m.event !== 'session-end') ||
    typeof m.project !== 'string' ||
    typeof m.at !== 'number' ||
    typeof m.toolkit !== 'string' ||
    typeof m.version !== 'string'
  )
    return null;
  return {
    agent: m.agent as Agent,
    event: m.event,
    project: m.project,
    at: m.at,
    toolkit: m.toolkit,
    version: m.version,
    probe: typeof m.probe === 'string' ? m.probe : null,
  };
}

/** The marks the agent's hook left in this project or a folder inside it, the latest first. */
export function readHookMarks(stateDir: string, agent: Agent, project: string): HookMark[] {
  const root = real(project);
  let names: string[];
  try {
    names = fs.readdirSync(marksDir(stateDir));
  } catch {
    return [];
  }
  return names
    .filter(name => name.startsWith(`${agent}-`) && name.endsWith('.json'))
    .flatMap(name => {
      let text: string;
      try {
        text = fs.readFileSync(path.join(marksDir(stateDir), name), 'utf8');
      } catch {
        return [];
      }
      const mark = parseMark(text);
      return mark?.agent === agent && (mark.project === root || mark.project.startsWith(`${root}${path.sep}`)) ? [mark] : [];
    })
    .sort((a, b) => b.at - a.at);
}
