---
title: "Evidence"
short: "Screenshots, video, traces and logs that outlive the lane."
summary: "Each lane has an evidence folder that stays after release. `agentlane evidence` writes screenshots, videos, traces and logs there, and a failed run, or a failed command under `exec`, keeps its own evidence there without being asked. Maestro tests run under a lane write their output there too."
---

## The evidence folder

Every lane has a folder in agentlane's state, `~/.local/state/agentlane/lanes/<id>/evidence`. Hooks and `exec` commands get its path in `AGENTLANE_EVIDENCE`. It survives `release`, and goes seven days after the lane ends, with the rest of the lane's files.

```sh
npx agentlane evidence list
```

Each `evidence` command prints the path of what it wrote, so an agent can cite the file in its report. When the lane holds a device and a browser, `--device` and `--browser` pick which one.

## Screenshots

```sh
npx agentlane evidence screenshot
```

The same picture as `screenshot`, kept in the evidence folder: a JPEG from a device, a PNG from a browser.

## Video

```sh
npx agentlane evidence video start
# drive the change
npx agentlane evidence video stop
```

On a simulator it records with `simctl`, as H.264. On an emulator it uses `screenrecord`, which Android caps at 180 seconds. In a browser it records a WebM of the page. A video suits a change a person will review.

## Traces

```sh
npx agentlane evidence trace start
npx agentlane evidence trace stop
```

What a trace holds depends on what it traces:

| Target               | The trace                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| A Playwright browser | Playwright's action trace, which `npx playwright show-trace` opens. It runs from `up` on, so a `stop` without a `start` covers the session so far. |
| An agent-browser browser | A DevTools performance trace, between a `start` and a `stop`.                                     |
| A device             | What agentlane saw: the driver's log, the flows that ran, the screenshots they kept, and the device's log over the traced time. |

## Logs

```sh
npx agentlane evidence logs --since 5m
```

One bundle of the lane's logs over a window: the services, the hooks, the driver, the device's log and the browser console. `--since` takes minutes, seconds or hours, such as `90s` or `2h`.

## What a failure keeps

Evidence of a failure is kept without anyone asking:

- A failed `run`, and a failed command under `exec` on a browser lane, keep their own bundle: the trace, a screenshot, the screen or the page, and the driver's log or the console.
- `maestro test` under `exec` or in a hook writes its whole output to the evidence folder, its `takeScreenshot` files included, in a folder per run: `<stamp>-maestro-test-<pid>`, ending in `-failed` when the test failed.

Each Maestro run is also linked into Maestro's own `~/.maestro/tests`, so a script that reads that folder keeps working. That folder holds the runs of every lane on the machine, though, so a script that runs in a lane should read `$AGENTLANE_EVIDENCE`.

The project's Playwright tests can write there too: point `outputDir` at a folder under `AGENTLANE_EVIDENCE`, as [Browsers for web apps](browsers.md#your-own-playwright-tests) shows, and a failed run's trace survives the next run and the release.
