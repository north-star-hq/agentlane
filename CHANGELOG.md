# Changelog

Newest first.

## Unreleased

### New

- **`npx agentlane init` with no flags.** init wires the agents whose files the project has (`CLAUDE.md`, `.codex/`, `.cursor/`, `.github/copilot-instructions.md`, `GEMINI.md`, `.agents/rules/` and others) or whose session runs it, and prints the reason for each. In a terminal it lists all six agents, checks the ones it found, and takes Enter, numbers or names. With no terminal and nothing found, it exits 2 and names `--agents` and `--all`, which work as before.
- **init installs the toolkit.** When the project's `package.json` doesn't list `agentlane`, init adds it as a dev dependency at its own version with the project's package manager (from the `packageManager` field or the lockfile: pnpm, yarn, bun or npm). A project with no `package.json` gets a private one. When the install fails, init keeps the files it wrote, exits 1 and prints the command to run. A project that already lists another version keeps it, and init says so. `--check` installs nothing.

### Fixed

- Maestro starts with the JDK in `AGENTLANE_JAVA_HOME` when `JAVA_HOME` is another version. `up`, `doctor` and the Android build already read it first, but `look`, `screenshot` and the other driving commands read only `JAVA_HOME`, so they refused a Java 21 `JAVA_HOME` that `doctor` had passed.
- `up` and `doctor` no longer fail capture hygiene on a Mac where the simulator reads its pinned status-bar time back as `9:41`. They accepted only `09:41`, which is how some Macs print it.
- `init` no longer lists 0.2.x's `.github/hooks/agent-env.json` as `unchanged` in a project that doesn't have it. It lists that file only when it changes or removes it.
- Under `exec` and in the signin hook, `maestro` is the lane's own Maestro, or it prints why the lane has none and exits 2. A lane whose `agentlane.json` was invalid or had no `driver` block, or that held no running simulator or emulator, ran whatever `maestro` came first on PATH, unbound to the lane's device, after one warning that named only the file. The message now gives the config's problems, or what is missing and how to add it. A project that ran its own Maestro under `exec` without a `driver` block adds `"driver": {}` to `agentlane.json`.
- The lane's `maestro` refuses `maestro mcp`, which takes its device from each tool call, so the lane can't bind it to its device. The lane's MCP server is `node_modules/.bin/agentlane mcp`.
- `maestro test`'s output goes to the lane's evidence folder only when `test` is the subcommand. A flow file named `test`, given to another subcommand, got a `--debug-output` folder too.
- On macOS, `agentlane driver install --from <zip>` clears the `com.apple.quarantine` attribute from the Maestro it unpacks. macOS's `unzip` copied a browser-downloaded zip's quarantine onto every unpacked file. Install still checks the zip's sha256 before unpacking.

### The patched Maestro

The patched Maestro build is renamed `2.11.0-agentlane.1`, and the toolkit downloads it over https from this repository's release, so first use no longer needs a signed-in `gh`. Compared with `2.11.0-agentenv.3`:

- The MCP `run` tool's result lists only the `env` the call passed. It used to list every `MAESTRO_*` variable in the driver's own environment as well. Flows still get those variables.
- On Android, a `tapOn` with `retryTapIfNoChange: true` and `waitToSettleTimeoutMs: 0` taps a second time again when the first tap changed nothing. The quick tap, which sends `retryTapIfNoChange: false`, still reads no hierarchy after the tap.
- When an iOS runner never answers within the startup timeout, Maestro stops the `xcodebuild` it launched for it. Before, `maestro test` left that `xcodebuild` running after it exited.
- On iOS, `maestro record`, `maestro hierarchy` and `maestro query` take a runner port the OS assigns when you pass no `--driver-host-port`, as `maestro test` already did. They used the fixed port 22087, so two lanes running them at once collided, and the second failed with "The XCTest runner port 127.0.0.1:22087 is held by a Maestro runner that refuses this process's token". A `--driver-host-port` you pass still wins.

## 0.3.0

The toolkit is called agentlane now, and what each agent session holds is a lane. The package, the command, the config file, the environment variables, the plugin, the output and the JSON all say agentlane and lane. Besides the rename, 0.3.0 adds `prune`, browsers for Intel Macs and Linux, and the fixes listed under New and Fixed. You still claim and release a lane, so the `claim` and `release` commands keep their names. 0.3.0 runs beside 0.2.x on the same Mac, so projects can move one at a time.

### Moving from 0.2.x

