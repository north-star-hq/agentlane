---
title: "Environment variables"
short: "What a lane exports, and the settings you can set."
summary: "Inside a lane, every service, hook and `exec` command gets the lane's variables: its id, its device, each service's port, the web app's URL, the resources' values, and the log and evidence folders. A few variables you set yourself change where agentlane keeps its state and which tools it uses."
---

## What a lane exports

`up` and `claim` print these as shell exports, and every service, hook and `exec` command gets them:

| Variable                | What it holds                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `AGENTLANE_LANE`        | The lane's id, such as `4b5850b6`. Name per-lane things after it, such as a database.                  |
| `AGENTLANE_LANE_TOKEN`  | The lane's secret. agentlane's commands use it to act for the lane, and `maestro` under `exec` binds its iOS runner to it. Resource commands don't get it. |
| `AGENTLANE_WORKTREE`    | The folder the lane belongs to.                                                                        |
| `AGENTLANE_PLATFORM`    | `ios`, `android` or `web`.                                                                             |
| `AGENTLANE_DEVICE`      | The simulator's UDID or the emulator's serial, such as `emulator-5584`.                                |
| `AGENTLANE_<NAME>_PORT` | Each service's port: `AGENTLANE_API_PORT`, `AGENTLANE_METRO_PORT`, `AGENTLANE_WEB_PORT`, and `AGENTLANE_BROWSER_PORT` for the browser's debugging port. A name with dashes uses underscores. |
| `AGENTLANE_WEB_URL`     | The web app's URL on the lane's port, such as `http://localhost:41300/`.                               |
| `AGENTLANE_VARIANT`     | The mobile build variant, `Debug` by default.                                                          |
| `AGENTLANE_LOGS`        | The lane's log folder.                                                                                 |
| `AGENTLANE_EVIDENCE`    | The lane's evidence folder, which outlives the lane by seven days.                                     |
| Your resources' exports | Each value a resource's `create` wrote, such as `DATABASE_URL`.                                        |

A lane's commands never take a variable a resource exports from the caller's environment, so a `DATABASE_URL` left in your shell can't point an agent at the wrong database. Commands also run with `LANG` and `LC_ALL` set to `en_US.UTF-8` on macOS and `C.UTF-8` on Linux.

## Only in some commands

| Variable                  | Who gets it                     | What it holds                                                                     |
| ------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `AGENTLANE_EXPORTS`       | A resource's `create`           | The file to write `NAME=value` lines to.                                          |
| `AGENTLANE_STORAGE_STATE` | The `signin` hook, and `exec` on a browser lane | The file of the lane's saved login, in Playwright's storage-state format. |
| `AGENTLANE_LAUNCH_ARGS`   | The `launch` hook               | The launch arguments that dial the lane's services, such as `-apiBaseUrl http://localhost:41201`. |

## On a browser lane

`exec` on a lane with a browser also sets:

| Variable                    | What it holds                                                        |
| --------------------------- | -------------------------------------------------------------------- |
| `AGENTLANE_BROWSER_DRIVER`  | `playwright` or `agent-browser`.                                     |
| `AGENTLANE_BROWSER_SESSION` | The driver session, such as `agentlane-4b5850b6`.                    |
| `AGENTLANE_BROWSER_PROFILE` | The lane's profile folder.                                           |
| `AGENTLANE_BROWSER_CDP`     | The browser's debugging URL, such as `http://127.0.0.1:41400`.       |
| `PLAYWRIGHT_TEST_BASE_URL`  | The web app's URL, which Playwright Test uses as `baseURL`.          |
| `PLAYWRIGHT_BROWSERS_PATH`  | agentlane's pinned browsers.                                         |
| `PATH`                      | The lane's driver wrapper first, so `playwright-cli` or `agent-browser` is agentlane's pinned build. |

It also sets the driver's own variables that bind it to the lane: `PLAYWRIGHT_CLI_SESSION` and Playwright's MCP settings for Playwright, or `AGENT_BROWSER_SESSION`, `AGENT_BROWSER_PROFILE` and the others for agent-browser.

## Settings you can set

| Variable                         | What it changes                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `AGENTLANE_STATE_DIR`            | Where the registry and the lanes' folders live. Default `~/.local/state/agentlane` (or under `$XDG_STATE_HOME`). |
| `AGENTLANE_OWNER_PID`            | The pid of the process that owns the lanes a command claims, for scripts that run outside an agent. |
| `AGENTLANE_JAVA_HOME`            | The JDK 17 for Maestro and the Android build, ahead of `JAVA_HOME`.                   |
| `AGENTLANE_MAESTRO`              | A Maestro binary to use instead of the pinned build, such as a local build. `doctor` flags it as not the release. |
| `AGENTLANE_PLAYWRIGHT_BROWSERS`  | A Playwright browsers folder to use instead of the pinned builds, for a host they aren't pinned for. |
| `AGENTLANE_INIT_PACKAGE`         | What `init` adds as the dev dependency instead of `agentlane@<its own version>`, such as a local tarball when you try out a build. |

`AGENTLANE_STATE_DIR`, `AGENTLANE_OWNER_PID` and `AGENTLANE_JAVA_HOME` pass through to a lane's hooks, services and `exec` commands. Every other `AGENTLANE_` variable in the caller's environment is dropped there, so one lane's values never leak into another's. agentlane also reads `XDG_STATE_HOME` and `XDG_DATA_HOME` for its folders, `JAVA_HOME` for the JDK, and `ANDROID_HOME` or `ANDROID_SDK_ROOT` for the Android SDK.
