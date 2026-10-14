---
title: "Install for your agent"
short: "What init detects, installs and writes for each agent, and the Claude Code plugin."
summary: "agentlane works the same from Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Antigravity. `npx agentlane init` finds the agents your project uses, adds agentlane as a dev dependency, and writes each agent's own files from one source: the skills, the MCP server and the hooks. Claude Code can load agentlane as a plugin instead."
---

## One command

```sh
npx agentlane init
```

Run it at the root of your project, then commit what it writes. Every agent reads its files from the repository, and they hold no path or secret from your machine. The rest of this page says what `init` decides and what it writes.

## Which agents init wires

With no flags, `init` checks each agent in turn. It looks first for the variable that agent sets in the shells it runs commands in, which tells `init` that the agent itself is running it. Then it looks for that agent's files in the project.

| Agent          | Variable                                                      | Project files                                                                                    |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Claude Code    | `CLAUDE_PID`                                                  | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/`                                                       |
| Codex          | `CODEX_THREAD_ID`                                             | `.codex/`                                                                                        |
| Cursor         | `CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`                      | `.cursor/`, `.cursorrules`                                                                       |
| GitHub Copilot | `COPILOT_CLI`, `COPILOT_AGENT_SESSION_ID`, `COPILOT_RUN_APP`  | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/copilot/`, `.github/hooks/` |
| Gemini CLI     | `GEMINI_CLI`                                                  | `GEMINI.md`, `.gemini/`                                                                          |
| Antigravity    | `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_TRAJECTORY_ID`              | `.agents/rules/`, `.agents/workflows/`, `.agents/mcp_config.json`, `.agents/hooks.json`, `.agent/` |

`AGENTS.md`, `.mcp.json`, `.agents/skills/` and `.agents/plugins/` are read by several agents, so none of them names one.

In a terminal, `init` lists all six agents with the ones it found checked, and the signal beside each:

```text
Which agents do you use in this project?
  1. [ ] claude
  2. [ ] codex
  3. [ ] cursor
  4. [ ] copilot
  5. [x] gemini       GEMINI.md
  6. [ ] antigravity
Press Enter to wire gemini, or type the numbers or names to wire instead (such as 1,3 or claude,codex):
```

Outside a terminal, as when an agent runs it, `init` wires what it found and prints the signal for each. When it finds nothing, it exits 2 and asks for `--agents` or `--all`. Both flags work the same everywhere:

```sh
npx agentlane init --agents claude,codex
npx agentlane init --all
```

## The package

The hooks and the MCP server that `init` writes run `node_modules/.bin/agentlane`, found from the project folder upwards. So when the nearest `package.json` doesn't list agentlane, `init` adds it as a dev dependency, at `init`'s own version, with the project's package manager. It picks the manager from the `packageManager` field, then the lockfile, then the package manager that ran `init`, and uses npm when none of them names one.

| Package manager | Command `init` runs                                                     |
| --------------- | ----------------------------------------------------------------------- |
| pnpm            | `pnpm add --save-dev`, with `--workspace-root` at a workspace root      |
| Yarn            | `yarn add --dev`, with `--ignore-workspace-root-check` at a Yarn 1 workspace root |
| Bun             | `bun add --dev`                                                         |
| npm             | `npm install --save-dev`                                                |

- A project with no `package.json` gets a private one to hold the dependency. `init` warns when `node_modules/` isn't in `.gitignore`.
- A project that already lists agentlane keeps its version. `init` says so when that version differs from its own.
- When the install fails, the files `init` wrote stay. It exits 1 and prints the exact command to run.
- `init --check` writes and installs nothing, and exits 1 when a file would change.

## What init writes

Every agent gets the same skills, the same MCP server and the same two hooks, in the file and format that agent reads.

| Agent          | Skills                                                  | MCP server                | Guard and release hooks                         |
| -------------- | ------------------------------------------------------- | ------------------------- | ----------------------------------------------- |
| Claude Code    | `.agents/skills/`, linked into `.claude/skills/`        | `.mcp.json`               | `.claude/settings.json`                         |
| Codex          | `.agents/skills/`                                       | `.codex/config.toml`      | `.codex/hooks.json`                             |
| Cursor         | `.agents/skills/`                                       | `.cursor/mcp.json`        | `.cursor/hooks.json`                            |
| GitHub Copilot | `.agents/skills/`                                       | `.mcp.json`               | `.github/hooks/agentlane.json`                  |
| Gemini CLI     | `.agents/skills/`                                       | `.gemini/settings.json`   | `.gemini/settings.json`                         |
| Antigravity    | `.agents/skills/`                                       | `.agents/mcp_config.json` | `.agents/hooks.json` (the guard only)           |

Each skill file is a short stub that runs `node_modules/.bin/agentlane skills get <name>`, so the agent reads the skill for the version the project has installed. [The skills](skills.md) explains why.

`init` edits a file it shares with you, such as `.claude/settings.json`, in place: it adds or replaces only its own entries. Running it again changes nothing. A file it changes is backed up first, and a file it can't parse is refused, with nothing written.

## Per agent

Each agent asks you once to trust what `init` wrote. `init` prints these notes after it runs.

### Claude Code

Claude Code asks once to approve the MCP server in `.mcp.json`. The hooks are in `.claude/settings.json`: the guard on `Bash` and `Monitor` commands, and the release on `SessionEnd`, with a 10-second budget.

### Codex

Codex reads `.codex/` only in a trusted project. It runs each hook only after you review and trust it with `/hooks`, and again whenever the hook changes.

### Cursor

Cursor runs `.cursor/hooks.json` in the app. Its CLI runs hooks unreliably. The release at session end waits for the Cursor process to exit.

### GitHub Copilot

Copilot CLI loads the MCP server and the hooks once you trust the folder. It also runs Claude Code's hooks from `.claude/settings.json`.

### Gemini CLI

Gemini CLI warns when the project's hooks change, and asks before it activates a skill.

### Antigravity

Antigravity has no session-end hook. Its lanes are freed once Antigravity exits and the next claim on the machine reaps them.

## The Claude Code plugin

In Claude Code, agentlane can come from a plugin instead of the files `init` writes. The plugin brings the same skills, the MCP server as `plugin:agentlane:device`, the guard and release hooks, and `agentlane` on the Bash tool's PATH. It starts the MCP server from the project's own `node_modules/.bin/agentlane`, so the tools and the CLI are always the same version.

Install agentlane in the project as above, then commit this to `.claude/settings.json`:

```json title=".claude/settings.json"
{
  "extraKnownMarketplaces": {
    "agentlane": { "source": { "source": "github", "repo": "north-star-hq/agentlane" } }
  },
  "enabledPlugins": { "agentlane@agentlane": true }
}
```

Start setup with `/agentlane:setup`. Wherever Claude Code loads the plugin (the project's settings, your user settings, or `--plugin-dir` in the session that runs `init`), `init` leaves Claude Code to the plugin and removes the copies an earlier `init` wrote. `agentlane doctor` warns when a project wires Claude Code twice.

The same plugin folder holds manifests for Codex (`.codex-plugin/plugin.json`), Cursor (`.cursor-plugin/plugin.json`) and Gemini CLI (`gemini-extension.json`). They bring the skills and the MCP server. The hooks still come from `init`, because hooks don't carry over between agents.

## Checking the wiring

```sh
npx agentlane init --check
npx agentlane doctor
```

`init --check` exits 0 when every file is as `init` would write it. `doctor` prints a `wiring` line per agent, and warns when the wiring is missing or stale, for example after an upgrade changed the stubs.
