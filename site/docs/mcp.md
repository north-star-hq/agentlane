---
title: "MCP server"
short: "The `look`, `run` and `screenshot` tools over MCP."
summary: "`agentlane mcp` serves `look`, `run` and `screenshot` over MCP on stdio, for agents that call tools rather than shell commands. The tools act on the lane this session claimed for this folder, and `look` and `screenshot` read a browser lane too. `init` writes the server into each agent's config."
---

## Starting the server

You don't start it yourself: each agent starts it from the entry `init` wrote. By hand it is:

```sh
npx agentlane mcp
```

The server speaks MCP over stdio. It finds the lane from the agent session that started it and the folder it runs in, so no tool takes a device id or a browser session, and no tool can reach another lane. A tool called before the session has a lane answers with the command that makes one.

The server serves the whole agent session. When one session holds lanes in several folders, as parallel subagents in their own worktrees do, each subagent should run `look`, `run` and `screenshot` as shell commands from its own worktree, or pass them `--worktree <dir>`.

The site builds the tool sections below from the server's own tool definitions.

## Tools

<!-- generated: mcp look -->

<!-- generated: mcp run -->

<!-- generated: mcp screenshot -->

## Where init registers it

`init` adds the server under the name `agentlane` to each agent's own config:

| Agent          | File                      |
| -------------- | ------------------------- |
| Claude Code    | `.mcp.json`               |
| Codex          | `.codex/config.toml`      |
| Cursor         | `.cursor/mcp.json`        |
| GitHub Copilot | `.mcp.json`               |
| Gemini CLI     | `.gemini/settings.json`   |
| Antigravity    | `.agents/mcp_config.json` |

Each entry runs a short `sh` script that looks for `node_modules/.bin/agentlane` from the project folder upwards and runs its `mcp` command, so the tools always come from the version the project installed. Without agentlane installed, the server exits with a message that says to add it:

```json title=".mcp.json"
{
  "mcpServers": {
    "agentlane": {
      "command": "sh",
      "args": ["-c", "d=\"$PWD\"; while [ ! -x \"$d/node_modules/.bin/agentlane\" ] && [ \"$d\" != / ]; do d=$(dirname \"$d\"); done; if [ -x \"$d/node_modules/.bin/agentlane\" ]; then exec \"$d/node_modules/.bin/agentlane\" mcp; fi; echo \"agentlane: no node_modules/.bin/agentlane in $PWD or the folders above it; add the toolkit to this project\" >&2; exit 1"]
    }
  }
}
```

With the Claude Code plugin, the same server is `plugin:agentlane:device`, and in a project without agentlane it still starts and answers every call with the install command.
