---
title: agentlane
problem: Run several AI coding agents on one machine, each with its own simulator, ports and database
description: >-
  Run several AI coding agents on one machine, each with its own ports, dev servers, database and simulator, emulator
  or browser. Works with Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Antigravity, on web, iOS and
  Android.
badge:
  text: Free, open source, runs on your machine
  href: https://github.com/north-star-hq/agentlane
headline: Stop your coding agents fighting over ports, simulators and databases.
marked: fighting
sentence: The fast, light way to run a copy of your app for every agent, with tools to see it and drive it, all at the same time.
figure: '**Reads the screen 50x faster** than stock Maestro.'
buttons:
  - label: Get started
    href: docs/getting-started.html
    primary: true
  - label: Star on GitHub
    href: https://github.com/north-star-hq/agentlane
    icon: star
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
  Claude Code, Codex and Cursor, each shown with its mark, get their own ports, dev server, database and a browser,
  iOS simulator or Android emulator from agentlane up. Each types an item into its own copy of the Basket app, ticks
  items off and takes screenshots, then Codex finishes and its ports and device are released.
cards:
  - icon: plug
    title: Its own ports
    text: Ports, dev servers and a database for each agent, so no two start a server on the same port.
    href: docs/services.html
  - icon: phone
    title: Its own device
    text: An iOS simulator, Android emulator or browser that no other agent can touch.
    href: docs/devices.html
  - icon: eye
    title: See and drive
    text: '`look`, `run` and `screenshot` work the same way on all three.'
    href: docs/drive.html
  - icon: shield
    title: Checked first
    text: "`doctor` confirms every server runs this worktree's code before the agent trusts it."
    href: docs/doctor.html
  - icon: play
    title: Proof you can open
    text: Videos, traces, logs and screenshots, kept after the agent is done.
    href: docs/evidence.html
  - icon: cycle
    title: Cleans up
    text: When the agent is done, its servers stop, its database goes and its device returns to the pool.
    href: docs/guard.html
about:
  title: What is agentlane?
  paragraphs:
    - >-
      agentlane is a free, open-source toolkit that gives each AI coding agent its own **lane**: a running copy of
      your project with its own ports, dev servers and database, and its own iOS simulator, Android emulator or
      browser. Agents use it through the `agentlane` CLI, an MCP server, and skills that teach them the loop, on web
      apps, iOS and Android.
    - >-
      New here? [What a lane holds](docs/lanes.html) explains the idea, and [Getting started](docs/getting-started.html)
      takes you from one command to a ready lane.
speed:
  - value: 0.15 s
    label: to read an iOS screen
  - value: 0.16 s
    label: to read a page in the lane's browser
  - value: 6.5 s
    label: to get an iOS build from the shared cache, against 91.5 s to build it
---
