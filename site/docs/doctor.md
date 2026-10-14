---
title: "Doctor"
short: "Is this instance worth driving? Read-only checks, each with its fix."
summary: "`agentlane doctor` answers one question before an agent trusts a running app: is this instance worth driving? It checks the lane, the toolchain, the device, the installed app, the launch, the services and capture hygiene, read-only. It exits 1 when a check fails, and names the fix for each failure."
---

```sh
npx agentlane doctor
```

`up` ends by running `doctor`, and agents run it again before they trust a running app and whenever something looks off. It changes nothing: every check reads.

## What it checks

| Check                            | It passes when                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `config`                         | `agentlane.json` exists and matches the schema. A failure names each field that breaks it.           |
| `wiring <agent>`                 | Each wired agent's skills, MCP server and hooks are as `init` writes them.                            |
| `lane`                           | This session holds a lane in this folder, with the platform's device or browser.                      |
| Toolchain                        | Xcode, the simulator runtime, Java 17, the hook locale and the pinned Maestro are there, as the platform needs. |
| `resource <name>`                | Each resource was created for this lane and exported its values.                                      |
| `device`                         | The lane's simulator or emulator is booted.                                                           |
| `device network`                 | On Android, `adb reverse` forwards the ports the app dials.                                           |
| `app installed`, `app running`   | The app is on the device and running.                                                                 |
| `app variant`                    | The installed build is the one `up` installed, not a build someone made by hand.                      |
| `launch`, `bundler pin`, `dials <service>` | The app was launched on this lane's bundler and API ports.                                  |
| `service <name>`                 | The service runs, answers its ready check, and the listener on its port runs this worktree's code.    |
| `hygiene`                        | Location, appearance, keyboard and status bar read back as set.                                       |
| `browser driver`, `browser libraries`, `browser` | The pinned driver is installed, Chrome finds its system libraries, and the browser on the lane's port is on this lane's profile. |
| `web app`                        | The web app's URL answers without a server error.                                                     |

## Reading the output

Each line starts with `ok`, `warn` or `FAIL`. A failed or warning line has a `fix:` line under it with the command or change that clears it. The last line is `ready`, or `not ready` with the count of failed checks. This is `doctor` on a web lane of the example app in the agentlane repository, on Linux:

```text
ok    config: /work/agentlane/examples/expo-app/agentlane.json
ok    wiring claude: through the plugin: the project enables the agentlane plugin in .claude/settings.json
ok    lane: lane 4b5850b6 held by process 825 in /work/agentlane
ok    hook locale: hooks run with LANG and LC_ALL C.UTF-8 (this shell has (unset))
ok    resource db: created for lane 4b5850b6, exports DATABASE_PATH
ok    browser driver: playwright 1.64.0, pinned, with Chrome for Testing in ~/.local/share/agentlane/playwright/browsers
ok    browser libraries: Chrome for Testing finds every system library it links
ok    browser: Chrome/156.0.8078.4 on debugging port 41400, with this lane's profile ~/.local/state/agentlane/lanes/4b5850b6/browser/profile, playwright session agentlane-4b5850b6
ok    service api: pid 1890 is running; listening on 41200; GET http://127.0.0.1:41200/health returned 200
ok    service web: pid 1909 is running; listening on 41300; GET http://127.0.0.1:41300/ returned 200
ok    web app: http://localhost:41300/
ready
```

And one of two failures from the same machine, before Chrome's system libraries were installed:

```text
FAIL  browser: the lane's browser is not running: nothing answers on its debugging port 41400
        fix: node_modules/.bin/agentlane up (it opens the web app in the lane's browser)
not ready: 2 checks failed
```

Do the fix it names, not a workaround. Most fixes are `up` again, which keeps what is healthy and redoes what isn't.

## Checking the other platform

`doctor` checks the platform `up` last ran for, else the config's. In a project with a mobile app and a web app, `--platform` checks the other:

```sh
npx agentlane doctor --platform web
npx agentlane doctor --platform android
```

A lane that holds the other platform's device fails the `lane` check, with the fix.

## Warnings

A `warn` line doesn't fail `doctor`. It flags something to fix soon:

- a project with no agent wired at all, with the `init` command that wires them;
- wiring that has gone stale, such as stubs an older version wrote;
- Claude Code wired twice, by the plugin and by the project's own files.

## JSON output

```sh
npx agentlane doctor --json
```

prints the report for tools: `ok`, the lane's id, and each check with its name, result, detail and fix. The exit code is 0 when every check passes and 1 otherwise.
