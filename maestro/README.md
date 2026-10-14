# Our Maestro build

The toolkit drives simulators with a patched [Maestro](https://github.com/mobile-dev-inc/Maestro). This directory holds the upstream pin, the patches, and the script that turns them into a release zip.

| File                                                                                                 | What                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `upstream.env`                                                                                       | The pinned upstream repository, tag and commit, and our `BUILD_VERSION`                               |
| `patches/NNNN-<slug>.patch`                                                                          | `git format-patch` files, applied in lexical order with `git am`                                      |
| `build.sh`                                                                                           | Builds the release zip                                                                                |
| `test/live_check.py`, `test/token_check.py`, `test/no_egress_check.py`, `test/element_type_check.py` | Live checks of a built zip on booted simulators                                                       |
| `test/no_telemetry.sh`                                                                               | Fails if an unpacked distribution still carries telemetry; `build.sh` runs it                         |
| `verify-release.sh`                                                                                  | Checks a published release (or a local build with `--from-dir`) the way the toolkit will on first use |
| `LICENSE-maestro`, `NOTICE`                                                                          | Maestro's license and the list of files we change                                                     |

## Building

You need macOS, Xcode with the iOS Simulator platform, JDK 17, and network access for the first clone.

```bash
maestro/build.sh              # writes maestro/out/
maestro/build.sh --out DIR    # writes DIR/
```

A local build is stamped `<BUILD_VERSION>+local.<short commit>` (with `.dirty` when the checkout has uncommitted changes), for example `2.11.0-agentlane.1+local.abc1234`, so it can't pass as the release; only the release workflow passes `--release` and builds the plain `BUILD_VERSION`. The script writes `maestro-<version>.zip` and `maestro-<version>.zip.sha256`; check the zip with `shasum -a 256 -c maestro-<version>.zip.sha256` from that directory. It finds JDK 17 in `JAVA_HOME`, then through `/usr/libexec/java_home -v 17`, then in Homebrew's `openjdk@17`. If `JAVA_HOME` is set, it must point at a JDK 17.

The steps, in order:

1. Check the preconditions: JDK 17, a working `xcodebuild` and the iOS Simulator SDK. A missing one stops the script within seconds, and the message names the fix.
2. Take `maestro/work/build.lock` with macOS's `shlock`, so a second `build.sh` in the same checkout stops with the first one's pid instead of overwriting its work. The lock goes when the script exits; a lock whose process has gone is taken over. Then clone the tag into `maestro/work/Maestro` and check that it is the pinned commit. Later runs reset that clone to the pinned commit instead of cloning again, so a re-run needs no cleanup. Delete `maestro/work/` to force a fresh clone.
3. Apply `patches/` with `git am`. A patch that doesn't apply stops the build and names the patch.
4. Check that `NOTICE` lists exactly the files the patches change. If not, the script prints the expected file and the `cp` command that installs it.
5. Build the iOS simulator runner from source with upstream's `build-maestro-ios-runner.sh`. That script refuses to run unless its directory is named `Maestro`, which is why the clone has that name. A failed runner build fails the script.
6. Run the runner library's Swift tests (`swift test` in `maestro-ios-xctest-runner/MaestroDriverLib`), which include the token check's `RunnerTokenTests`.
7. Run Gradle once: the unit tests, re-run every time rather than taken from Gradle's cache, and `:maestro-cli:distZip`. The tests are all of `maestro-ios-driver`, `maestro.xctestdriver.*`, `IOSDriverTest`, `AndroidDriverWindowSettleTest` and `TapRetryTest` in `maestro-client`, `EnvTest` in `maestro-orchestra-models`, and `maestro.cli.mcp.*` and `MaestroSessionManagerTest` in `maestro-cli`. The script fails unless the tests that pin each patch's behaviour ran; `require_test` in `build.sh` lists them with their patch numbers. Gradle's own `buildIosDriver` task is excluded with `-x`, because upstream's wrapper script for it ignores failures and step 5 has already built the runner.
8. Unpack the distribution, check that `maestro --version` prints `BUILD_VERSION`, and check that the runner files inside `lib/maestro-ios-driver.jar` are byte-identical to the ones step 5 built and differ from the prebuilt zips committed upstream.
9. Run `test/no_telemetry.sh` on the unpacked distribution. It extracts every jar once (about a minute) and fails on a `posthog*.jar` in `lib/`, on a PostHog, error-reporter, screen-report, update-check or Viewer-hint class, or on any of their endpoint and text strings.
10. Add `LICENSE-maestro` and `NOTICE` to the zip, write the zip and its `.sha256`, and verify the checksum.

Logs go to `maestro/work/logs/` (`runner.log`, `swift-test.log`, `gradle.log`, `no-telemetry.log`). Only the simulator runner is rebuilt. The prebuilt real-device runner in the jar (`driver-iphoneos`) stays upstream's, because building it needs a signing team and the MCP server drives simulators only. See "The runner token" for what that means for real devices.

To install the zip, unzip it and run `maestro/bin/maestro` with `JAVA_HOME` set to a JDK 17.

## Versions

`BUILD_VERSION` in `upstream.env` is the one place our version lives. It is `<upstream CLI version>-agentlane.<patch level>`, for example `2.11.0-agentlane.1`. It names the zip, and `maestro --version` prints it (patch 0004). The release workflow can read it from `upstream.env`, which holds only `KEY=VALUE` lines, so it can also be appended to `$GITHUB_ENV` as is.

Once a release of a version is published, the next change to the patch set bumps the patch level. A new upstream tag resets it to 1. The script checks that the version matches the tag.

Maestro's own `version.properties` keeps the plain upstream version under `version`, because Maestro parses that key as `major.minor.patch` for the update check, the cloud API headers and the real-device driver build. Patch 0004 adds a `buildVersion` key for `--version`.

## Releasing

Push a tag `maestro-v<BUILD_VERSION>` on a commit that holds the version you want. `.github/workflows/release-maestro.yml` runs on a `macos-26` runner with Xcode 26.6 and JDK 17. It refuses a tag that doesn't match `upstream.env` and a tag that already has a release. Then it runs `build.sh --release`, checks the output with `verify-release.sh --from-dir`, and publishes a release with the zip, its `.sha256`, and notes listing the patches and the sha256. A published version is never rebuilt: change the patch set, bump the patch level, and tag again.

Check a published release with `maestro/verify-release.sh maestro-v<BUILD_VERSION>`, or a local build with `maestro/verify-release.sh --from-dir maestro/out`. It checks the checksum, `maestro --version` and an MCP `initialize` handshake, and prints the sha256 the toolkit pins.

## Patches

| Patch | What                                                                                                                                                                                                                                                                                                                                                                                                    | Upstream                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0001  | A runner port per MCP iOS session instead of the fixed 22087                                                                                                                                                                                                                                                                                                                                            | [#3647](https://github.com/mobile-dev-inc/Maestro/pull/3647), authored by its PR author                          |
| 0002  | Rebuild a dead MCP session instead of failing every later call                                                                                                                                                                                                                                                                                                                                          | [#3385](https://github.com/mobile-dev-inc/Maestro/pull/3385), authored by its PR author, applied on top of #3647 |
| 0003  | Release a session's runner port when the session closes, is rebuilt, fails to start, or the server shuts down. A session that fails to start stops its driver before it releases the port                                                                                                                                                                                                               | ours                                                                                                             |
| 0004  | `maestro --version` prints `BUILD_VERSION`                                                                                                                                                                                                                                                                                                                                                              | ours                                                                                                             |
| 0005  | Stop a session's `xcodebuild` when the session closes, even if its runner has died, and when its runner never comes up within the startup timeout. Without it, every rebuild of a dead session leaves the old `xcodebuild` running beside the new one, and a failed start leaves one running after Maestro exits                                                                                        | ours                                                                                                             |
| 0006  | Put each iOS element's `XCUIElement.ElementType` raw value in the hierarchy's `class` attribute, so `inspect_screen` shows it as `cls` (9 is a button, 75 a cell)                                                                                                                                                                                                                                       | ours                                                                                                             |
| 0007  | On Android, `waitToSettleTimeoutMs: 0` on a `tapOn` skips the fixed 750 ms window-settle loop, which otherwise ignores the timeout. The toolkit's quick tap sends 0                                                                                                                                                                                                                                     | ours                                                                                                             |
| 0008  | On Android, `waitToSettleTimeoutMs: 0` also skips the settle after the tap, two hierarchy reads that each wait up to 500 ms on the device. With `retryTapIfNoChange: true`, a tap that may be retried still reads the hierarchy once to decide                                                                                                                                                          | ours                                                                                                             |
| 0009  | The MCP `run` tool's result lists only the `env` the call passed. It used to add every `MAESTRO_*` variable from the server's environment, which flows still get                                                                                                                                                                                                                                        | ours                                                                                                             |
| 0010  | Remove the update check, which called `api.copilot.mobile.dev` at every start whatever `MAESTRO_DISABLE_UPDATE_CHECK` said                                                                                                                                                                                                                                                                              | ours                                                                                                             |
| 0011  | Remove the error reporter, which sent the exception and the command line and had no switch                                                                                                                                                                                                                                                                                                              | ours                                                                                                             |
| 0012  | Remove the screen report sent after `maestro test`                                                                                                                                                                                                                                                                                                                                                      | ours                                                                                                             |
| 0013  | Remove PostHog analytics: the client jars go, and `Analytics` becomes an object that does nothing                                                                                                                                                                                                                                                                                                       | ours                                                                                                             |
| 0014  | Stop telling the agent to surface the Viewer link in tool output                                                                                                                                                                                                                                                                                                                                        | ours                                                                                                             |
| 0020  | Bind the iOS runner to a token; see "The runner token"                                                                                                                                                                                                                                                                                                                                                  | ours                                                                                                             |
| 0021  | A CLI session on iOS (`record`, `hierarchy`, `query`) takes a runner port the OS picks when no `--driver-host-port` is passed, as `maestro test` and the MCP server already do. It used the fixed 22087, so two of them on different simulators met on one port, and since 0020 the second failed. Android needs no change: its driver port, 7001, is on the device, and Maestro reaches it through adb | ours                                                                                                             |

Numbers 0001-0009 hold the session, build, driver and MCP tool patches, 0010-0019 the telemetry removal, and 0020 onwards keep each Maestro process's runner its own: the token, then a port per CLI session. The script requires the numbers to increase, so two patches with the same number fail the build.

To change or add a patch, apply the set in a scratch clone, commit, and export again:

```bash
source maestro/upstream.env
git clone --depth 1 --branch "$MAESTRO_TAG" "$MAESTRO_REPO" /tmp/maestro-dev
cd /tmp/maestro-dev && git am /path/to/maestro/patches/*.patch
# edit, then commit; one commit per patch
JAVA_HOME=<jdk 17> ./gradlew -x :maestro-ios-driver:buildIosDriver :maestro-cli:test --tests 'maestro.cli.mcp.*'
git format-patch --no-signature --zero-commit -N -o /tmp/maestro-patches "$MAESTRO_COMMIT"
```

Copy the exported files into `patches/` under their `NNNN-<slug>.patch` names, bump the patch level in `upstream.env` if the current version has been released, and run `build.sh`.

## Rebasing onto a new Maestro tag

1. Find the tag's commit: `git ls-remote https://github.com/mobile-dev-inc/Maestro.git refs/tags/cli-X.Y.Z`.
2. Clone that tag and run `git am -3 /path/to/maestro/patches/*.patch`. Resolve each conflict and continue with `git am --continue`. Delete a patch whose change upstream has merged, and check that the patches after it still apply.
3. Run the MCP tests in the clone, then export the commits with `git format-patch` as above, keeping each patch's number.
4. In `upstream.env`, set `MAESTRO_TAG`, `MAESTRO_COMMIT` and `BUILD_VERSION=X.Y.Z-agentlane.1`.
5. Run `build.sh`. Update `NOTICE` if it reports a change; the new tag name goes in its header too.
6. Run the live check below.

## The runner token

The iOS runner answers only requests that carry the token it was started with, in the `X-Maestro-Runner-Token` header. Anything else gets HTTP 401 with a JSON body naming the reason and does nothing, whatever the path, `/status` included. A runner started without a token refuses every request.

- If `MAESTRO_RUNNER_TOKEN` is set, every runner the Maestro process starts uses it. The toolkit runs one Maestro process per claim and passes the claim's token there. Otherwise each runner launch gets a random 256-bit token, so a runner answers only the process that started it.
- Maestro hands the token to the runner next to `PORT`: `TEST_RUNNER_MAESTRO_RUNNER_TOKEN` for `xcodebuild test-without-building`, `SIMCTL_CHILD_MAESTRO_RUNNER_TOKEN` for `simctl launch`. The runner reads `MAESTRO_RUNNER_TOKEN`.
- When Maestro's liveness probe gets a 401, the port belongs to another Maestro process. Maestro then doesn't launch, stop or uninstall anything, and the command fails with "is held by a Maestro runner that refuses this process's token". Two `maestro test` runs on one simulator therefore no longer share a runner unless both have the same `MAESTRO_RUNNER_TOKEN`.
- Maestro keeps the token out of flows: `MAESTRO_RUNNER_TOKEN` is the one `MAESTRO_*` variable it doesn't pass to them, so `maestro cloud` uploads don't carry it either, and the MCP `run` tool's result lists no variable from the server's environment at all (0009). Its command log masks the token.
- Real devices: Maestro sends the token to a real device the same way, through `xcodebuild`. In the CLI it builds the real-device runner on your machine, with your signing team, from the runner source inside `maestro-cli`'s jar, and that source carries the token check. No real device has run it. At cli-2.11.0 that jar source also leaves out `MaestroDriverLib`, which the runner imports, so the device build may fail with or without these patches. A real-device driver that stock Maestro left in `~/.maestro/maestro-iphoneos-driver-build` ignores the header and keeps working, without the protection; Maestro rebuilds it when the CLI version rises or on `maestro driver-setup`.
- `USE_XCODE_TEST_RUNNER`: a runner you start from Xcode needs `MAESTRO_RUNNER_TOKEN` in its scheme's environment, with the same value set for Maestro.

## Live checks

Each check needs booted simulators that no other Maestro is using, Python 3 (standard library only), `lsof`, and `JAVA_HOME` pointing at a JDK 17. Unpack the zip first, and shut the simulators down afterwards:

```bash
unzip -q maestro/out/maestro-<BUILD_VERSION>.zip -d /tmp/maestro-live
xcrun simctl boot <udid>   # each simulator a check uses
xcrun simctl shutdown <udid>
```

| Check                             | Command                                                                                                                                                      | P0 done-check |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Two simulators, one MCP process   | `python3 -I maestro/test/live_check.py --maestro /tmp/maestro-live/maestro/bin/maestro --sim-a <udid-a> --sim-b <udid-b> --work-dir /tmp/maestro-live/drive` | 4             |
| The runner token                  | `python3 -I maestro/test/token_check.py --maestro /tmp/maestro-live/maestro/bin/maestro --sim <udid> --work-dir /tmp/maestro-live/token`                     | 5             |
| No connection off the machine     | `python3 -I maestro/test/no_egress_check.py --maestro /tmp/maestro-live/maestro/bin/maestro --sim <udid> --work-dir /tmp/maestro-live/egress`                | 3             |
| Element types in `inspect_screen` | `python3 -I maestro/test/element_type_check.py --maestro /tmp/maestro-live/maestro/bin/maestro --sim <udid> --work-dir /tmp/maestro-live/types`              | patch 0006    |

Each prints one line per check, writes a JSON report and Maestro's stderr to its work directory, and exits non-zero if a check fails.

### Two simulators, one MCP process

`test/live_check.py` drives one `maestro mcp --no-viewer` process against two simulators. Its `JAVA_HOME` must include `jdb`. It checks that:

- the first `inspect_screen` on each simulator starts one runner per simulator;
- 100 rounds of `inspect_screen` alternating between the two simulators return no error, and the runner pids and ports are the same before and after;
- after it kills simulator A's runner, the next `inspect_screen` on A succeeds on a new runner and a new port, the old port no longer listens, A has one new `xcodebuild` and no old one, and B's runner is untouched;
- the server's set of reserved ports equals the live runner ports, before the kill and after it. The script reads that set from the running JVM with `jdb` (the JVM starts with a JDWP agent on a free loopback port). Pass `--no-reserved-check` to skip this;
- after the server exits, no runner listener or `xcodebuild` remains for either simulator.

It also prints the per-simulator median and p90 latencies. Options: `--rounds` (default 100), `--after-rounds` (default 10), `--no-reserved-check`.

### The runner token

`test/token_check.py` starts `maestro mcp --no-viewer` with `MAESTRO_RUNNER_TOKEN` set to a fresh token and warms one simulator. It checks that:

- the runner serves `/status`, `/deviceInfo` and `/viewHierarchy` with that token;
- without the header, and with a wrong token, `/status`, `/deviceInfo`, a `/touch` on the Files icon and an unknown path all get 401, and SpringBoard stays in front;
- with the token an unknown path gets 404, and the same `/touch` opens Files;
- the MCP tools `inspect_screen`, `take_screenshot` and `run` work;
- a `run` flow that needs a `MAESTRO_*` variable from the server's environment and one from the call's `env` passes, and the result echoes only the call's (0009);
- a second `maestro --driver-host-port <runner port> test` without the token fails with the port-taken error, doesn't tap, and leaves the runner and its `xcodebuild` untouched, after which the MCP session still works on the same runner;
- the token appears in no MCP tool output, and in no file written under `~/.maestro/tests` or the work directory during the run, and the server's other `MAESTRO_*` variable appears in no MCP tool output;
- no runner or `xcodebuild` remains after the server exits.

### No connection off the machine

`test/no_egress_check.py` runs a `maestro mcp` session that calls every local tool once (with the Viewer on), then `maestro test` on a flow and on a missing flow. Each run starts with `MAESTRO_CLI_NO_ANALYTICS` and `MAESTRO_DISABLE_UPDATE_CHECK` removed and `XDG_STATE_HOME` pointed at a fresh empty directory, so the build sees a first run with no opt-out anywhere. `lsof -i` samples the java process every 0.25 s from spawn to exit. The check passes when every call behaves as expected, the flow exits 0, the missing flow exits 1, and no sample shows a non-loopback endpoint. `cheat_sheet` and the cloud tools are left out because they call Maestro's servers by design.

### Element types in `inspect_screen`

`test/element_type_check.py` opens Settings through the MCP `run` tool, calls `inspect_screen`, and checks that the iOS `ui_schema` names `cls`, that every node carries one, and that Settings' cells (75) and buttons (9) are among them. It closes Settings afterwards.

## License

Maestro is licensed under the Apache License, Version 2.0; the text is in `LICENSE-maestro`. `NOTICE` names the files our patches change, and the build fails when it falls out of date. The release zip carries both files as `maestro/LICENSE-maestro` and `maestro/NOTICE`.
