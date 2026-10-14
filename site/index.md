---
title: agentlane
description: agentlane gives each AI coding agent its own lane, a running copy of your app with its own ports, dev servers, database, and browser, iOS simulator or Android emulator.
headline: Every coding agent gets its own running copy of your app
pitch: >-
  agentlane gives each agent session a lane: its own ports, dev servers and database, and its own iOS simulator,
  Android emulator or browser, with fast tools to see the app and drive it. Agents use it through the `agentlane`
  CLI, an MCP server (`look`, `run`, `screenshot`), and skills and hooks that teach them the loop.
install:
  - label: Run this in your project
    command: npx agentlane init
  - label: Then ask your agent
    prompt: Set this project up with agentlane.
agents:
  - Claude Code
  - Codex
  - Cursor
  - GitHub Copilot
  - Gemini CLI
  - Antigravity
heroAlt: >-
  Claude Code, Codex and Cursor, each shown with its mark, get their own lane from agentlane up: ports, dev server,
  database and a browser, iOS simulator or Android emulator. Each types an item into its own copy of the Basket app,
  ticks items off and takes screenshots, then Codex finishes and its lane is released.
why:
  - title: Every agent, one install
    text: Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Antigravity get the same CLI, MCP server, skills and hooks from one [`init`](docs/install.html).
  - title: Web, iOS and Android in one tool
    text: '[`look`, `run` and `screenshot`](docs/drive.html) work the same on a simulator, an emulator or a browser.'
  - title: The whole environment, per agent
    text: '[Ports, dev servers, a database and sign-in](docs/lanes.html), and a device or browser that no other agent touches.'
  - title: Skills that teach the loop
    text: '[Six skills](docs/skills.html) take an agent from setting the project up to proving a change with a committed flow or test.'
  - title: It checks the app before your agent trusts it
    text: "[`doctor`](docs/doctor.html) confirms that every server runs this worktree's code, and names the fix when one doesn't."
  - title: Evidence you can open
    text: '[Videos, traces, logs and screenshots](docs/evidence.html), plus the Maestro flows and Playwright tests your agent commits.'
  - title: It cleans up
    text: 'When a session ends, [its lane is released](docs/guard.html): services stop, databases are torn down, and devices go back to the pool.'
  - title: Local
    text: 'No account, no hosted service, and [no telemetry of its own](docs/faq.html#does-agentlane-send-anything-off-my-machine).'
speed:
  - value: 0.15 s
    label: to read an iOS screen on a warm lane
  - value: 0.16 s
    label: to read a page in the lane's browser
  - value: 6.5 s
    label: to get an iOS build from the shared cache, against 91.5 s to build it
speedNote: 'The reads are medians of 16 calls and the build is a single run, all on an Apple M4 Max. [How these were measured](docs/speed.html#how-these-were-measured).'
---
