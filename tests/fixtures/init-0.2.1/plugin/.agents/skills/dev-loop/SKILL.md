---
name: dev-loop
description: The contract for running a project's app as an agent with the toolkit - one claim per session and folder (a simulator or emulator, a browser, the ports for Metro, the API and the web app, and per-claim resources such as a database), `agent-env up` from bare worktree to running app, `doctor` before trusting an instance, `release` when done - plus what a project's run skill holds and what counts as proof and evidence from a running app. Use when about to run, build, launch or capture a project's mobile or web app, start its dev servers, hand an agent work that runs the app, or when an agent loses turns to ports, simulators, browsers, databases or half-started servers.
when_to_use: Booting a simulator or emulator, opening the web app in a browser, starting Metro or a dev server, running the app for verification, capture, e2e or debugging; dispatching agents that will run the app; a project with no agent-env.json or no run skill. Not for test-only work that never runs the app.
license: Parts adapted from cursor/plugins (pstack) under the MIT License, Copyright (c) 2026 Lauren Tan; the full notice is in LICENSE beside this skill in the toolkit package
---

Run `node_modules/.bin/agent-env skills get dev-loop` from the project root and follow what it prints. It prints this skill for the version of the toolkit installed in this project.
