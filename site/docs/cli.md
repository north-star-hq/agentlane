---
title: "CLI"
short: "Every command and flag."
summary: "Every agentlane command, grouped as `agentlane --help` groups them: lanes, the environment, driving, the agent hooks, the agents and the benchmark. Each command also prints its own help with `agentlane <command> --help`."
---

The site builds this page from the CLI's own help text, so it always matches the version it documents. In a project, run each command from the project root as `node_modules/.bin/agentlane <command>` or `npx agentlane <command>`. In Claude Code with the plugin, a bare `agentlane` works too.

```sh
npx agentlane --help        # every command
npx agentlane up --help     # one command
npx agentlane --version
```

| Exit code | Meaning                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| 0         | The command did its job.                                                                     |
| 1         | A check or a step failed. The output names the fix.                                          |
| 2         | The command line or `agentlane.json` is wrong. The output names the field or flag.          |
| 3         | Refused: another session holds what you asked for, or this folder has no lane yet.           |

## Lanes

Claim, list and release lanes, and clean up the device pool. [What a lane holds](lanes.md) explains the model behind them.

<!-- generated: cli lanes -->

## Environment

These commands read `agentlane.json` from the current folder or the ones above it. [Bring a worktree up](up.md) walks through `up`.

<!-- generated: cli environment -->

## Driving

Each of these acts on the simulator, emulator or browser that this session claimed for this folder, and never on another lane's. [See and drive the app](drive.md) shows them in use.

<!-- generated: cli driving -->

## Agent hooks

The hooks that `init` and the plugin write call these with the hook's JSON on stdin. You don't run them yourself. [The device guard and session hooks](guard.md) says what each one does.

<!-- generated: cli hooks -->

## Agents

[Install for your agent](install.md) shows what `init` writes for each agent, and [The skills](skills.md) what each skill does.

<!-- generated: cli agents -->

## Benchmark

`bench` measures agentlane on the example app in the agentlane repository. The method is in `bench/README.md` in the agentlane repository.

<!-- generated: cli bench -->
