---
title: "agentlane and Simlock, agent-device, portless, worktrunk, Playwright, Maestro, Conductor and Paradev"
label: "The tools you already use"
short: "The tools agentlane works beside, what each does well and what a lane adds."
summary: "agentlane is the same idea as a git worktree, for the running app. A worktree gives each agent its own copy of the code, and a lane gives it its own copy of the app, up and running. Each entry below says what another tool does and what a lane adds to it."
---

## agentlane and Simlock

[Simlock](https://github.com/callstackincubator/simlock), from Callstack, leases iOS simulators, Android emulators and enrolled phones to coding agents that run in parallel. An agent asks for a device and gets one back, booted and checked, that no other agent touches until it lets go. A lane holds a [simulator, emulator](devices.md) or [browser](browsers.md) for one agent too, and adds the rest of the running app around it: its [ports, dev servers](services.md) and [database](resources.md).

## agentlane and agent-device

[agent-device](https://github.com/callstack/agent-device), also from Callstack, lets coding agents control mobile, TV, desktop and web apps through a CLI, an MCP server and a Node.js API, on more platforms than agentlane covers. It also coordinates device access between agents in parallel worktrees. A lane [starts the app's servers and database first](up.md), so what the agent drives already runs that worktree's code.

## agentlane and portless

[portless](https://github.com/vercel-labs/portless), from Vercel Labs, gives each dev server a free port and a stable, named `.localhost` URL, and gives each linked worktree a subdomain of its own. A lane adds the [database](resources.md) and the [simulator, emulator](devices.md) or [browser](browsers.md) that go with those servers.

## agentlane and worktrunk

[worktrunk](https://github.com/max-sixty/worktrunk) is a CLI for git worktrees, designed for running AI agents in parallel. You switch, list and remove worktrees by branch name, with hooks and shared build caches. A lane runs the app from each worktree, and [the same session in a second worktree gets a second lane](lanes.md#one-lane-per-session-and-folder).

## agentlane and Playwright

[Playwright](https://github.com/microsoft/playwright) drives Chromium, Firefox and WebKit with one API, and its `playwright-cli` is built for coding agents. agentlane drives the browser with it by default. A lane gives each agent [its own Chrome for Testing](browsers.md), with a profile no other lane can read, and [agentlane's hook](guard.md) stops one agent's commands from reaching another lane's browser.

## agentlane and Maestro

[Maestro](https://github.com/mobile-dev-inc/Maestro) tests Android, iOS and web apps through YAML flows, and its MCP server lets coding agents drive a live device. agentlane drives every simulator and emulator with it. [agentlane's patches](speed.md#our-maestro-patches) give each iOS simulator's runner a port of its own, so a second simulator doesn't start cold on every call, and agentlane keeps [a Maestro session warm](speed.md#a-warm-maestro-session) between calls.

## agentlane and Conductor

[Conductor](https://www.conductor.build/) runs Claude Code, Codex, Cursor and OpenCode in parallel, each task in its own workspace and branch, on your Mac or in Conductor Cloud's sandboxes. Each workspace gets its own range of ports for the app's servers. On your Mac, a lane adds a [database](resources.md) and a [simulator, emulator](devices.md) or [browser](browsers.md) to each workspace.

## agentlane and Paradev

[Paradev](https://github.com/ParadevAI/Paradev), formerly Superset, is an open-source desktop app for running CLI coding agents in parallel. Each task gets its own git worktree, branch and terminals, and a built-in browser previews each workspace's dev server. A lane gives each agent [an iOS simulator or Android emulator](devices.md) of its own as well.

## agentlane and your agent's own worktrees

Claude Code's `--worktree`, the Codex app's worktrees and Cursor's worktrees each give an agent its own checkout, so parallel edits don't collide. Codex and Cursor can also run setup scripts in every new one. A lane runs the app from that checkout, and [`doctor`](doctor.md) confirms that every server is running [that worktree's code](services.md).

## More tools nearby

- **[MobileBuildMCP](https://github.com/getsentry/MobileBuildMCP)** by Sentry, formerly XcodeBuildMCP, lets agents build, run and test iOS and macOS projects through MCP and a CLI.
- **The simulator and preview panes in agent apps** put a live device or web preview beside the conversation, so watching an agent work is part of the loop.

## What agentlane sets out to do

agentlane's job is the whole environment an agent needs to run your app, for every agent at once:

- **A full lane per agent.** Each session gets its own ports, dev servers, data, and simulator, emulator or browser, so parallel agents never share a port, a device or a database.
- **iOS, Android and web in one tool**, with one config, one set of commands and one lane that can hold a device and a browser together.
- **Every major agent.** Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Antigravity reach it through the CLI, the MCP server and the same skills.
- **Checks before trust.** `doctor` confirms that each server on a lane's ports runs that worktree's code, and that the app on the device is the build `up` installed.
- **Cleanup on its own.** A lane's servers stop and its data is torn down when the session ends, and a crashed session's lane is parked within minutes and ended 30 minutes later. A lane nobody uses gives its device back after 30 minutes.
- **Speed.** A warm driver per lane, a patched Maestro and a build cache shared by every worktree. [What makes it fast](speed.md) shows how.

[Honorable mentions](acknowledgements.md) credits the projects agentlane builds on.
