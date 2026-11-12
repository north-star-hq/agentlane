---
title: "What a lane holds"
short: "Ports, a device or browser, data and processes, claimed per session and folder."
summary: "A lane is one agent session's running copy of the project: its own ports, its own simulator, emulator or browser, its own resources such as a database, and the processes started on them. A lane belongs to the session that made it and the folder it was made in. One registry per machine keeps every lane apart, across projects and agents. A lane nobody calls on is parked after 30 minutes, and a lane whose owner is gone ends 30 minutes after it was found gone."
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

One SQLite registry per machine, in `~/.local/state/agentlane/registry.sqlite`, holds every lane of every project and agent. Every claim takes the registry's lock, so two agents starting at the same moment can't take the same port or device. The lock covers only the registry's own bookkeeping: creating, listing and shutting down simulators and emulators happen outside it, so one lane's slow device work doesn't hold up another lane's claim or release. `status` shows the lanes:

```text
lanes (1):
  d2bc030e  claude session 7f3c2a91 (pid 51204)  [alive]
      folder       ~/code/shop/.claude/worktrees/checkout-fix
      started      2026-10-13 22:18:09   idle 2s   last action: exec: maestro
      held         until 2026-10-14 00:18:11 (1h 59m left): the user is reviewing the checkout screen
      device       agentlane-emu-4c1d9a (Pixel 8, Android API 36 (Google APIs, arm64-v8a)) emulator-5584  booted
      ports        metro 41100, emulator 5584
      process      metro pid 51388 (started Tue Oct 13 22:18:40 2026 UTC)  running
```

Each process the lane started shows as `running`, `gone`, or `can't tell` when `ps` can't read it. A pid that another process has taken counts as gone. `lanes --json` prints the same for tools. The machine-wide settings live beside the registry in `config.json`:

| Setting            | Default  | What it limits                                                     |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `poolSize`         | 5        | Simulators in the pool                                             |
| `emulatorPoolSize` | 5        | Emulators in the pool                                              |
| `memoryBudgetGB`   | 20       | Memory that claimed devices may use together (4 GB per simulator, 3.4 GB per emulator) |
| `parkMinutes`      | 30       | How long after its last call a lane is parked                      |
| `ports`            | see below | The port block of each service type                               |

`idleHours` is still accepted and does nothing in this version: only agentlane 0.4.1 and earlier read it. Remove it once no project on the machine runs those versions. They refuse a `config.json` that sets `parkMinutes`, so leave that setting out while any project still runs them.

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

## Queues

When the pool is full, `claim` and `up` wait in a queue, first come first served, for up to 600 seconds (`--timeout`). While it waits, the command names the lanes ahead of it and the holders of the devices.

No lane takes over another, however long it has gone unused. A claim short of a device waits in the queue, and one short of ports is refused, naming the lanes that hold them. Lanes nobody uses give their devices back by parking, so the queue moves without anyone ending them.

## A lane's life

A lane ends when its session says so, gives back what costs memory when nobody uses it, and ends on its own once its owner is gone:

| What happened                                              | What agentlane does                                      | When                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| The agent runs `release`, or the session-end hook runs     | Releases the lane                                         | At once                                                |
| No call on the lane                                        | Parks it                                                  | 30 minutes after its last call                         |
| The session ran `agentlane keep`                           | Keeps it up past that                                     | For the time asked: 1 hour by default, 24 at most      |
| The owner is gone                                          | Parks it                                                  | Within 5 minutes while an agentlane MCP server runs, otherwise at the next agentlane command |
| The owner is still gone                                    | Ends it, with everything `release` does                   | 30 minutes after it was found gone                     |
| The owner's Claude Code session or Codex thread comes back | Gives it the lane back, with its ports and data           | Any time in those 30 minutes                           |

A live owner's database is never dropped by a timer: only a release, the session-end hook or a gone owner ends a lane.

### What counts as a call

