---
title: "Questions"
short: "Physical devices, what leaves your machine, Linux, monorepos, CI and cost."
summary: "Answers to what people ask before they adopt agentlane: which devices and hosts it covers, what runs on your machine and what leaves it, how it fits a monorepo or a CI job, and what it costs."
---

## Does it work with physical devices?

No. A lane holds an iOS simulator or an Android emulator from agentlane's pool. Those are what several agents can share on one machine without stepping on each other, and what `up` can create, boot, set up and reset on its own. Physical phones are outside what agentlane manages.

## Does agentlane send anything off my machine?

agentlane has no telemetry. It makes network requests only to download its pinned tools on first use: its Maestro build from agentlane's GitHub releases, Playwright and agent-browser from the npm registry, and Chrome for Testing and ffmpeg from Playwright's CDN. Each download is checked against a sha256 the package pins. [Where it runs](requirements.md#what-agentlane-downloads) lists them.

Stock Maestro calls its makers' servers for analytics, an update check, error reports and a report after `maestro test`. agentlane's build removes all four, its build fails when any of that code is still in it, and a live check watches a whole Maestro session for connections off the machine. Your own app and its servers reach whatever they reach; when a dev server's CLI sends usage telemetry, the `setup` skill turns it off in the service's start command.

## Does it run on Linux or an Intel Mac?

Linux on x64 and arm64 runs the web half of a project: ports, services, resources and a browser per lane. That covers cloud agents and Linux machines. iOS needs a Mac, and Android on Linux isn't supported yet. The browser builds for Intel Macs are pinned, but no Intel Mac has run agentlane, so that host is untested. [Where it runs](requirements.md) has the table.

## Does it work in a monorepo?

Yes. `up`, `doctor` and `restart` read `agentlane.json` from the current folder or the nearest folder above it, so the config can sit at the repository's root or beside one app. Each service's `cwd` points at its package, and `init` writes the agents' files beside the config. When it installs agentlane, `init` uses the nearest `package.json` and the workspace's package manager, with `--workspace-root` at a pnpm workspace root. The build cache lives in the repository's git folder, so every worktree shares it.

## Can I use it in CI, or without an agent?

Yes. Every command works from a plain shell, so a CI job can bring the web app up, run the project's tests in the lane, and release it:

```sh
npx agentlane up --platform web
npx agentlane exec -- npx playwright test
npx agentlane release
```

Without an agent, a lane belongs to the shell that claimed it, and it is reaped once that shell is gone. So run the three commands in one script or CI step, or set `AGENTLANE_OWNER_PID` to a process that lives as long as the lane should. Browsers run headless by default, and emulators always run without a window. On a slim Linux image, install Chrome's system libraries first; [Troubleshooting](troubleshooting.md#linux-browser-libraries) shows how.

## How many agents can run at once?

As many as the machine has room for. Ports come from blocks of 20 per service type. Devices come from a pool of 5 simulators and 5 emulators by default, inside a 20 GB memory budget, and you can raise all three in the registry's `config.json`. Web lanes need no device; the port blocks allow 20 lanes per service type, and you can widen them. When the pool is full, the next agent waits in a queue instead of failing. [What a lane holds](lanes.md) has the limits.

## Can subagents of one session share a lane?

They shouldn't, and they don't need to. A lane belongs to a session and a folder, so subagents that each work in their own worktree each get their own lane, with its own device, ports and data.

## Does agentlane change my app's code?

Only where it can't work otherwise. A server that hard-codes its port has to read it from `AGENTLANE_<NAME>_PORT`, and a mobile app has to take its API address at launch rather than from the build. The `setup` skill makes those changes, keeps your existing flows and tests passing, and lists every change in its summary.

## What happens to a lane's data when it ends?

Its resources' teardowns run, so a per-lane database is dropped. The lane's evidence folder, with its screenshots, videos, traces and logs, stays for seven days after the lane ends.

## What does it cost?

agentlane is free and MIT licensed. What it costs your machine is disk for the pool's simulators and emulators, which `prune --yes` gives back, and the memory of the devices your lanes hold. For your agents' token budgets, `look` returns the screen as a few lines of text, which costs far fewer tokens than a screenshot, and the warm driver keeps each call short. [What makes it fast](speed.md) has more.

## Can I run 0.3.0 beside 0.2.x?

Yes, on the same Mac, so projects can move one at a time. Both versions share one registry and see each other's lanes. The [changelog](../changelog.md) has the rules and the steps to move a project.
