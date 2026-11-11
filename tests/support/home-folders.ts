import os from 'node:os';
import path from 'node:path';
import { avdHome } from '../../src/devices/emulator.ts';
import { dataDir } from '../../src/driver/install.ts';
import { maestroRunsDir } from '../../src/driver/maestro-runs.ts';
import { perUserTemp } from '../../src/driver/paths.ts';
import { FORMER } from '../../src/name.ts';
import { claudeConfigDir } from '../../src/plugin/session-name.ts';
import { codexHome } from '../../src/registry/owner.ts';
import { stateDir } from '../../src/registry/paths.ts';

/** Every folder agentlane derives from the home folder or the temp folder, as this process resolves it from `env`. */
export function homeFolders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const data = dataDir(env);
  return {
    'os.homedir()': os.homedir(),
    'os.tmpdir()': os.tmpdir(),
    'the per-user temp folder': perUserTemp(),
    'the registry': stateDir(env),
    'the data folder': data,
    "0.2.x's data folder": path.join(path.dirname(data), FORMER.tool),
    "Claude's config": claudeConfigDir(env),
    "Codex's home": codexHome(env),
    'the AVD folder': avdHome(env),
    "Maestro's runs": maestroRunsDir(env),
  };
}