1. **Release the project's lanes first.** In each worktree, while 0.2.x is still installed, run `node_modules/.bin/agent-env release`. A lane 0.2.x started keeps 0.2.x's variables in its services and driver.
2. **Replace the dependency.** The package is `agentlane`, at 0.3.0, and its bin is `node_modules/.bin/agentlane`.
3. **Rename the config.** `agent-env.json` becomes `agentlane.json`, and its `"$schema"` points at `agentlane.schema.json`. `up`, `doctor` and `restart` refuse a project that still has only `agent-env.json`, and their message names these renames.
4. **Rename the variables.** Every `AGENT_ENV_` variable is `AGENTLANE_` now, in the config's commands, hooks, scripts, Maestro flows and test configs. Two change more than the prefix: `AGENT_ENV_CLAIM` is `AGENTLANE_LANE`, and `AGENT_ENV_CLAIM_TOKEN` is `AGENTLANE_LANE_TOKEN`. The settings you set yourself follow the prefix: `AGENTLANE_STATE_DIR`, `AGENTLANE_OWNER_PID`, `AGENTLANE_JAVA_HOME`, `AGENTLANE_MAESTRO` and `AGENTLANE_PLAYWRIGHT_BROWSERS`.
5. **Run `init` once.** `node_modules/.bin/agentlane init --agents <list>` replaces what 0.2.x's `init` wrote instead of adding a second copy. MCP server entries named `agent-env` become `agentlane`, and `.codex/config.toml` loses `[mcp_servers.agent-env]`. Hooks that ran `node_modules/.bin/agent-env` run `node_modules/.bin/agentlane`, and `.github/hooks/agent-env.json` becomes `.github/hooks/agentlane.json`. The skill stubs run `agentlane skills get`, and `disabledMcpjsonServers` names `agentlane`. Until `init` has run, `doctor` warns that the wiring is stale.
6. **The Claude Code plugin is `agentlane@agentlane`.** Where `.claude/settings.json` enables `agent-env@agent-env`, `init` enables `agentlane@agentlane` instead and renames the marketplace entry `agent-env` to `agentlane`, keeping its source. Rename an `agent-env@…` entry in your local or user settings by hand. The setup skill is `/agentlane:setup`, and the MCP server is `plugin:agentlane:device`. The marketplace's repository is still `north-star-hq/agent-env`.
7. **Update scripts that read the CLI.** The renamed commands, flags and JSON fields are listed below.
8. **Expect one uncached build.** The build cache moves to `.git/agentlane/build-cache`. The pinned Maestro, Playwright and agent-browser download again into `~/.local/share/agentlane/`. Once no worktree of the project runs 0.2.x, you can delete `.git/agent-env/`, and once nothing on the Mac runs it, `~/.local/share/agent-env/`.

### Renamed

- `claims --json` is `lanes --json`. Its output is `version: 2`: `claims` is `lanes`, a pool device's `claimId` is `laneId`, and a pending teardown's `claim` is `lane`.
- `release --claim <id>` is `release --lane <id>`.
- In `claim --json` and `up --json`, `claim` is `lane`. In `release --json`, each teardown's `claim` is `lane`. `driver status --json` gives `laneId`. `doctor`'s `claim` check is the `lane` check, and the refusal `claim-gone` is `lane-gone`.
- The CLI's output, the MCP tools' descriptions, the schema and the skills say lane. `claim` prints `claimed lane <id>`, and `status` lists `lanes`.
- Each lane's folder is `<state dir>/lanes/<id>`, where `$AGENTLANE_LOGS` and `$AGENTLANE_EVIDENCE` point.
- New pool devices are `agentlane-pool-*` simulators and `agentlane-emu-*` emulators.
- The bench report's schema is `agentlane-bench/1`.

### Sharing a Mac with 0.2.x

- **One registry.** While `~/.local/state/agent-env/registry.sqlite` exists and `~/.local/state/agentlane/registry.sqlite` doesn't, 0.3.0 uses 0.2.x's state folder as it is. Both versions then see every lane, and neither hands out a port, simulator, emulator or browser profile the other holds. A Mac that never ran 0.2.x gets `~/.local/state/agentlane/`.
- **0.2.x's names in 0.2.x's folder.** There, 0.3.0 writes only what 0.2.x reads: the registry stays format 1, lane folders stay under `claims/`, and new pool devices are named `agent-env-pool-*` and `agent-env-emu-*`, because 0.2.x boots only emulators with its own prefix. So either version can reap the other's lane once its owner is gone: stop its services, driver and browser, and run its resources' teardowns.
- **0.2.x's pool devices stay in the pool.** A free one goes to the next lane of either version, and 0.3.0 boots, stops and deletes `agent-env-emu-*` emulators as its own. `agentlane prune --yes` deletes the free ones along with 0.3.0's, and never one a 0.2.x lane holds.
- **Moving the folder.** Once no project on the Mac runs 0.2.x and `status` lists no lanes, run `mv ~/.local/state/agent-env ~/.local/state/agentlane && mv ~/.local/state/agentlane/claims ~/.local/state/agentlane/lanes`. 0.3.0 then uses the folder under its own name. Don't run 0.2.x on that Mac afterwards, because it would start a second registry.

