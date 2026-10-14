---
title: Getting started
short: One command in your project, then one sentence to your agent.
summary: Run `npx agentlane init` in your project, then ask your agent to set the project up with agentlane. Setup reads how your project runs, writes `agentlane.json` and a run skill, and brings each app up in a lane until `agentlane doctor` reports ready.
---

## What you need

- Node 24 or newer, and a project in a git repository.
- For a web app, a Mac or Linux. agentlane downloads the browser it drives.
- For an iOS app, a Mac with Xcode and an iOS simulator runtime.
- For an Android app, a Mac with the Android SDK, its emulator and a system image.
- To drive either mobile app, JDK 17, which Maestro needs.

[Where it runs](requirements.md) has the full list, including the system libraries Chrome needs on Linux.

## 1. Run init in your project

At the root of your project:

```sh
npx agentlane init
```

`init` does two things.

**It wires your agents.** It looks for each agent's files in the project, such as `CLAUDE.md`, `.codex/` or `.cursor/`, and for the variable an agent sets in the shell it runs commands in, and it prints what it found for each one. In a terminal it lists all six agents with the ones it found checked: press Enter to accept, or type the numbers or names you want instead. For each agent it writes the skills in `.agents/skills/`, the MCP server in that agent's config, and two hooks: one stops the agent from touching another lane's simulator, emulator or browser, and one releases the agent's lane when its session ends.

**It installs agentlane.** When your `package.json` doesn't list agentlane, `init` adds it as a dev dependency with the package manager the project uses: the `packageManager` field first, then the lockfile. The hooks and the MCP server run `node_modules/.bin/agentlane`, so each checkout uses the version in its own lockfile.

Commit the files `init` writes. Running it again changes nothing. When it does change a file, it backs the file up first, and it refuses a file it can't parse without writing anything.

To name the agents yourself, pass `--agents` with any of `claude`, `codex`, `cursor`, `copilot`, `gemini` and `antigravity`, or `--all`:

```sh
npx agentlane init --agents claude,codex
```

> [!TIP]
> In Claude Code you can load agentlane as a plugin instead. `init` then leaves Claude Code to the plugin. [Install for your agent](install.md) covers both.

## 2. Ask your agent to set the project up

Start your agent in the project and ask it:

```text
Set this project up with agentlane.
```

That starts agentlane's setup skill. You can also start it by name:

| Agent                   | How to start setup                                |
| ----------------------- | ------------------------------------------------- |
| Claude Code             | `/setup`, or `/agentlane:setup` with the plugin   |
| Codex                   | `$setup`                                          |
| Cursor                  | `/setup`                                          |
| GitHub Copilot CLI      | `/setup`                                          |
| Gemini CLI, Antigravity | Ask for the setup skill by name                   |

Setup works best on your agent's strongest model at its highest effort. In Claude Code, that is `/model opus` and `/effort xhigh`.

Setup reads how the project runs its apps, servers, data and sign-in. It asks you once, in one message, about the trade-offs and the facts it can't find. Then it:

1. writes `agentlane.json`, which says what a lane of this project holds: its services and their ports, the mobile app or the web app, data such as a database, and how to sign in;
2. writes the project's run skill, which tells any agent how to launch, drive and check the app;
3. brings each app up in a lane until `agentlane doctor` reports ready, runs the project's flows and tests there, and releases the lane.

It ends with a summary: each file it wrote, each decision and its reason, and what is left for you, such as a trust prompt your agent shows once. [How setup decides](setup.md) goes through each step.

## 3. Your first prompt

From now on, an agent that needs the app running starts its own lane. Try a prompt such as:

```text
Bring the app up in your lane, sign in, and send me a screenshot of the home screen.
```

The agent runs `node_modules/.bin/agentlane up`. In a fresh worktree, `up` claims free ports and a simulator, emulator or browser that no other lane holds, creates the lane's data, starts the servers, builds the mobile app or opens the web app, signs in and runs `doctor`. Run a second agent in a second worktree and it gets a lane of its own.

## 4. When you're done

When the agent's session ends, the session-end hook releases its lane: it stops the lane's servers, runs the teardown of its data and frees its device. Antigravity has no session-end hook, so its lane is freed the next time any agent claims a lane after the session has exited. To end a lane yourself, run this in the worktree that holds it:

```sh
npx agentlane release
```

The lane's evidence folder, with its screenshots, videos and logs, stays after the release.

## Next

- [What a lane holds](lanes.md) explains the model behind every command.
- [The skills](skills.md) shows what each skill gives your agent.
- [CLI](cli.md) lists every command.
