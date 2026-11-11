import path from 'node:path';

export function isolatedEnv(root: string): Record<string, string> {
  const home = path.join(root, 'home');
  const state = path.join(home, '.local', 'state');
  return {
    HOME: home,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    AGENTLANE_STATE_DIR: path.join(state, 'agentlane'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
  };
}

export async function withProcessEnv<T>(vars: Readonly<Record<string, string>>, body: () => T | Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}
