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

The server speaks MCP over stdio. It finds the lane from the agent session that started it and the folder it runs in, so no tool takes a device id or a browser session, and no tool can reach another lane. A tool called before the session has a lane answers with the command that makes one. A tool called on a parked lane brings the lane back first, and every call counts toward the lane's last use.

While it runs, the server checks every minute whether the lanes on the machine need the sweep, which parks unused lanes and ends those whose owner is gone, and starts it in a process of its own when they do, so its tool calls never wait on it. [What a lane holds](lanes.md#the-sweep) describes the sweep.

The server serves the whole agent session. When one session holds lanes in several folders, as parallel subagents in their own worktrees do, each subagent should run `look`, `run` and `screenshot` as shell commands from its own worktree, or pass them `--worktree <dir>`.

The site builds the tool sections below from the server's own tool definitions.

## Tools

<!-- generated: mcp look -->

<!-- generated: mcp run -->

<!-- generated: mcp screenshot -->

## Where init registers it

`init` adds the server under the name `agentlane` to each agent's own config:

| Agent          | File                      | Time limit on one call                                 |
| -------------- | ------------------------- | ------------------------------------------------------ |
| Claude Code    | `.mcp.json`               | `"timeout": 1800000` only in place of a shorter one you set; Claude Code's own is about 28 hours |
| Codex          | `.codex/config.toml`      | `tool_timeout_sec = 1800`                              |
| Cursor         | `.cursor/mcp.json`        | none; Cursor has no setting for it                     |
| GitHub Copilot | `.mcp.json`               | `"timeout": 1800000`                                   |
| Gemini CLI     | `.gemini/settings.json`   | `"timeout": 1800000`                                   |
| Antigravity    | `.agents/mcp_config.json` | `"timeoutSeconds": 1800`                               |

Each agent stops an MCP call that runs past its own limit: 60 seconds in Codex, 30 in GitHub Copilot, 3 minutes in Antigravity and 10 in Gemini CLI. A first `look` or `screenshot` on a fresh iOS simulator can take several minutes, and the server waits up to 28 minutes for a `run`, so `init` sets each of those limits to 30 minutes. It raises a shorter value, and keeps a longer one or Antigravity's `-1`, which turns its limits off. In GitHub Copilot, Gemini CLI and Antigravity the same value also limits how long the server has to start, and 30 minutes is longer than each one's default. Where Copilot is wired too, Claude Code reads the same 30 minutes from `.mcp.json`. `doctor` warns when an entry has no limit or a shorter one, and names the file, the key and the value it needs.

The Cursor app documents no limit on an MCP call. Cursor's CLI and `agent acp` stop one after 60 seconds, and a project can't change that, so there a first call on a fresh iOS simulator can fail before the server answers.

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
