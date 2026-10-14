import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_TOKEN_ENV } from '../driver/maestro-child.ts';
import { ensureMaestro, MAESTRO_OVERRIDE_ENV } from '../driver/install.ts';
import { maestroRunsDir } from '../driver/maestro-runs.ts';
import { evidenceDir } from '../hooks/env.ts';
import { CLI, CONFIG_FILE, TOOL } from '../name.ts';
import type { ProjectConfig } from '../project/config.ts';
import { UsageError } from '../registry/refusal.ts';
import type { Lane } from '../registry/types.ts';
import { shellQuote } from '../registry/format.ts';
import type { EnvDeps } from './deps.ts';

/** Maestro's root options that take a value (`App` in maestro-cli), so the word after one is not the subcommand. */
export const MAESTRO_VALUE_OPTIONS = ['-p', '--platform', '--host', '--port', '--driver-host-port', '--device', '--udid'];

export interface LaneMaestro {
  /** Our Maestro build. */
  maestro: string;
  /** The id Maestro knows the lane's device by: a simulator's UDID or an emulator's adb serial. */
  device: string;
  laneId: string;
  evidence: string;
  runs: string;
}

/**
 * The lane's `maestro`: our build, bound to the lane's device. `maestro mcp` takes its device from each tool call, so
 * it can't be bound, and is refused. Unless the caller names its own output folder, `maestro test` writes its output
 * into the lane's evidence folder, which outlives release: `<stamp>-maestro-test-<pid>` when the test passes and
 * `<stamp>-maestro-test-<pid>-failed` when it fails. Each run in it is linked into `runs`, where Maestro would have
 * written it, so tooling that reads Maestro's own folder finds it there too.
 */
export function maestroShim(lane: LaneMaestro): string {
  const { laneId } = lane;
  return `#!/bin/sh
# ${TOOL}: the patched Maestro, bound to lane ${laneId}'s device ${lane.device}.
maestro=${shellQuote(lane.maestro)}
device=${shellQuote(lane.device)}
evidence=${shellQuote(lane.evidence)}
runs=${shellQuote(lane.runs)}
prev=''
named=''
output=''
value=''
sub=''
at=0
i=0
for arg in "$@"; do
  i=$((i + 1))
  case "$prev" in --udid|--device) named="$arg" ;; esac
  case "$arg" in
    --udid=*|--device=*) named="\${arg#*=}" ;;
    --debug-output|--debug-output=*|--test-output-dir|--test-output-dir=*) output=given ;;
  esac
  prev="$arg"
  if [ -n "$sub" ]; then continue; fi
  if [ -n "$value" ]; then value=''; continue; fi
  case "$arg" in
    ${MAESTRO_VALUE_OPTIONS.join('|')}) value=1 ;;
    -*) ;;
    *) sub="$arg"; at=$i ;;
  esac
done
if [ -n "$named" ] && [ "$named" != "$device" ]; then
  echo "${TOOL}: this maestro drives lane ${laneId}'s device $device, not $named. Drop --udid/--device, or run it from the worktree that holds $named." >&2
  exit 2
fi
if [ "$sub" = mcp ]; then
  echo "${TOOL}: maestro mcp takes its device from each tool call, so it can't be held to lane ${laneId}'s device $device. The lane's own MCP server is ${CLI} mcp; look, run and screenshot drive the same device from a shell." >&2
  exit 2
fi
run=''
if [ -z "$output" ] && [ "$sub" = test ]; then
  i=0
  for arg in "$@"; do
    i=$((i + 1))
    if [ "$i" -eq 1 ]; then set --; fi
    set -- "$@" "$arg"
    if [ "$i" -eq "$at" ]; then
      run="$evidence/$(date -u +%Y%m%dT%H%M%SZ)-maestro-test-$$"
      set -- "$@" --debug-output "$run-failed"
    fi
  done
fi
if [ -z "$named" ]; then set -- --udid "$device" "$@"; fi
if [ -z "$run" ]; then exec "$maestro" "$@"; fi
kept="$run-failed"
mkdir -p "$kept"
"$maestro" "$@"
code=$?
if [ -z "$(ls -A "$kept")" ]; then
  rmdir "$kept"
  if [ "$code" -ne 0 ]; then echo "${TOOL}: maestro test exited $code before it wrote any output" >&2; fi
  exit "$code"
fi
if [ "$code" -eq 0 ] && [ ! -e "$run" ] && mv "$kept" "$run"; then kept="$run"; fi
linked=''
for made in "$kept"/.maestro/tests/*; do
  if [ ! -d "$made" ]; then continue; fi
  name="\${made##*/}"
  if [ -e "$runs/$name" ] || [ -L "$runs/$name" ]; then name="$name-$$"; fi
  if mkdir -p "$runs" 2>/dev/null && ln -s "$made" "$runs/$name" 2>/dev/null; then linked="$linked $runs/$name"; fi
done
if [ -n "$linked" ]; then linked="; linked where Maestro writes its runs:$linked"; fi
if [ "$code" -eq 0 ]; then
  echo "${TOOL}: maestro test passed; its output, takeScreenshot files included, is kept (after release too) in $kept$linked" >&2
else
  echo "${TOOL}: maestro test exited $code; its debug output is kept (after release too) in $kept$linked" >&2
fi
exit "$code"
`;
}

