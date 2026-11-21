import type { Registry } from '../../src/registry/registry.ts';

/** Makes `registry` kill this process by SIGKILL right after it records the command of a shared start or stop, which runs on. */
export function dieMidCommand(registry: Registry): void {
  const note = registry.noteSharedCommand.bind(registry);
  registry.noteSharedCommand = (key, pid) => {
    note(key, pid);
    process.kill(process.pid, 'SIGKILL');
  };
}
