---
title: "agentlane.json"
short: "The config file, field by field."
summary: "`agentlane.json` says what a lane of the project holds: the mobile app, the web app, the services and their ports, per-lane resources, hooks, preconditions, capture hygiene, the build cache and the driver. `up`, `doctor` and `restart` read it from the current folder or the ones above it, and `agentlane schema` prints its JSON Schema."
---

The `setup` skill writes this file for you. This page is for reading it and changing it by hand. The site builds each field table from the JSON Schema in the package, so the tables match the version they document.

Point `$schema` at the copy in `node_modules` and your editor checks the file as you type:

```json title="agentlane.json"
{
  "$schema": "node_modules/agentlane/schema/agentlane.schema.json"
}
```

`doctor`'s `config` line validates the file and names each field that breaks the schema. `npx agentlane schema` prints the schema. Every command in the file runs with `sh -c` in the folder that holds `agentlane.json`, with the lane's `AGENTLANE_*` variables, the values of its resources, and `LANG` and `LC_ALL` set to a UTF-8 locale: `en_US.UTF-8` on macOS and `C.UTF-8` on Linux. [Environment variables](environment.md) lists what each command gets.

## Top level

<!-- generated: config top -->

## app

The mobile app: what `up` builds, installs and launches on the lane's simulator or emulator. `app.ios` and `app.android` hold what differs per platform, and replace `bundleId`, `output` and `device` when `up` runs for that platform.

<!-- generated: config app -->

## web

The web app: the service that serves it and the page to open. `up --platform web` claims ports and a browser, no device, starts the services and opens the page.

<!-- generated: config web -->

### web.browser

The lane's own browser. [Browsers for web apps](browsers.md) explains the drivers.

<!-- generated: config browser -->

## services

The long-running servers the apps need, by name. A name is lowercase letters, digits and dashes, and it becomes the port variable: `api-v2` gets `AGENTLANE_API_V2_PORT`. [Ports and dev servers](services.md) shows them in use.

<!-- generated: config service -->

### ready

`ready` is one of two checks. An HTTP check:

<!-- generated: config ready-http -->

Or a TCP check, which passes when the port accepts a connection:

<!-- generated: config ready-tcp -->

## resources

Data each lane gets its own copy of, such as a database, by name. `up` runs each `create` once per lane, in the order listed, after the setup hook. Teardowns run when the lane ends, last created first. [A database per lane](resources.md) walks through one.

<!-- generated: config resource -->

## hooks

Shell commands the project owns. Each one reads the lane from the environment, runs without asking anything, and exits non-zero when it didn't do its job. `up` writes each hook's output to `hooks/<name>.log` in the lane's folder.

<!-- generated: config hooks -->

## preconditions

Checks `up` runs before a slow step, each with the fix to print when it fails. Use one per tool a hook calls that the project doesn't install, one for the dependency install, and one per env file a hook needs.

<!-- generated: config precondition -->

```json title="agentlane.json"
{
  "preconditions": [
    { "name": "CocoaPods is installed", "run": "command -v pod", "fix": "brew install cocoapods", "platforms": ["ios"] },
    { "name": "node_modules is installed", "run": "test -d node_modules", "fix": "run pnpm install", "before": "build" }
  ]
}
```

## hygiene

What capture hygiene sets on the lane's device. Leave it out for the defaults: the location 37.3349, -122.009, and light appearance. [Simulators and emulators](devices.md#capture-hygiene) lists every step.

<!-- generated: config hygiene -->

## buildCache

Lets `up` skip the native build when its inputs haven't changed. [The build cache](build-cache.md) explains the key.

<!-- generated: config buildCache -->

### A files input

<!-- generated: config cache-files -->

### A command input

<!-- generated: config cache-command -->

## driver

<!-- generated: config driver -->

With a `driver` block, `up` and `doctor` check for Java 17, and `maestro` under `exec` is agentlane's Maestro build on the lane's device.
