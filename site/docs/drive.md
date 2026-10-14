---
title: "See and drive the app"
short: "`look`, `run`, `screenshot` and `record`, on a device or in a browser."
summary: "`look` prints what is on screen, one line per element. `run` takes Maestro YAML and prints what changed. `screenshot` saves the screen. Each one acts on the simulator, emulator or browser this session claimed for this folder, and never on another lane's. `record` turns a session's passing steps into a flow you can commit."
---

The same verbs work from a shell and over MCP. From a shell they are `agentlane look`, `run` and `screenshot`. Over MCP they are the [`look`, `run` and `screenshot` tools](mcp.md). None of them takes a device id: they act on what the session claimed for the folder it runs in.

## Reading the screen

```sh
npx agentlane look --interactive
```

On a device, `look` prints one line per element with its role, its id (the testID), its label and its state. On the example app's home screen:

```text
[button] id=home-increment "Add one"
[field] id=home-name-input "Type a name"
[switch] id=home-notify-switch
[button] id=home-open-sheet "Open sheet"
[button] id=home-open-details "Details"
[button] id=home-open-api "API"
```

| Flag                  | What it shows                                              |
| --------------------- | ---------------------------------------------------------- |
| `--interactive`       | Only what you can tap, toggle or type into                 |
| `--within <id\|label>` | Only that element's subtree                                |
| `--depth <n>`         | Only that many levels                                      |
| `--bounds`            | Each element's frame in points, for tapping by point       |
| `--raw`               | Maestro's own `inspect_screen` output                      |

Elements below the fold are summed up on a last `Off-screen:` line. A read that comes back nearly empty, as on a map or a canvas, comes with a screenshot, so the agent can tap what it shows by point.

In a browser, the first line is `Page: "<title>" at <url>`, then one line per element, indented by nesting, as `[role] ref=eN "name"`. The ref is what the driver's CLI acts on, and it changes after navigation. A browser look has no bounds or raw mode. When the lane holds a device and a browser, `--browser` and `--device` pick one.

## Running a flow

`run` takes Maestro YAML, runs it on the lane's device, and prints what changed on screen between the reads before and after:

```sh
npx agentlane run --yaml '- tapOn: { id: home-increment }' --app-id com.example.expoapp
npx agentlane run .maestro/home.yaml --env API_PORT=41201
echo '- tapOn: Details' | npx agentlane run -
```

Text that changes on its own, such as clocks and counters, is left out of the diff. So an empty diff after a tap means the tap changed nothing visible. `--quick` taps without waiting for the screen to settle, for exploring; its results aren't proof.

A failed step comes back with its kind, the step, whether the action reached the device (yes, no or unknown), the screen as it is now, and selectors that would match. "No" means nothing happened and a corrected retry is safe; "unknown" means look first, because the app may have moved. An absence check that Maestro passed is checked once more against the screen the step left, so a nearly empty read can't pass it by accident.

A `takeScreenshot` in the YAML lands in the lane's logs folder, under `shots/`, and `run` prints each file's path.

## Screenshots

```sh
npx agentlane screenshot
npx agentlane screenshot --scale 0.5 --out home.jpg
npx agentlane screenshot --crop 0,100,390,300
```

A device's screenshot is a JPEG and a browser's is a PNG. `--crop` takes a region in points, as `look --bounds` prints them. Use `look` to find elements, which costs far fewer tokens, and `screenshot` to judge how the screen looks.

## Recording a flow

Every passing `run` step of the session is recorded. Once a probe works, save the steps as a flow and commit it:

```sh
npx agentlane record show
npx agentlane record save .maestro/add-item.yaml
npx agentlane record clear
```

Steps that came from a flow file keep its `${NAME}` placeholders, so the saved flow needs the same values at replay. Steps you typed keep what you typed, such as a claimed port: swap those for the flow's variables before you commit.

In a browser, the steps become a Playwright test beside the project's others, written by role and label rather than refs. The `drive` skill walks agents through both.

## The warm driver

Each lane keeps one Maestro session running for its device, started by `up` and reused by every `look`, `run` and `screenshot`. Each call skips Maestro's start-up, so a look returns in a few tenths of a second and a tap in under a second. [What makes it fast](speed.md) has the details.

```sh
npx agentlane driver status
npx agentlane driver stop
npx agentlane driver start
```

The driver starts on its own at the first call when it isn't running. It stops when the lane is released.

## Running Maestro under exec

The project's own Maestro flows run through `exec`, where `maestro` is agentlane's build, bound to the lane's device, with JDK 17 and the lane's runner token:

```sh
npx agentlane exec -- maestro test -e API_PORT="$AGENTLANE_API_PORT" .maestro/api.yaml
```

Each run's output, its `takeScreenshot` files included, lands in the lane's evidence folder. [Evidence](evidence.md) says where.