### New

- `agentlane prune` lists the pool simulators and emulators that no lane holds, and `agentlane prune --yes` deletes them to free their disk. It works from the registry, so it covers the `agent-env-pool-*` and `agent-env-emu-*` devices 0.2.x made. Each deletion locks the registry and checks again that no lane of either version holds the device, so a lane claimed meanwhile keeps it. A device the registry has no record of is never deleted, even one with a pool name; the listing shows those apart, because a registry in another state folder may hold them. `--json` prints the listing and each result for tools.
- **Browsers for Intel Macs and Linux.** The pinned Chrome for Testing, its headless shell and ffmpeg now cover Intel Macs and Linux on x64 and arm64, so `up --platform web` installs its browser there without `AGENTLANE_PLAYWRIGHT_BROWSERS`. Linux runs the web half of a project; iOS needs a Mac, and Android on Linux isn't supported yet.
- **Chrome's system libraries on Linux.** `doctor` has a `browser libraries` check that names each library Chrome for Testing needs and the machine lacks, such as `libnss3.so`, and gives Playwright's `install-deps chromium` command as the fix. `up` stops with the same message before it opens the browser.
- Capture hygiene on a simulator has a new `keyboard-intro` step. It marks the keyboard's slide-to-type intro as shown (`com.apple.keyboard.preferences` `DidShowContinuousPathIntroduction` = true) and reads it back, so a fresh simulator's first keyboard no longer opens on an intro that covers the app. `doctor` lists the step with the others.
- The `create-verification-skill` skill tells a project to clear its app's own first-run sheets (onboarding, what's-new, permission prompts) before capturing, and to name them in its run skill.

### Fixed

- On Android, the build hook runs with `JAVA_HOME` set to the JDK the build cache key names: `AGENTLANE_JAVA_HOME`, else `JAVA_HOME`, else the JDK 17 agentlane finds. Before, with `JAVA_HOME` unset, Gradle could run a different JDK from the one the cached build was keyed to.
- On Linux, hooks run with `LANG` and `LC_ALL` set to `C.UTF-8`, which glibc always has, instead of `en_US.UTF-8`, which many images don't generate. `up` refused a web app on such a machine, citing CocoaPods. macOS keeps `en_US.UTF-8`.
- On Linux without `lsof` or `ss`, as in the `node:24` image, `up` reads a port's listeners from `/proc`. Before this, it never found a service's listener and timed out on a server that answered.

## 0.2.1

Fixes from running `setup` from scratch on a production app and on the example app, after 0.2.0 reached them. A project that vendors 0.2.0 should move to this one.

- `maestro test` under a claim keeps a passing run's folder, its `takeScreenshot` files included, and links every run into Maestro's own folder. 0.2.0 deleted a passing run's folder, so a flow's screenshots were lost and scripts reading `~/.maestro/tests` found nothing.
- A second `up --platform web` on a claim whose browser is open works. 0.2.0 failed with "Tracing has already been started".
- A web service started through a package manager (`pnpm exec next dev …`) passes `up`'s check that the server on the port is this worktree's, because a listener anywhere below the started process now counts.
- `init` wires Claude Code once wherever the plugin loads from, and removes the copies an earlier `init` wrote; `doctor` warns when both wire it.
- Every command the CLI and the skills tell you to run is `node_modules/.bin/agent-env …`, which works in every agent's shell.
- Simulator hygiene sets the location again, up to 3 times, when a set doesn't read back.
- Claude Code's SessionEnd hook declares a 10 s timeout, so the release isn't cut off by Claude Code's shared 1.5 s budget.
- The skills: `setup` runs every committed flow and test suite before and after its changes and lists each one; `create-verification-skill` pins the device when flows tap by point, writes a precondition per tool, seeds a page per feature the repo's docs list, and treats a wait that never matches in a sign-in flow as a defect.

## 0.2.0

0.2.0 adds web apps beside mobile apps, per-claim resources, the setup skill and wiring for six agents. A project moving from 0.1.x needs to know the items under "Moving from 0.1.x" first.

### Moving from 0.1.x

