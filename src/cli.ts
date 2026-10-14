#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_COMMANDS, AGENT_HELP, AGENT_USAGE, runAgentCommand } from './agents/cli.ts';
import { realInstaller } from './agents/package.ts';
import { BENCH_COMMANDS, BENCH_HELP, BENCH_USAGE, runBenchCommand } from './bench-cli.ts';
import { systemClock } from './clock.ts';
import { createEmulatorBackend } from './devices/emulator.ts';
import { simctlBackend } from './devices/simctl.ts';
import { createXcrunTools } from './devices/xcrun.ts';
import { prewarmEngine } from './driver/client.ts';
import { DRIVER_COMMANDS, DRIVER_HELP, DRIVER_USAGE, runDriverCommand } from './driver-cli.ts';
import { TOOL } from './name.ts';
import {
  detachedWorker,
  HOOK_COMMANDS,
  HOOK_HELP,
  HOOK_USAGE,
  runHookCommand,
  SESSION_END_OWNER_ENV,
} from './plugin/hook-cli.ts';
import { systemProcesses } from './processes.ts';
import { stateDir } from './registry/paths.ts';
import { tcpProbe } from './registry/ports.ts';
import { REGISTRY_COMMANDS, REGISTRY_HELP, REGISTRY_USAGE, runRegistryCommand } from './registry-cli.ts';
import { realServiceSystem } from './services/system.ts';
import { UP_COMMANDS, UP_HELP, UP_USAGE, runUpCommand } from './up-cli.ts';
import { systemToolchain } from './up/preflight.ts';
import { asksForHelp, helpOf, type UsageGroup } from './usage.ts';

const USAGE = `Usage: ${TOOL} <command>

${REGISTRY_USAGE}
${UP_USAGE}
${DRIVER_USAGE}
${HOOK_USAGE}
${AGENT_USAGE}
${BENCH_USAGE}
Options:
  --help     Print this help; ${TOOL} <command> --help prints one command's.
  --version  Print the version.
`;

const GROUPS: readonly UsageGroup<string>[] = [REGISTRY_HELP, UP_HELP, DRIVER_HELP, HOOK_HELP, AGENT_HELP, BENCH_HELP];

function commandHelp(command: string): string | null {
  for (const group of GROUPS) {
    const text = helpOf(group, command);
    if (text !== null) return text;
  }
  return null;
}

function version(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function onCancel(cancel: () => void): () => void {
  const handler = (signal: NodeJS.Signals) => {
    cancel();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === '--version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const help = asksForHelp(command, rest) ? commandHelp(command) : null;
  if (help !== null) {
    process.stdout.write(help);
    return 0;
  }
  const mac = process.platform === 'darwin';
  const android = createEmulatorBackend({ env: process.env, logDir: path.join(stateDir(process.env), 'emulators') });
  const devices = mac ? { ios: simctlBackend, android } : { android };
  const sim = mac ? createXcrunTools() : null;
  if ((REGISTRY_COMMANDS as readonly string[]).includes(command)) {
    return runRegistryCommand(command, rest, {
      env: process.env,
      cwd: process.cwd(),
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
      processes: systemProcesses,
      ports: tcpProbe,
      devices,
      onCancel,
      sim,
      system: realServiceSystem,
    });
  }
  if ((HOOK_COMMANDS as readonly string[]).includes(command)) {
    const worker = process.env[SESSION_END_OWNER_ENV] !== undefined;
    return runHookCommand(rest, {
      env: process.env,
      cwd: process.cwd(),
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
      processes: systemProcesses,
      ports: tcpProbe,
      devices,
      sim,
      system: realServiceSystem,
      stdin: worker || process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'),
      startWorker: detachedWorker(process.argv[1] ?? ''),
    });
  }
  if ((UP_COMMANDS as readonly string[]).includes(command)) {
    return runUpCommand(
      command,
      rest,
      {
        env: process.env,
        cwd: process.cwd(),
        log: line => process.stderr.write(`${line}\n`),
        processes: systemProcesses,
        ports: tcpProbe,
        devices,
        sim,
        system: realServiceSystem,
        toolchain: systemToolchain,
        startDriver: async (lane, state) => {
          await prewarmEngine({
            stateDir: state,
            lane,
            env: process.env,
            progress: line => process.stderr.write(`${TOOL} up: driver: ${line}\n`),
          });
        },
        clock: systemClock,
        onCancel,
      },
      text => process.stdout.write(text),
    );
  }
  if ((DRIVER_COMMANDS as readonly string[]).includes(command)) {
    return runDriverCommand(command, rest, {
      env: process.env,
      cwd: process.cwd(),
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
      stdin: process.stdin,
      output: process.stdout,
      processes: systemProcesses,
    });
  }
  if ((AGENT_COMMANDS as readonly string[]).includes(command)) {
    return runAgentCommand(command, rest, {
      env: process.env,
      cwd: process.cwd(),
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
      install: realInstaller,
      terminal: process.stdin.isTTY && process.stdout.isTTY ? { input: process.stdin, output: process.stdout } : null,
    });
  }
  if ((BENCH_COMMANDS as readonly string[]).includes(command)) {
    return runBenchCommand(command, rest, {
      env: process.env,
      cwd: process.cwd(),
      argv: args,
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
      processes: systemProcesses,
      onSignal: handler => {
        process.on('SIGINT', handler);
        process.on('SIGTERM', handler);
        return () => {
          process.off('SIGINT', handler);
          process.off('SIGTERM', handler);
        };
      },
    });
  }
  process.stderr.write(`${TOOL}: '${command}' isn't built yet.\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
