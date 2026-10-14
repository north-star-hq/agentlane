export const TOOL = 'agentlane';
export const CLI = `node_modules/.bin/${TOOL}`;
export const ENV_PREFIX = 'AGENTLANE';
export const POOL_NAME_PREFIX = `${TOOL}-pool-`;
export const EMULATOR_NAME_PREFIX = `${TOOL}-emu-`;
export const CONFIG_FILE = `${TOOL}.json`;
export const SCHEMA_FILE = `${TOOL}.schema.json`;

export function envName(suffix: string): string {
  return `${ENV_PREFIX}_${suffix}`;
}

const FORMER_TOOL = 'agent-env';

/** The names 0.2.x uses, read where 0.2.x still runs on the same Mac and in projects it set up. */
export const FORMER = {
  tool: FORMER_TOOL,
  cli: `node_modules/.bin/${FORMER_TOOL}`,
  envPrefix: 'AGENT_ENV',
  configFile: `${FORMER_TOOL}.json`,
  schemaFile: `${FORMER_TOOL}.schema.json`,
  poolNamePrefix: `${FORMER_TOOL}-pool-`,
  emulatorNamePrefix: `${FORMER_TOOL}-emu-`,
  lanesFolder: 'claims',
} as const;
