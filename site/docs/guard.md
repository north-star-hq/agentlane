---
title: "The device guard and session hooks"
short: "Hooks that keep agents off each other's devices and browsers."
summary: "Before an agent's shell command runs, agentlane's guard hook denies `simctl`, `adb`, `emulator` and `avdmanager` commands aimed at a device another lane holds, and browser driver commands aimed at another lane's browser. When a session ends, the release hook frees every lane the session holds, in each agent that has a session-end event."
---

Lanes keep agents apart only if agents use them. An agent that types `xcrun simctl install booted app.app` reaches whichever simulator is booted, which may be another agent's. The guard hook closes that gap, and the release hook makes sure lanes don't outlive their sessions.

## What the guard denies

Before each shell command an agent runs, the guard reads the command and denies it, the way the agent's own hooks block, when it aims at something another lane holds:

- `xcrun simctl`, `adb`, `emulator` and `avdmanager` commands aimed at a simulator or emulator that another lane holds;
- the ones that aim at every device while other lanes hold devices: `simctl ... booted` and `all`, an `adb` command with no device selected, and adb commands that act on every device;
- `playwright-cli` and `agent-browser` commands aimed at another lane's browser: its session (`-s=`, `--session`), its debugging or stream port (`--cdp`, `attach --cdp=`, `connect`);
- `playwright-cli kill-all`, which stops every Playwright browser on the machine.

The guard looks through the ways a command hides, such as `sh -c`, `npx`, package-manager scripts and variable assignments. The denial names the lane that holds the device and the command that recovers:

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

## The session-end release

When a session ends, the release hook frees every lane the session holds, in every folder: it stops their services, runs their teardowns and frees their devices and browsers. The release runs in a detached process, because agents give session-end hooks little time; Claude Code gives them 1.5 seconds by default, and `init` declares a 10-second budget for this one. In Claude Code, `/clear` and `/resume` keep the lanes, because the Claude Code process that owns them is still running.

A lane whose session died without the hook, after a crash or a killed terminal, is reaped by the next `claim` or `up` on the machine.

## Per agent

| Agent          | Guard runs on                       | Release runs on                    |
| -------------- | ----------------------------------- | ---------------------------------- |
| Claude Code    | `PreToolUse`, for `Bash` and `Monitor` | `SessionEnd`                    |
| Codex          | `PreToolUse`, for `Bash`            | `SessionEnd`                       |
| Cursor         | `beforeShellExecution`              | `sessionEnd`, once the Cursor process exits |
| GitHub Copilot | `preToolUse`                        | `sessionEnd`                       |
| Gemini CLI     | `BeforeTool`, for `run_shell_command` | `SessionEnd`                     |
| Antigravity    | `PreToolUse`, for `run_command`     | None: the next claim reaps its lanes once Antigravity exits |

Both hooks call `agentlane hook pre-tool-use` and `agentlane hook session-end` from the project's `node_modules/.bin/agentlane`, with `--agent` naming the agent. In a project without agentlane installed they exit quietly and block nothing.
