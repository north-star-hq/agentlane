# Benchmark method

`agentlane bench` measures how long an agent waits for the toolkit's tools on a real simulator, and writes a dated report with the conditions it ran under. This page says what each figure measures and how to reproduce one.

## What it drives

The bench drives the example app in `examples/expo-app`: an Expo dev-client app with a counter, a list, a sheet and a second screen. Every call goes through `agentlane mcp`, the MCP server Claude Code and other clients start. The bench speaks to it over stdio as a client would, and times each `tools/call` from writing the request to reading the response line.

The bench owns its lanes. It sets `AGENTLANE_OWNER_PID` to its own pid for every command it runs, so the lanes, their services and their drivers end with it even if it is killed. When it finishes it runs `agentlane release` for each lane, which stops the services and the driver and shuts the simulator down.

## The matrix

Each cell is one state and one operation. The operations are:

| op         | the call                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| read       | `look` with no arguments: the whole screen, one line per element                                                        |
| screenshot | `screenshot` with no arguments: a full-size JPEG                                                                        |
| quick-tap  | `run` with `tapOn: {id: home-increment}` and `quick: true` (no wait for the screen to settle)                           |
| tap        | `run` with the same `tapOn`, settling as Maestro does by default                                                        |
| flow       | `run` of a four-step flow: tap `home-open-details`, assert `details-title`, tap `details-back`, assert `home-increment` |

The states, and what the timer covers in each:

| cell              | before each sample (untimed)                                                                                                                                                                               | timer starts                                                                                                     | timer stops                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| warm              | nothing: the driver is running and the app shows its home screen (checked once per batch)                                                                                                                  | the call is written                                                                                              | the answer arrives                                                            |
| relaunch          | nothing beyond warm                                                                                                                                                                                        | `run` of `launchApp` (`stopApp: true`) is written                                                                | the op answers on the restarted app's home screen                             |
| cold              | the app's home screen is checked with a warm read, then the driver is stopped and the bench checks that no driver, JVM, XCTest runner or xcodebuild for the lane remains, and that the simulator is booted | the call is written                                                                                              | the answer arrives (the driver, its JVM and the runner start inside the call) |
| first-interaction | the driver is stopped and checked gone as in cold, then `agentlane up --no-setup` runs and returns                                                                                                         | `up` has exited                                                                                                  | the op answers on the app's home screen                                       |
| cold-cold         | the driver is stopped, the simulator is shut down, and the bench checks that the simulator reads Shutdown and nothing of the lane's runs                                                                   | `agentlane up --no-setup` starts (it boots the simulator, installs the cached build if needed, launches the app) | the op answers on the app's home screen                                       |

"On the app's home screen" matters where the app has just been launched (relaunch, first-interaction, cold-cold): `up` and `launchApp` return before the JavaScript has drawn the screen. In those cells:

- a read is repeated until it shows `home-increment`; the repeats are inside the timer and counted as gate reads;
- a screenshot waits for such a read first, also inside the timer;
- taps and flows wait on their own, because Maestro's `tapOn` waits for the element.

The services (Metro and the example API) keep running in every cell. Restarting Metro would measure Metro's cold bundling, not the toolkit.

The warm cells drive two simulators, alternating call by call, when `--pair` names a second checkout. The other cells drive the first simulator only.

The JSON keeps the parts of each sample's span: for example `up`, its own steps (`up boot`, `up launch` and so on), `relaunch`, `gate` and `op`. It also keeps the untimed preparation, prefixed `untimed`.

## Statistics

