---
title: "The device guard and session hooks"
short: "Hooks that keep agents off each other's devices and browsers."
summary: "Before an agent's shell command runs, agentlane's guard hook denies `simctl`, `adb`, `emulator` and `avdmanager` commands aimed at a device another lane holds, and browser driver commands aimed at another lane's browser. When a session ends, the release hook frees every lane the session holds, in each agent that has a session-end event. `init` writes both hooks into every agent's project settings, and `doctor` proves they run."
---

Lanes keep agents apart only if agents use them. An agent that types `xcrun simctl install booted app.app` reaches whichever simulator is booted, which may be another agent's. The guard hook closes that gap, and the release hook makes sure lanes don't outlive their sessions.

## What the guard denies

Before each shell command an agent runs, the guard reads the command and denies it, the way the agent's own hooks block, when it aims at something another lane holds:

- `xcrun simctl`, `adb`, `emulator` and `avdmanager` commands aimed at a simulator or emulator that another lane holds;
- the ones that aim at every device while other lanes hold devices: `simctl ... booted` and `all`, an `adb` command with no device selected, and adb commands that act on every device;
- `playwright-cli` and `agent-browser` commands aimed at another lane's browser: its session (`-s=`, `--session`), its debugging or stream port (`--cdp`, `attach --cdp=`, `connect`);
- `playwright-cli kill-all`, which stops every Playwright browser on the machine.

The guard looks through the ways a command hides, such as `sh -c`, `npx`, package-manager scripts, variable assignments, quotes that split a name, and brace expansion (`adb -s emulator-55{54,60} shell`). The denial names the lane that holds the device and the command that recovers:

```text
agentlane: blocked: `xcrun simctl install booted build/Shop.app` aims at "booted", and a simulator this session doesn't hold here is booted.
  held by claude session 7f3c2a91 (pid 51204) in ~/code/shop/.claude/worktrees/search, since 2026-10-13 21:02:11; agentlane-pool-8e52b0 (iPhone 17, iOS 26.5), lane 71d66b95, last used 3m ago (up: doctor)
to recover:
  node_modules/.bin/agentlane up   (or agentlane claim: get a simulator of your own, then aim at "$AGENTLANE_DEVICE" with its UDID instead of "booted" or "all")
  node_modules/.bin/agentlane release --lane 71d66b95 --force   (only if you know that session no longer needs it)
  node_modules/.bin/agentlane status   (every lane with its owner)
```

## What it leaves alone

- Devices no lane holds, and simulators or emulators you made yourself.
- Commands aimed at the session's own lane: `$AGENTLANE_DEVICE`, and the browser session `exec` sets.
- Read-only commands that touch no device, such as `simctl list` and `adb devices`.
- Everything that isn't one of those tools.

The guard is a fence against mistakes, not a sandbox. An agent can still reach a device another way; the [skills](skills.md) tell it to use its own lane, and the guard catches the common slip.

## Which commands start the guard

Every shell command an agent runs passes through its guard hook, so the hook decides in the shell, before it starts Node, whether the command names `simctl`, `adb`, `emulator`, `avdmanager`, `playwright-cli`, `@playwright/cli` or `agent-browser`. A command that names none of them is allowed at once. The check reads a name however the command spells it: split by quotes (`xcrun 'sim'ctl`, `a''db`, `a$'d'b`, `a$"db"`), by backslashes or a line continuation, or made by brace expansion (`a{d,}b`, `e{nv,mulator}`). A command with braces that names none of the tools, such as `mkdir -p src/{a,b}`, still starts no Node.

When the guard lets through a command aimed at the session's own device or browser, that command counts as a call on the lane, so a lane an agent drives by hand isn't [parked](lanes.md#parking) under it.

## The session-end release

When a session ends, the release hook frees every lane the session holds, in every folder: it stops their services, runs their teardowns and frees their devices and browsers. The hook only starts the release in a detached process and returns, because agents give session-end hooks little time:

- Claude Code gives its session-end hooks 1.5 seconds, raised to the largest `timeout` a hook in a settings file declares. `init` writes the hook into `.claude/settings.json` with a 10-second timeout, so it gets 10 seconds. A plugin's timeouts don't raise the budget, so the plugin's own session-end hook gets 1.5 seconds, and it does nothing but start the release.
- Codex caps a session-end hook at 3 seconds, which is what `init` declares.

Where Claude Code runs both the plugin's hooks and the ones in `.claude/settings.json`, both guards give the same answer, and the session's lanes are released once. In Claude Code, `/clear` and `/resume` keep the lanes, because the Claude Code process that owns them is still running.

No agent fires a hook when it crashes, is killed or loses its terminal. A lane whose session ended that way is found by the sweep: within 5 minutes while an agentlane MCP server runs on the machine, otherwise at the next agentlane command. The sweep parks the lane at once and ends it 30 minutes later, unless the session comes back first. [What a lane holds](lanes.md#when-the-owner-is-gone) has the rules.

## Per agent

`init` writes both hooks into each agent's own project settings, so they run whether or not a plugin is installed.

| Agent          | Guard runs on                       | Release runs on                    |
| -------------- | ----------------------------------- | ---------------------------------- |
| Claude Code    | `PreToolUse`, for `Bash` and `Monitor` | `SessionEnd`                    |
| Codex          | `PreToolUse`, for `Bash`            | `SessionEnd`                       |
| Cursor         | `beforeShellExecution`              | `sessionEnd`, once the Cursor process exits |
| GitHub Copilot | `preToolUse`                        | `sessionEnd`                       |
| Gemini CLI     | `BeforeTool`, for `run_shell_command` | `SessionEnd`                     |
| Antigravity    | `PreToolUse`, for `run_command`     | None                               |

Antigravity gets the guard only, because it has no session-end event. Its `Stop` event fires when the agent's execution loop ends, with a `fullyIdle` field that is true once the agent and its background commands have finished. That marks the end of a turn, not of the session, so a release on it would end the lane after every turn. Using each agent's turn-end event as an idle signal is later work. Until then an Antigravity lane is parked 30 minutes after its last call, as every lane is, and ends 30 minutes after the sweep finds Antigravity gone.

Both hooks run the project's own `node_modules/.bin/agentlane hook pre-tool-use` or `hook session-end`, with `--agent` naming the agent. They look for it from the folder the hook runs in upwards, then in the other worktrees of the same repository, so a session started in a main checkout whose worktrees have the toolkit still reaches it. Where they find none, they exit quietly and block nothing.

## Checking the hooks

`agentlane doctor` has a `hooks <agent>` line for each wired agent. Each time a hook reaches the toolkit it leaves a mark, and `doctor` reads it. When the mark is missing, over a day old, or older than the hook file, the toolkit or the Node it ran on, `doctor` runs the guard hook itself on a harmless command and reports what happened. The line fails, with the fix, when the hook can't run: there is no toolkit to find, `node_modules/.bin/agentlane` dangles, the command is broken, or Claude Code is left to a plugin that isn't installed.