Idle time runs from the lane's last call. Every command and MCP tool that acts on the lane is a call: `up`, `exec`, `restart`, `doctor`, `keep`, `touch`, `look`, `run`, `screenshot`, `record`, `driver start`, `driver stop`, `evidence` and `device`. A long `exec` command, a long `up` hook and a long tool call each count once a minute while they run, so a 40-minute test suite never looks idle. A `simctl`, `adb`, `playwright-cli` or `agent-browser` command that the [guard](guard.md) lets through on the lane's own device or browser counts too. `status`, `lanes`, `driver status` and `evidence list` only read, and don't count.

### Parking

A parked lane has stopped its dev servers, its browser, its driver and Maestro, and any screen recording. It has shut its simulator or emulator down and given it back to the pool, and removed the bundler pin, the dial defaults and the `adb reverse` rules it set. It keeps its ports, its resources such as its database, its browser's saved login, and its record. `status` says since when it has been parked and what its next call brings back, and `lanes --json` has a `park` field.

The next call brings everything back before it runs: `exec`, `restart`, `up`, any MCP tool, and the CLI's `look`, `run`, `screenshot`, `record`, `driver start`, `evidence` and `device`. The lane gets its own device back when that is still free, and another from the pool when it isn't, waiting in the queue as `up` does when the pool is full. It skips the setup hook and the resources' `create`, since the lane still has what they made. `doctor` doesn't wake a lane: it warns `parked` and names the calls that do. A call that comes while the lane is being parked or brought back waits for that to finish, for up to 30 minutes, then refuses with `lane-busy`.

### Holding a lane up

When a person will look at the running app, the session holds its lane, so the simulator stays booted and the servers keep running past the park window:

```sh
npx agentlane keep --for 2h --reason "the user is reviewing the checkout screen"
```

`--for` takes minutes or hours, such as `45m`, `2h` or `1h30m`. It is 1 hour when left out, and a hold longer than 24 hours is refused. `--reason` is required, and `status` shows it with the hold's end. Running `keep` again replaces the hold, whether shorter or longer. The hold ends with the lane, at `release` or the session's end, and when the owner is found gone. `keep` counts as a call. On a parked lane it doesn't wake anything: the next call brings the lane back, and the hold keeps it up from then.

Nothing in `agentlane.json` or `config.json` holds lanes by default, because a project that held every lane would keep its simulators booted after every session.

### When the owner is gone

A lane's owner is gone when its process has exited, its pid now belongs to another process, or the lane's folder was deleted. A sweep that finds such a lane parks it at once and ends it 30 minutes later, with everything `release` does: it stops the services and recordings, runs the project's teardown hook and each resource's teardown, and gives the device back.

In those 30 minutes, the owner's own session can take the lane back. A Claude Code session that calls on the lane from its folder with the same `CLAUDE_CODE_SESSION_ID`, or a Codex thread with the same thread id, becomes its owner again, finds its ports and resource values unchanged, and its next call wakes the lane. This is how a lane survives a Claude Code background session that was stopped while idle and started again, or a crashed session that was resumed. No other session gets the lane, in that window or after it. Once the window has passed, the same session gets a new lane. Other agents and scripts have no session id that outlives their process, so their lanes get the same 30 minutes and nothing can take them back. `status` shows an `owner gone` line with when the lane ends and which session can still take it back.

The session-end hook releases at once, with no window, because it reports that the session is over.

### The sweep

There is no daemon and nothing to install. Every agentlane command checks, as it starts, whether the sweep has work to do, from one registry read. When it does, the command starts the sweep in a process of its own and carries on without waiting. Each running MCP server does the same every minute. The sweep:

- parks the lanes past the park window that no hold keeps up;
- asks the process table about the owners that no call or check has shown alive in the last few minutes, and parks the lanes of those that are gone;
- ends the lanes whose owner has been gone for 30 minutes;
- stops a screen recording that an ended lane left running;
- removes an ended lane's folder, its evidence with it, seven days after the lane ended.

When there is nothing to do, no sweep starts, and a sweep in which every owner was seen lately runs no `ps`. To run it on a schedule of your own, such as cron or launchd, call `reap`, which runs it now and prints what it did:

```sh
npx agentlane reap
```

The sweep logs to `sweep.log` in the state folder.
