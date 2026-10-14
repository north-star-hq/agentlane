import { TOOL } from './name.ts';

export interface UsageGroup<C extends string> {
  title: string;
  entries: Readonly<Record<C, string>>;
  footer?: string;
}

export function groupUsage<C extends string>(group: UsageGroup<C>): string {
  return `${group.title}\n${Object.values<string>(group.entries).join('')}${group.footer ?? ''}`;
}

export function commandUsage<C extends string>(group: UsageGroup<C>, command: C): string {
  return `Usage: ${TOOL} ${command}\n\n${group.entries[command]}${group.footer ?? ''}`;
}

export function helpOf<C extends string>(group: UsageGroup<C>, command: string): string | null {
  return Object.hasOwn(group.entries, command) ? commandUsage(group, command as C) : null;
}

const HELP_FLAGS = new Set(['--help', '-h']);

export function asksForHelp(command: string, args: readonly string[]): boolean {
  const end = args.indexOf('--');
  const own = command === 'exec' ? args.slice(0, 1) : end === -1 ? args : args.slice(0, end);
  return own.some(arg => HELP_FLAGS.has(arg));
}
