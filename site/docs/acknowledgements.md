---
title: "Honorable mentions"
short: "The projects agentlane builds on, and the ones it works beside."
summary: "agentlane stands on open-source work, and it shares the field with good tools that solve nearby problems. This page credits both, and says in a few lines what agentlane itself sets out to do."
---

## What agentlane builds on

- **[Maestro](https://github.com/mobile-dev-inc/Maestro)** by mobile.dev drives every simulator and emulator in agentlane. Its readable YAML flows are why an agent's probe can become a committed test with one command. agentlane ships a patched build under Maestro's Apache 2.0 licence, and the patches are public in the agentlane repository.
- **[Playwright](https://github.com/microsoft/playwright)** by Microsoft drives web lanes through `playwright-cli`, and it is the test runner most web projects already trust.
- **[agent-browser](https://github.com/vercel-labs/agent-browser)** by Vercel Labs is a browser CLI built for agents from the start, and agentlane offers it as a first-class driver.
- **[Chrome for Testing](https://github.com/GoogleChromeLabs/chrome-for-testing)** by Google Chrome Labs gives automation exact, versioned Chrome builds, which is how every lane on every host runs the same browser.
- **[pstack](https://github.com/cursor/plugins/tree/main/pstack)** by Lauren Tan is a set of skills for shipping careful, verifiable work with agents. Parts of agentlane's `dev-loop` skill and both verification skills are adapted from pstack's `create-verification-skill` and `maintain-verification-skill`: the run skill, the feature map and what counts as proof. They are used under the MIT License, Copyright (c) 2026 Lauren Tan, and each of those skills' folders carries the licence.

## What it works beside

- **[agent-device](https://github.com/callstack/agent-device)** by Callstack automates mobile apps for agents across iOS, Android and more platforms, as a CLI, an MCP server and a typed Node.js API.
- **The simulator and preview panes in agent apps** put a live device or web preview beside the conversation, so watching an agent work is part of the loop.
- **[MobileBuildMCP](https://github.com/getsentry/MobileBuildMCP)** by Sentry, formerly XcodeBuildMCP, lets agents build, run and test iOS and macOS projects through MCP and a CLI.

## What agentlane sets out to do

agentlane's job is the whole environment an agent needs to run your app, for every agent at once:

- **A full lane per agent.** Each session gets its own ports, dev servers, data, and simulator, emulator or browser, so parallel agents never share a port, a device or a database.
- **iOS, Android and web in one tool**, with one config, one set of commands and one lane that can hold a device and a browser together.
- **Every major agent.** Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Antigravity reach it through the CLI, the MCP server and the same skills.
- **Checks before trust.** `doctor` confirms that each server on a lane's ports runs that worktree's code, and that the app on the device is the build `up` installed.
- **Cleanup on its own.** A lane's servers stop and its data is torn down when the session ends, and a crashed session's lane is reaped by the next claim.
- **Speed.** A warm driver per lane, a patched Maestro and a build cache shared by every worktree. [What makes it fast](speed.md) shows how.

The Android robot in the animation is Google's, used under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
