---
title: "Where it runs"
short: "Hosts, platforms and the tools each platform needs."
summary: "Web apps run on Macs and on Linux, x64 and arm64. iOS apps need a Mac with Xcode, and Android apps a Mac with the Android SDK. agentlane pins the browser it drives for each host, and on Linux `doctor` names any system library Chrome lacks. No Intel Mac has run agentlane yet, so that host is untested."
---

## Hosts

| Host                  | Web app   | iOS app | Android app       |
| --------------------- | --------- | ------- | ----------------- |
| Mac, Apple silicon    | Yes       | Yes     | Yes               |
| Mac, Intel            | Untested  | Untested | Untested         |
| Linux, x64 and arm64  | Yes       | No      | Not supported yet |

Every host needs Node 24 or newer and git. agentlane is a dev dependency of your project, and its commands run from the project's root as `node_modules/.bin/agentlane`.

Linux runs the web half of a project: a lane there holds ports, services, resources and a browser, and no device. That covers cloud agents and Linux machines. The browser builds for Intel Macs are pinned like the others, but no Intel Mac has run them.

## Web apps

Nothing to install beyond Node. The first `up --platform web` downloads the pinned browser driver and its Chrome into agentlane's data folder. [Browsers for web apps](browsers.md) says what it fetches.

## iOS

- macOS with Xcode and its command-line tools.
- At least one iOS simulator runtime, installed from Xcode. `claim` picks the newest one and the newest iPhone it supports, unless the config pins a device.
- JDK 17 when the project drives its app (a `driver` block in `agentlane.json`), because Maestro runs on it. agentlane looks in `AGENTLANE_JAVA_HOME`, then `JAVA_HOME`, then the JDK 17 that macOS or Homebrew knows about.
- Whatever your build needs, such as CocoaPods. Name it in a precondition, so `up` stops with the fix before a slow step.

## Android

- The Android SDK with its emulator, `adb`, `avdmanager` and at least one system image. agentlane finds it at `ANDROID_HOME`, `ANDROID_SDK_ROOT` or `~/Library/Android/sdk`.
- JDK 17, for Maestro and for the build. The build hook runs with `JAVA_HOME` set to the JDK the build cache key names.

`claim --platform android` takes the `pixel_8` profile and the newest installed Google APIs system image for the Mac's CPU unless the config says otherwise. Emulators run headless.

## Linux system libraries

Chrome for Testing needs system libraries that slim images, such as `node:24`, leave out. `doctor` has a `browser libraries` check that names each missing library, such as `libnss3.so`, and gives Playwright's install command as its fix:

```text
FAIL  browser libraries: Chrome for Testing can't start without system libraries this machine lacks: libXcomposite.so.1, libXdamage.so.1, libXfixes.so.3, ...
```

The fix runs `install-deps chromium` from agentlane's pinned Playwright, with `sudo` when you aren't root. `up` stops with the same message before it opens the browser. Hooks on Linux run with `LANG` and `LC_ALL` set to `C.UTF-8`, which glibc always has.

## What agentlane downloads

On first use, agentlane downloads pinned builds into its data folder, `~/.local/share/agentlane/` (or `$XDG_DATA_HOME/agentlane`). Each download is checked against a sha256 that the package pins.

| What                         | When                                   | From                                |
| ---------------------------- | -------------------------------------- | ----------------------------------- |
| agentlane's patched Maestro  | the first `look`, `run` or `up` on a device | agentlane's GitHub releases   |
| Playwright 1.64.0            | the first web `up`, or `browser install` | the npm registry                  |
| agent-browser 0.39.0         | the same, when the project picks it    | the npm registry                    |
| Chrome for Testing and ffmpeg | with the driver                       | Playwright's CDN                    |

agentlane itself has no telemetry, and its Maestro build has Maestro's analytics, update check and error reporter taken out. The registry of lanes lives in `~/.local/state/agentlane/` (or `$XDG_STATE_HOME/agentlane`), and `AGENTLANE_STATE_DIR` moves it.
