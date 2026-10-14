---
title: "The CLI, the MCP server and the plugins"
short: "Which part an agent uses for what."
summary: "agentlane is one CLI. Agents reach it three ways: the CLI itself from a shell, the MCP server for `look`, `run` and `screenshot`, and the plugins and hooks that wire both into each agent. This page says which one to use for what, and why skills write every command as `node_modules/.bin/agentlane`."
---

## The CLI

Everything agentlane does is a command of one CLI, installed in the project as a dev dependency. Lanes, `up`, `doctor`, the device controls, evidence and the driver are all there, and every command an agent or a script needs works from a shell:

```sh
node_modules/.bin/agentlane up
node_modules/.bin/agentlane look --interactive
node_modules/.bin/agentlane release
```

Because it is a project dependency, each checkout runs the version its own lockfile pins, and two projects on one machine can run different versions. [CLI](cli.md) lists every command.

## The MCP server

`agentlane mcp` serves three tools over MCP on stdio: `look`, `run` and `screenshot`. They do what the commands of the same names do, for agents that would rather call a tool than run a shell command. `screenshot` returns the image itself, so the agent sees the screen without opening a file. `init` registers the server for every agent, under the name `agentlane`. [MCP server](mcp.md) lists each tool's arguments.

The server finds the lane from the session that runs it, so the tools take no device id or browser session. They can't reach another lane's device.

## The plugins and hooks

`init` writes each agent's own files: the skills, the MCP server entry and two hooks. The guard hook runs before each shell command and denies one aimed at another lane's simulator, emulator or browser. The release hook frees the session's lanes when the session ends. [The device guard and session hooks](guard.md) has the details.

Claude Code can load all of that as a plugin instead, which also puts `agentlane` on the Bash tool's PATH. Codex, Cursor and Gemini CLI can install the plugin's skills and MCP server from manifests in the same folder; their hooks still come from `init`. [Install for your agent](install.md) covers each agent.

## Skills

The skills tell an agent how to use all of this: `setup` wires a project, `dev-loop` is the contract for running the app, `drive` drives it, and the two verification skills write and maintain the project's run skill. The package carries their text, so a project's skills always match its installed version. [The skills](skills.md) shows each one.

## Which to use

| To                                             | Use                                                         |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Bring the app up, check it, release it         | The CLI: `up`, `doctor`, `release`                          |
| Read the screen, tap through a flow, see it    | The MCP tools, or `look`, `run`, `screenshot` from a shell  |
| Drive a browser lane                           | The driver's own CLI under `exec`, and `look` to read the page |
| Change a device setting, keep evidence         | The CLI: `device`, `evidence`                               |
| Run the project's own flows and tests          | `exec -- <command>`                                         |

## Why node_modules/.bin/agentlane

Skills and run skills write every command as `node_modules/.bin/agentlane <command>`, run from the project root. That path works in every agent's shell. A bare `agentlane` is on the PATH only in Claude Code with the plugin, and a skill has to work in whichever agent reads it. You can type `npx agentlane` yourself; it runs the same binary.
