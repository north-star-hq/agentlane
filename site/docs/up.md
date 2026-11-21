---
title: "Bring a worktree up"
short: "`agentlane up`, from a bare worktree to the running app."
summary: "`agentlane up` takes a worktree from bare to the running app on its own simulator or emulator, or to its web app's services in its own browser. It runs the preflight, claims the lane, runs setup, starts the shared services the lane needs, creates resources, builds through the build cache, starts the services, applies capture hygiene, launches and signs in, then runs doctor. Run it again and it reuses the lane."
---

## The steps

```sh
npx agentlane up
```

`up` prints one line per step with its time, and writes each hook's output to a log in the lane's folder, naming the log as the hook starts. It stops at the first step that fails and names the fix.

| Step                | What happens                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| preflight           | Checks the toolchain (Xcode, the simulator runtime, JDK 17, the hook locale) and your `before: claim` preconditions, before anything is claimed. |
| claim               | Claims the lane: a port per service, and a pool simulator or emulator for a mobile app or a browser for a web app. |
| setup               | Runs your `setup` hook, such as the dependency install. The device boots at the same time.                    |
| build preconditions | Runs your `before: build` preconditions.                                                                      |
| shared              | Starts each [shared service](shared.md) the lane's resources and services name in `needs`, unless it already answers. |
| resources           | Runs each resource's `create` the first time, and passes the values it exports on.                            |
| build               | Runs your `build` hook through the [build cache](build-cache.md), or installs a cached build.                 |
| services            | Starts each service on its port in its own process group, and waits for its ready check.                      |
| hygiene             | Sets the device's location, appearance, keyboard and status bar so screenshots are stable.                    |
| launch              | Launches the app on the lane's bundler and API ports.                                                         |
| signin              | Runs your `signin` hook.                                                                                      |
| driver              | Starts the warm Maestro session, so the first `look` is fast.                                                 |
| doctor              | Runs every [doctor](doctor.md) check and prints the result.                                                   |

The `shared` step shows only when `agentlane.json` declares shared services. A web app skips the device steps. It claims a browser, opens the web app in it, and signs in through the same `signin` hook, which writes the saved login the browser starts with. This is `up --platform web` on the example app in the agentlane repository, on Linux:

```text
agentlane up: preflight: hook locale (0.0 s)
agentlane up: claim: claimed lane 4b5850b6: no device, a playwright browser, api 41200, web 41300, browser 41400 (0.0 s)
agentlane up: setup: pnpm install --frozen-lockfile   (log: ~/.local/state/agentlane/lanes/4b5850b6/hooks/setup.log)
agentlane up: setup: done (0.1 s)
agentlane up: build preconditions: node_modules is installed (0.0 s)
agentlane up: resource db: node api/database.mjs create   (log: ~/.local/state/agentlane/lanes/4b5850b6/resources/db.log)
agentlane up: resources: created db (0.1 s)
agentlane up: service api: started on 41200 (pid 1890, log ~/.local/state/agentlane/lanes/4b5850b6/api.log) (0.3 s)
agentlane up: service web: started on 41300 (pid 1909, log ~/.local/state/agentlane/lanes/4b5850b6/web.log) (0.3 s)
agentlane up: browser: opened http://localhost:41300/ (playwright session agentlane-4b5850b6, debugging port 41400) (0.7 s)
agentlane up: signin: node scripts/signin.mjs   (log: ~/.local/state/agentlane/lanes/4b5850b6/hooks/signin.log)
agentlane up: doctor: ready (0.1 s)
agentlane up: ready in 2.0 s; logs in ~/.local/state/agentlane/lanes/4b5850b6
agentlane up: the web app is at http://localhost:41300/
```

## Choosing a platform

`--platform` picks `ios`, `android` or `web`. Without it, `up` uses `app.platform` from the config, or `web` when the config declares only a web app. A lane can hold a device and a browser at once: `up --platform web` after `up --platform ios` keeps the simulator and adds the browser.

```sh
npx agentlane up --platform android
npx agentlane up --platform web
```

A service limited by `platforms`, such as Metro for the mobile app, is left out of a web `up`.

## Running it again

Run `up` again in the same folder and it reuses the lane. It keeps every healthy service. A service that fails its check is replaced, and the line names the old pid and the check that failed. `--no-setup` skips the setup hook when it already ran in this worktree.

When a step fails, the lane stays, so the next `up` picks up where it stopped. `up` releases the lane only when it made the lane in this run and a precondition refused before anything started.

## Only the data: `--no-app`

Tests that read the project's database need its data, not its app. `up --no-app` brings up the data alone:

```sh
npx agentlane up --no-app
npx agentlane exec -- pnpm test
```

It runs the preflight with only the checks that need no device or browser, the preconditions that name no platform, setup, the `shared` step with the shared services the resources need, the resources, and doctor. It claims no device, browser or port, and builds, starts and launches nothing. The commands then run under `exec`, which gives them the resources' values.

- A project that declares no resources is refused, since there is no data to bring up.
- `--no-app` and `--platform` can't be used together.
- In a folder whose lane already has the app, `--no-app` is refused, and `exec` gives the command the resources' values there.
- A plain `up` later in the same folder adds the app to the lane, with the same data.

A data-only lane parks and wakes like any other: waking starts its shared services again. `doctor` checks its lane, its resources and its shared services, and `restart` refuses, since it runs no service.

## Restarting one service

To change one service's environment, such as a feature switch or an admin toggle, restart that service instead of the whole lane:

```sh
FEATURE_CHECKOUT_V2=1 npx agentlane restart api
```

`restart` stops the service and starts it again on the same port, with the lane's variables plus that call's environment, and returns once its ready check passes. The device, the app and the other services stay as they are. A variable you passed to `up` and not to `restart` is gone, so pass every one you still want. Before it stops the service, `restart` starts any shared service the lane needs that isn't running, so a failed shared start leaves the running service alone.

## Exports and JSON output

`up` prints the lane's variables on stdout as shell exports, and everything else on stderr:

```sh
eval "$(npx agentlane up)"
echo "$AGENTLANE_WEB_URL"
```

An agent's shell commands often start with a fresh environment, so `exec` is the surer way to run a command with the lane's variables:

```sh
npx agentlane exec -- npx playwright test
```

`exec` brings a [parked](lanes.md#parking) lane back before the command starts, and counts as a call on the lane once a minute while the command runs. The command reads what was piped to `exec`, and a Ctrl-C in the terminal reaches it. `exec` exits with the command's exit code.

`exec` ends with the process that ran it. When that process exits while the command runs, as when an agent's shell is killed, `exec` sends SIGTERM to the command and every process under it, then SIGKILL to whatever still runs 5 seconds later, and exits 129. So a test run or server started under `exec` doesn't outlive the agent that started it. If the caller is already gone when the command would start, the command never runs.

`up --json` prints the result as JSON instead: the lane, the platform, the web app's URL, the variables, each step with its time, and the doctor report.

## Releasing

```sh
npx agentlane release
```

`release` in the same folder stops exactly the processes `up` started, the browser and its driver included, runs the teardown hook and each resource's teardown, and frees the lane. The evidence folder stays. When the session ends, its hook does this for you.

`up` on a [parked](lanes.md#parking) lane brings back its device, its services and its app on the same ports, with the same data.
