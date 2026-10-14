import path from 'node:path';
import { CLI } from '../../src/name.ts';
import { DEFAULT_CONFIG } from '../../src/registry/config.ts';
import type { Agent } from '../../src/registry/owner.ts';

export const COMMAND = path.posix.basename(CLI);
export const TYPED = `${COMMAND} up`;
export const PROJECT = 'basket';

export const AGENT_NAMES: Record<Agent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
};

export type Platform = 'web' | 'ios' | 'android';

export const DEVICE_NAMES: Record<Platform, string> = {
  web: 'browser',
  ios: 'iOS simulator',
  android: 'Android emulator',
};

export interface Lane {
  agent: Agent;
  platform: Platform;
  devServer: number;
  api: number;
  database: string;
  adds: string;
}

const { metro, api, web } = DEFAULT_CONFIG.blocks;

function block(range: { first: number } | undefined): number {
  if (range === undefined) throw new Error('the registry has no such port block');
  return range.first;
}

export const LANES: readonly Lane[] = [
  { agent: 'claude', platform: 'web', devServer: block(web), api: block(api), database: 'basket_lane_1', adds: 'Oat milk' },
  { agent: 'codex', platform: 'ios', devServer: block(metro), api: block(api) + 1, database: 'basket_lane_2', adds: 'Basil' },
  {
    agent: 'cursor',
    platform: 'android',
    devServer: block(metro) + 1,
    api: block(api) + 2,
    database: 'basket_lane_3',
    adds: 'Limes',
  },
];

export const FINISHER = 1;

export const APP = {
  name: 'Basket',
  placeholder: 'Add an item',
} as const;

export interface Item {
  name: string;
  colour: string;
}

export const ITEMS: readonly Item[] = [
  { name: 'Lemons', colour: '#F2C94C' },
  { name: 'Eggs', colour: '#E6CFAE' },
  { name: 'Sourdough', colour: '#C68A4C' },
  { name: 'Tomatoes', colour: '#E2553F' },
  { name: 'Spinach', colour: '#2F8F57' },
  { name: 'Olive oil', colour: '#9FAE3A' },
];

export const ADDED_COLOUR: Record<string, string> = {
  'Oat milk': '#E3DACA',
  Basil: '#4CAF6A',
  Limes: '#8BC34A',
};