- Each cell takes 16 samples per simulator by default (`--samples`). Fewer is allowed for a quick look, and the report says it is below the published minimum.
- Median and p90 are quantiles by linear interpolation between the closest ranks (Hyndman and Fan type 7, numpy's default).
- A sample above Q3 + 3 × IQR is listed as an outlier. It stays in every figure.
- A failed sample (an error answer, or a read without the anchor where none should be missing) is excluded from the figures and counted in the "failed" column. Three failures in a row on one simulator abort the batch, and the report says so.
- The bench exits 1 when any reported batch failed a sample or was aborted.

## Load

Other work on the Mac changes the numbers, so every batch records the load average (1, 5 and 15 minutes), the kernel's memory pressure level, the free memory percentage and swap use, at its start and its end.

- Before a batch starts, the bench waits up to `--load-wait` seconds (default 300) for the 1-minute load average to drop under `--max-load` (default: the number of CPU cores) and for the memory pressure level to read normal.
- A batch whose 1-minute load at its start or end reached the limit, or that saw memory pressure above normal, is flagged in the table and listed under "Batches run under high load".
- After the matrix, each flagged batch runs once more if the load has dropped by then. The summary uses the last attempt that wasn't flagged; every attempt stays in the JSON and the replaced ones are listed in the report.

A figure from a flagged batch is an upper bound, not the toolkit's speed. Publish only figures from batches that are not flagged.

## What a report records

- Host: model identifier, chip, cores, memory, macOS version and build, Xcode version and build, installed simulator runtimes, Node version.
- Each simulator: name, device type, iOS runtime, UDID, lane, Metro and API ports.
- The toolkit's version and git commit, and whether the checkout had uncommitted changes.
- Maestro: the pinned build's version, the sha256 of its release zip (the install verifies it), the sha256 of the CLI jar it ran, and what `maestro --version` printed. A run with `AGENTLANE_MAESTRO` set says so.

The report is `bench-<UTC start time>.md`, with the raw samples in `bench-<UTC start time>.json` beside it, in `<state dir>/bench/` (`~/.local/state/agentlane/bench/`) unless `--out` names a folder.

## Rerunning it

You need a Mac with Xcode and an iOS simulator runtime, JDK 17, CocoaPods, Node 24 and pnpm (through Corepack). The first run also does three one-time things, outside every timer:

- it downloads and verifies the pinned Maestro build (about 300 MB) into `~/.local/share/agentlane/maestro/`;
- `up` builds the example app with Xcode, which takes a few minutes (later runs in the same clone reuse the build cache);
- Maestro installs its XCTest runner on each simulator the first time it drives it.

The bench takes two simulators from the toolkit's pool and creates them if the pool has room (five by default). If the pool is full, `up` queues for one for up to ten minutes. Quit other simulators, emulators and builds first: the report flags every batch that ran with the 1-minute load average at or above the core count.

```bash
git clone <this repository> agentlane && cd agentlane
corepack pnpm install --frozen-lockfile
cd examples/expo-app && corepack pnpm install --frozen-lockfile && cd ../..

# a second checkout for the second simulator
git worktree add --detach ../agentlane-pair HEAD
(cd ../agentlane-pair/examples/expo-app && corepack pnpm install --frozen-lockfile)

cd examples/expo-app
node ../../src/cli.ts bench --pair ../../../agentlane-pair/examples/expo-app
```

The last two lines on stdout are the report and its JSON. Progress goes to stderr, one line per batch with its medians and load.

The full matrix takes about an hour and a half on an M4 Max: cold-cold and first-interaction run `up` for every sample. To run part of it:

```bash
node ../../src/cli.ts bench --cells warm --ops read,screenshot,quick-tap   # minutes
```

Two runs a day apart on an idle host should agree within 20% on the warm medians. To check:

```bash
node ../../src/cli.ts bench compare <first>.json <second>.json            # exit 0 when every warm median is within 20%
node ../../src/cli.ts bench compare a.json b.json --cells warm,cold --tolerance 0.1
```

## On Android

`--platform android` runs the same matrix on emulators from the pool: `up --platform android` builds the example's APK, and each lane drives its own emulator through its own patched `maestro mcp`. Two differences from iOS:

- A relaunch is `launchApp` with the API address as an intent extra, then `openLink` to the dev-client link with the lane's Metro port, because Android's dev client takes its bundler from that link, not from a launch argument.
- There is no cold-cold cell. An emulator lane boots its emulator when it claims it, and `up` doesn't boot one again, so the bench refuses `--cells cold-cold` with `--platform android`.

In the cold cell the bench also checks that Maestro's instrumentation (`dev.mobile.maestro`) no longer runs on the emulator before it starts the timer.

```bash
node ../../src/cli.ts bench --platform android --cells warm,cold --ops read,screenshot,quick-tap --pair ../../../agentlane-pair/examples/expo-app
```

## On the web

`--platform web` measures the example's web app on a browser lane: `up --platform web` starts the API and the web app, opens the page in the lane's own Playwright browser and signs it in through the project's `signin` hook. The bench then times four ops in the warm cell, with the browser up on the signed-in places page (checked once per batch by a read that shows its Shortest first button):

| op         | the call                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| read       | `look` over MCP with no arguments: the page, one line per element                                                                                                              |
| screenshot | `screenshot` over MCP with no arguments: a PNG of the viewport                                                                                                                 |
| click      | `agentlane exec -- playwright-cli click "getByTestId('sort-shortest')"`, which toggles the sort                                                                                |
| flow       | `agentlane exec -- playwright-cli run-code` of a three-step flow: fill the Place field, press Add place, wait for the new row (a write through the API to the lane's database) |

A click and a flow are timed from spawning `agentlane exec` to its exit, because that is the call an agent makes from its shell: the toolkit has no MCP tool that acts in a browser, and the driver's own CLI does. The time includes starting `agentlane exec` and `playwright-cli`, one process each per call. Only the warm cell exists for a browser; `--cells` other than `warm` and the device ops (`quick-tap`, `tap`) are refused, and `click` is refused on a device. `--pair` alternates two browser lanes, as it alternates two simulators.

```bash
node ../../src/cli.ts bench --platform web                  # about a minute
```

## Comparing with other tools

callstack's `agent-device` publishes a similar matrix (cold-cold, cold, warm, relaunch, first interaction) for its snapshot command. Its harness spawns a fresh CLI process per sample; this bench calls a running MCP server, which is how an agent in Claude Code uses the toolkit, so its figures include a Node process start and module load per call that these don't. Its cold-cold also clears the runner's derived data, which forces a runner rebuild; this bench's cold-cold keeps the Maestro runner installed on the simulator, and the toolkit installs it once per simulator on first use.
