import type { Registry } from '../../src/registry/registry.ts';

/**
 * When a process running a shared start or stop dies by SIGKILL: once its shell is launched, before the registry
 * records it, or once the registry has recorded it and let its command run.
 */
export type CommandDeath = 'launched' | 'running';

/** Makes `registry` kill this process by SIGKILL at `death` of the command of a shared start or stop. */
export function dieMidCommand(registry: Registry, death: CommandDeath): void {
  const note = registry.noteSharedCommand.bind(registry);
  registry.noteSharedCommand = (key, pid) => {
    if (death === 'launched') {
      process.kill(process.pid, 'SIGKILL');
      throw new Error('killed before its command was recorded');
    }
    note(key, pid);
    process.nextTick(() => process.kill(process.pid, 'SIGKILL'));
  };
}
