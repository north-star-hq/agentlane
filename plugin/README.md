# The Claude Code plugin

One plugin, enabled per project. It brings:

- **The device tools.** An MCP server, `plugin:agentlane:device`, with `look`, `run` and `screenshot`; `look` and `screenshot` also read the lane's browser. The plugin starts it from the project's own installed toolkit (`node_modules/.bin/agentlane mcp`, found from the project folder upwards), so the tools and the CLI are always the same version. In a project without the toolkit installed, the server still starts, and every tool answers with the install command.
- **`agentlane` on the Bash PATH**, resolved the same way from the folder a command runs in.
- **Hooks.**
  - `PreToolUse` (Bash): denies `xcrun simctl`, `adb`, `emulator` and `avdmanager` commands aimed at a simulator or emulator that another lane holds. That includes `booted`, `all`, an `adb` with no device selected, and adb commands that act on every device. The denial names the holder and the command that recovers. Devices no lane holds are left alone. It also denies `playwright-cli` and `agent-browser` commands aimed at another lane's browser: its session (`-s=`, `--session`), its debugging or stream port (`--cdp`, `attach --cdp=`, `connect`), and `playwright-cli kill-all`, which stops every Playwright browser on the Mac.
  - `SessionEnd`: releases every lane the session holds and stops their services. The release runs in a detached process, because Claude Code gives session-end hooks 1.5 seconds. `/clear` and `/resume` keep the lanes, because the Claude Code process, which owns them, is still running.
- **Skills.**
  - `setup`: takes a project from no toolkit wiring to `doctor` ready on each of its apps. Start it with `/agentlane:setup`.
  - `drive`: driving the app on the lane's device or browser, turning a probe into a committed flow or test, and keeping evidence. `device` is its former name, kept as a pointer.
  - `dev-loop`: the run-loop contract (lanes, `up`, `doctor`, `release`) and what counts as proof.
  - `create-verification-skill` and `maintain-verification-skill`: writing a project's run skill and keeping it true. Both are adapted from cursor/plugins' pstack, under the MIT licence in each skill's folder in the toolkit's `skills/`.

## Enabling it in a project

Install the toolkit as a dev dependency at the project's root (`npx agentlane init` does that), then commit this to the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agentlane": { "source": { "source": "github", "repo": "north-star-hq/agentlane" } }
  },
  "enabledPlugins": { "agentlane@agentlane": true }
}
```

While developing the plugin, `claude --plugin-dir <checkout>/plugin` loads it for one session.

## Other agents

`npx agentlane init` in a project's root writes each agent's own files: the skill stubs in `.agents/skills/`, the MCP server in that agent's config, and the device guard and session-end hooks in its hook file. It covers Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Antigravity. With no flags it wires the agents whose files the project already has (`CLAUDE.md`, `.codex/`, `.cursor/` and so on) or whose session runs it, and in a terminal it lets you confirm or change them; `--agents <list>` or `--all` names them instead. When the project's `package.json` doesn't list the toolkit, init adds it as a dev dependency with the project's package manager, because the hooks and the MCP server run `node_modules/.bin/agentlane`. `agentlane doctor` names wiring that has gone missing or stale. Wherever Claude Code loads this plugin (the project's settings, your user settings, or `--plugin-dir` in the session that runs init), init leaves Claude Code to the plugin and removes the copies an earlier init wrote, and `agentlane doctor` warns when a project wires Claude Code a second time beside the plugin.

This folder also holds plugin manifests for agents that install plugins: `.codex-plugin/plugin.json` for Codex, `.cursor-plugin/plugin.json` for Cursor and `gemini-extension.json` for Gemini CLI (`gemini extensions install <checkout>/plugin`). They bring the skills and the MCP server. The hooks come from `init`, because hooks don't carry over between agents. Claude Code's hooks are in `hooks/claude.json` rather than `hooks/hooks.json`, the path Codex, Cursor and Gemini would otherwise read as their own, and the Codex manifest sets its hooks to none.

Every skill file here is a stub: it tells the agent to run `node_modules/.bin/agentlane skills get <name>` from the project root, which prints the skill for the toolkit version the project has installed. The skills write every toolkit command that way, because it runs in any agent's shell; the bare `agentlane` this plugin puts on the Bash PATH exists only in Claude Code. The skills' text lives in the toolkit's `skills/` folder.
