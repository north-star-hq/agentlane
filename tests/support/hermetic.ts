import fs from 'node:fs';
import path from 'node:path';

/** An environment whose home, state, config and agent folders all live under `root`, with the caller's PATH. */
export function hermeticEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = path.join(root, 'home');
  for (const dir of ['.local/state', '.local/share', '.config', '.claude', '.codex'])
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    AGENTLANE_STATE_DIR: path.join(root, 'state'),
    ...extra,
  };
}
