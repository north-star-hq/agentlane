---
title: "What a lane holds"
short: "Ports, a device or browser, data and processes, claimed per session and folder."
summary: "A lane is one agent session's running copy of the project: its own ports, its own simulator, emulator or browser, its own resources such as a database, and the processes started on them. A lane belongs to the session that made it and the folder it was made in. One registry per machine keeps every lane apart, across projects and agents."
---

## What's in a lane

| Part              | What the lane gets                                                                   | Passed to commands as                       |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Ports             | One free port per service, from that service type's block                            | `AGENTLANE_<NAME>_PORT`                     |
| A device          | A simulator or emulator from the pool, which no other lane can touch                 | `AGENTLANE_DEVICE`                          |
| A browser         | Its own profile folder, debugging port and driver session                            | `AGENTLANE_BROWSER_SESSION` and others      |
| Resources         | Its own copy of the data, such as a database, made by your `create` command          | the variables `create` exports              |
| Processes         | The services `up` started, each recorded by pid and start time                       |                                             |
| Logs and evidence | A folder of logs, and an evidence folder that outlives the lane by seven days        | `AGENTLANE_LOGS`, `AGENTLANE_EVIDENCE`      |

One lane can hold a device and a browser at once, so a project with a mobile app and a web app runs both in one lane. [Environment variables](environment.md) lists every variable.

## Claim and release

Most of the time you don't claim a lane yourself: `up` claims one and brings the app up on it. `claim` takes just the ports and a device, for scripts that start things their own way:

```sh
eval "$(npx agentlane claim --boot)"     # ports, and a booted simulator
npx agentlane exec -- printenv AGENTLANE_DEVICE
npx agentlane release
```

`release` stops exactly the processes the lane started, after checking each one's pid and start time, so it never stops a process that reused a pid. Then it runs the project's teardown hook and each resource's teardown, shuts the device down and frees the lane. A teardown that fails is kept, and the next release or reap on the machine tries it again.

## One lane per session and folder

A lane belongs to two things: the agent session that claimed it and the folder it was claimed in. agentlane identifies the session from the agent's own process (the Claude Code process, a Codex thread, the Cursor or Copilot process), so every command the session runs in that folder finds the same lane without being told its id.

- The same session in a second worktree gets a second lane. That is how parallel subagents of one session stay apart: each works in its own worktree.
- A second session in the same folder gets its own lane too.
- Releasing touches only the caller's lane. A lane of another live session is refused, with its holder named and the command that recovers.

A script with no agent around it can pin the owner with `AGENTLANE_OWNER_PID`, the pid of a process that lives as long as the lane should.

## The registry

One SQLite registry per machine, in `~/.local/state/agentlane/registry.sqlite`, holds every lane of every project and agent. Every claim takes the registry's lock, so two agents starting at the same moment can't take the same port or device. `status` shows it:

```text
lanes (1):
  d2bc030e  claude session 7f3c2a91 (pid 51204)  [alive]
      folder       ~/code/shop/.claude/worktrees/checkout-fix
      started      2026-10-13 22:18:09   idle 2s   last action: exec: maestro
      device       agentlane-emu-4c1d9a (Pixel 8, Android API 36 (Google APIs, arm64-v8a)) emulator-5584  booted
      ports        emulator 5584
```

`lanes --json` prints the same for tools. The machine-wide settings live beside the registry in `config.json`:

| Setting            | Default  | What it limits                                                     |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `poolSize`         | 5        | Simulators in the pool                                             |
| `emulatorPoolSize` | 5        | Emulators in the pool                                              |
| `memoryBudgetGB`   | 20       | Memory that claimed devices may use together (4 GB per simulator, 3.4 GB per emulator) |
| `idleHours`        | 2        | How long a lane sits unused before another session may take it over |
| `ports`            | see below | The port block of each service type                               |

## Port blocks

Each service type takes its ports from its own block, so a lane's ports are easy to read and never collide with another type's:

| Type      | Ports         |
| --------- | ------------- |
| `metro`   | 41100–41119   |
| `api`     | 41200–41219   |
| `web`     | 41300–41319   |
| `browser` | 41400–41439   |

A service of your own type declares its block with `ports` in `agentlane.json`, and the machine's blocks win where they overlap. Before it hands out a port, the registry checks that nothing on the machine listens there, including processes agentlane didn't start. Blocks may not overlap the Android emulator's ports, 5554–5585.

## The device pool

Simulators and emulators come from a pool that every project on the machine shares. A free pool device of the type the lane asks for is reused, already set up, and only when none is free does agentlane create one. When the pool is full, a lane takes a free device of another type rather than deleting one, unless the config sets `strict`. [Simulators and emulators](devices.md) has the details.

## Queues and idle lanes

When the pool is full, `claim` and `up` wait in a queue, first come first served, for up to 600 seconds (`--timeout`). While it waits, the command names the lanes ahead of it and the holders of the devices.

A lane unused for longer than `idleHours` can be taken over, but only when no slot is free. The taker is told whose lane it was and since when it sat idle, and the old lane's services stop and its teardowns run.

## When a session dies

A lane whose owner has gone (its process exited, its pid now belongs to another process, or its worktree was deleted) is reaped by the next `claim` or `up` anywhere on the machine: its services stop, its driver and browser close, and its resources' teardowns run. The session-end hook does the same at once when a session ends normally. Nothing waits for a person to clean up.