/** A `maestro` for a lane that has none of its own: it says why and exits 2, so no other Maestro on PATH runs. */
export function refusingMaestro(laneId: string, reason: string): string {
  return `#!/bin/sh
# ${TOOL}: lane ${laneId} has no Maestro of its own.
printf '%s\\n' ${shellQuote(`${TOOL}: maestro is off in lane ${laneId}, because ${reason}`)} >&2
exit 2
`;
}

function writeExecutable(file: string, content: string): void {
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o755 });
  fs.renameSync(temp, file);
}

/** The id the lane's Maestro drives, or why the lane can't have its own Maestro, as the problem and its fix. */
function maestroDevice(
  config: ProjectConfig | null,
  configProblem: string | null,
  lane: Lane,
): { device: string } | { refusal: string } {
  if (configProblem !== null) return { refusal: configProblem };
  if (!config) {
    return {
      refusal: `no ${CONFIG_FILE} at or above ${lane.worktree} turns it on\nto fix: add ${CONFIG_FILE} with a driver block ("driver": {})`,
    };
  }
  if (!config.driver) return { refusal: `${config.file} has no driver block\nto fix: add "driver": {} to ${config.file}` };
  const held = lane.device;
  if (!held) return { refusal: `the lane holds no simulator or emulator\nto fix: ${CLI} release, then ${CLI} up` };
  if (held.platform !== 'android') return { device: held.id };
  if (held.serial === null) {
    return {
      refusal: `its emulator ${held.name} isn't running (adb has no serial for it)\nto fix: ${CLI} release, then ${CLI} up`,
    };
  }
  return { device: held.serial };
}

/**
 * What a hook or `exec` needs to run `maestro` on the lane's device: our Maestro build first on PATH, bound to the
 * device, JDK 17, an adb that fails fast, and the lane's runner token. When the lane can't have its own Maestro (an
 * invalid config, no `driver` block, no running device), the `maestro` first on PATH says why and runs nothing.
 */
export async function driverVariables(
  deps: Pick<EnvDeps, 'env' | 'toolchain' | 'log'>,
  config: ProjectConfig | null,
  lane: Lane,
  laneDirPath: string,
  configProblem: string | null = null,
): Promise<Record<string, string>> {
  const bin = path.join(laneDirPath, 'bin');
  const base = deps.env.PATH ?? '/usr/bin:/bin';
  const target = maestroDevice(config, configProblem, lane);
  if ('refusal' in target) {
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    writeExecutable(path.join(bin, 'maestro'), refusingMaestro(lane.id, target.refusal));
    fs.rmSync(path.join(bin, 'adb'), { force: true });
    return { PATH: [bin, base].join(path.delimiter) };
  }
  const { device } = target;
  const java = await deps.toolchain.findJava17(deps.env);
  if (!java) {
    throw new UsageError(
      'Maestro needs JDK 17, and none was found',
      `install it ('brew install openjdk@17'), or set JAVA_HOME to a JDK 17 home`,
    );
  }
  const maestro =
    deps.env[MAESTRO_OVERRIDE_ENV] ?? (await ensureMaestro({ env: { ...deps.env, JAVA_HOME: java.home }, log: deps.log })).binary;
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeExecutable(
    path.join(bin, 'maestro'),
    maestroShim({
      maestro,
      device,
      laneId: lane.id,
      evidence: evidenceDir(laneDirPath),
      runs: maestroRunsDir(deps.env),
    }),
  );
  writeExecutable(path.join(bin, 'adb'), '#!/bin/sh\nexit 1\n');
  return {
    PATH: [bin, path.join(java.home, 'bin'), base].join(path.delimiter),
    JAVA_HOME: java.home,
    [RUNNER_TOKEN_ENV]: lane.token,
    MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_DISABLE_UPDATE_CHECK: 'true',
  };
}