- **Run `init` again after you upgrade.** The skill stubs' text changed, so `doctor` warns that a project's stubs are stale until `node_modules/.bin/agent-env init --agents <list>` rewrites them. Warnings don't fail `doctor`.
- **Each claim has an evidence folder.** `$AGENT_ENV_EVIDENCE` (`<state dir>/claims/<id>/evidence`) is set in every hook and under `exec`. It survives `release` and goes when the claim's files are pruned, seven days after the claim ends. `node_modules/.bin/agent-env evidence screenshot | video start|stop | trace start|stop | logs | list` writes there, and a failed `run`, or a failed command under `exec` on a browser claim, keeps its own bundle there.
- **`maestro test` under a claim writes into the evidence folder.** In 0.1.x, Maestro wrote each run to its own folder, `~/.maestro/tests/<run>`. The claim's `maestro` now passes `--debug-output`, and each test's output, its `takeScreenshot` files included, lands in `$AGENT_ENV_EVIDENCE/<stamp>-maestro-test-<pid>/.maestro/tests/<run>/<flow>/`. The folder name ends in `-failed` when the test failed, which is also the path Maestro prints on a failure.
  - Each run is also linked into Maestro's own folder (`~/.maestro/tests/<run>`, or `$XDG_STATE_HOME/maestro/tests/<run>`), so a script that reads it keeps working. Maestro's folder holds the runs of every claim on the Mac, so a script that runs under a claim should read `$AGENT_ENV_EVIDENCE` instead.
  - A `--debug-output` or `--test-output-dir` you pass yourself goes to Maestro unchanged.
- **Printed commands are `node_modules/.bin/agent-env …`.** Every fix line the CLI prints, and every command in the skills and stubs, is written that way, run from the project root, because a bare `agent-env` is on the PATH only in Claude Code with the toolkit's plugin. A run skill that says bare `agent-env` works only there; write the full path.
- **The `device` skill is now `drive`.** It drives browsers too. A `device` skill remains and points to `drive`, so a run skill that names `device` still works.
- **`init` and the Claude Code plugin.** Wherever Claude Code loads the plugin (the project's settings, your local or user settings, or the session running `init`, as `--plugin-dir` does), `init` writes none of the plugin's skills, MCP server or hooks for Claude Code, and says where it found the plugin. It removes the copies an earlier `init` wrote, backing each file up first in `<state dir>/init-backups/`. An agent-env server in `.mcp.json` stays for other agents and is turned off for Claude Code with `disabledMcpjsonServers`. A project whose only agent is Claude Code through the plugin gets no toolkit stubs in `.agents/skills/`. `doctor` warns when the plugin and the project's own files both wire Claude Code.
- **The registry format is unchanged.** 0.1.3 and 0.2.0 worktrees share a Mac's registry: 0.2.0 adds tables that 0.1.3 doesn't read and keeps the format version 0.1.3 checks.

### New

- **Web apps.** `web` in `agent-env.json` names the service that serves the web app and the page to open. `node_modules/.bin/agent-env up --platform web` gives the claim its own browser (a profile, a debugging port and a driver session), opens the app, and signs it in through the `signin` hook, which writes Playwright storage state to `$AGENT_ENV_STORAGE_STATE`. The driver is Playwright (`playwright-cli`) by default, or agent-browser. The toolkit installs Playwright 1.64.0 and agent-browser 0.39.0 with their browsers in its own data folder, so a project's `@playwright/test` must be 1.64.x for its tests to find a browser under `exec`. Browser archives are pinned for Apple silicon Macs only; elsewhere, set `AGENT_ENV_PLAYWRIGHT_BROWSERS`. One claim can hold a device and a browser.
- **Service `platforms`.** A service can be limited to the apps that need it, so a web `up` doesn't start Metro.
- **Resources.** `resources` declares data each claim gets its own copy of, such as a database: a `create` command that exports values to every service, hook and `exec`, and a `teardown` that runs when the claim ends, after a crash too.
- **Six agents.** `node_modules/.bin/agent-env init --agents claude,codex,cursor,copilot,gemini,antigravity` (or `--all`) writes each agent's skill stubs, MCP server and hooks from one source. `--check` exits 1 when a file would change.
- **The setup skill.** It takes a project from no toolkit wiring to `doctor` ready on every platform. `up` and `doctor` name it when `agent-env.json` is missing or invalid, or no agent is wired.

### Fixed

- A service started through a package manager, such as `pnpm exec next dev`, is the service's. `pnpm exec` starts its command in a process group of its own, and `up` refused the server as a process the toolkit did not start. A listener below the service's process now counts, and stopping the service stops it too, even when the wrapper passes on no signal.
- `up --platform web` runs again on a claim whose browser is open. The second run failed at sign-in with "Tracing has already been started"; it now ends the running trace and starts a new one.
- A browser driver error during `up` or `exec` is reported with exit code 1 and a fix that works when `doctor` says ready (close the browser with `node_modules/.bin/agent-env exec -- playwright-cli close`, then `up` opens a new one), instead of escaping with a stack trace.
- `up` sets the simulator's location again, up to three times, when it doesn't read back, as happens on a freshly booted simulator under heavy load.
