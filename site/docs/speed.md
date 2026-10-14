---
title: "What makes it fast"
short: "A warm driver, a patched Maestro, a shared build cache and a reused device pool."
summary: "An agent reads and acts on the app many times per task, so each call has to be short. agentlane keeps a Maestro session warm per lane, ships Maestro with patches for speed and parallel use, shares one build cache across worktrees, reuses pool devices that boot from Quick Boot, and runs lanes side by side instead of in a queue for one simulator."
---

## The numbers

| On a warm lane, median of 16 calls | iOS simulator | Browser |
| ---------------------------------- | ------------- | ------- |
| Read the screen with `look`        | 0.15 s        | 0.16 s  |
| Take a screenshot                  | 0.16 s        | 0.18 s  |
| Click through `playwright-cli`     |               | 0.81 s  |

[How these were measured](#how-these-were-measured) is at the end of the page, with every condition.

## A warm Maestro session

`look`, `run` and `screenshot` talk to a Maestro session that stays up between calls, so only the first call pays to start it. Each lane has its own session, started by `up` as its last step before `doctor`, so even an agent's first `look` finds it warm. The session's runner stays bound to the lane's simulator, and each call is a request to a process that is already running, not a new JVM and a new XCTest runner.

`driver status` shows it, and `driver stop` and `driver start` restart it. [See and drive the app](drive.md#the-warm-driver) has the commands.

## Our Maestro patches

agentlane ships its own Maestro build: upstream Maestro with a set of patches, pinned by sha256. The ones that matter for speed:

- **A runner port per session.** Stock Maestro gives every iOS simulator's runner the same port, 22087, so with two simulators the second one started cold on every call: 6.5 s per screen read, against 0.12 s with our patch. Patch 0001, from Maestro pull request #3647, gives each session its own port, and patch 0021 does the same for Maestro's CLI sessions.
- **Quick taps.** On Android, `run --quick` skips Maestro's fixed 750 ms window settle and the screen reads after the tap. That is patches 0007 and 0008.
- **Sessions that recover.** A session whose runner died is rebuilt on the next call instead of failing every call after it (0002, from Maestro pull request #3385). A closed or failed session releases its port and stops its `xcodebuild` (0003, 0005), so nothing left over slows the next one.
- **Element types in the hierarchy.** Each iOS element carries its type (0006), so `look --interactive` can keep just what you can tap, toggle or type into, and an agent reads fewer lines.

The other patches remove Maestro's telemetry and bind each runner to a token, so one lane's Maestro can't drive another's simulator. The full list is in `maestro/README.md` in the agentlane repository.

## A build cache your worktrees share

The example app's iOS build took 91.5 s. A fresh worktree got its build from the cache in 6.5 s and reached the running app in 38.6 s.

The cache is keyed on the native build's inputs, so a worktree that changed only JavaScript, which is most of them, installs the build another worktree already made. When two worktrees start at once, the second waits for the first one's build instead of building the same thing twice. [The build cache](build-cache.md) explains the key.

## A device pool on Quick Boot

Lanes reuse simulators and emulators instead of creating new ones, and emulators boot from their Quick Boot snapshot in 1.6 to 1.8 s, against 14.6 s for a cold boot.

A pool device keeps what earlier lanes set up on it, such as the hygiene settings. agentlane stops emulators with `adb emu kill`, which saves the snapshot the next boot starts from. A new device is created only when the pool has no free one of the type a lane asks for. [Simulators and emulators](devices.md#the-pool) has the details.

## Lanes in parallel

Speed for one agent matters less than not waiting for another. Each agent's lane has its own device or browser, its own ports and its own copy of the app, so three agents work at once instead of queueing for one simulator. Setup overlaps too: `up` boots the device while the project's setup hook runs. When the pool does fill, the next agent waits in a queue and gets the first device that frees, rather than failing.

## How these were measured

All on an Apple M4 Max with 48 GB of memory.

- iOS column: `agentlane bench` on the example app in the agentlane repository, two iPhone 17 simulators alternating, release 0.1.3 with the Maestro build agentlane installs (`2.11.0-agentenv.3`). The Mac was under memory pressure, so these are upper bounds.
- Browser column: the same bench on the example's web app, Playwright 1.64.0 with Chrome for Testing, a 0.2.0 development build.
- Port comparison: 16 reads per simulator on another app, stock Maestro 2.8.0 against an early build with the port patch.
- Build cache: single runs of 0.2.0 on the example app. Boot times: two boots each of a Pixel 8 emulator on Android 36.

`bench/README.md` in the agentlane repository has the method, and `agentlane bench` runs it on your machine:

```sh
npx agentlane bench --worktree examples/expo-app
npx agentlane bench --platform web --cells warm
```
