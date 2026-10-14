---
title: "Simulators and emulators"
short: "A pool of simulators and emulators, one per lane."
summary: "A mobile lane holds one iOS simulator or Android emulator from a pool shared by every project on the machine. `claim` picks the newest iPhone and iOS runtime by default, or `pixel_8` and the newest system image on Android. Capture hygiene sets the location, the appearance and the keyboard so screenshots are stable, and `prune` deletes the devices no lane holds."
---

## The pool

Pool devices belong to agentlane, not to a project: simulators named `agentlane-pool-<id>` and emulators named `agentlane-emu-<id>`. A lane takes a free one of the type it asks for. Only when none is free, and the pool is under its size, does agentlane create one. A device stays in the pool after its lane ends, so the next lane skips the minutes it takes to create one.

| Setting            | Default | Set in                                      |
| ------------------ | ------- | ------------------------------------------- |
| Simulators         | 5       | `poolSize` in the registry's `config.json`  |
| Emulators          | 5       | `emulatorPoolSize`                          |
| Memory budget      | 20 GB   | `memoryBudgetGB`, counted at 4 GB per simulator and 3.4 GB per emulator |

The pool never touches a simulator or emulator you made yourself. Emulators run headless, without a window, audio or boot animation, and keep Android's Quick Boot snapshot, so a pool emulator that has booted once comes back in seconds. A lane releases its device by shutting it down.

## Device types and runtimes

By default, an iOS lane gets the newest installed iOS runtime and the newest iPhone it supports. An Android lane gets the `pixel_8` profile and the newest installed Google APIs system image for the Mac's CPU. To pin a device, set it in `agentlane.json`:

```json title="agentlane.json"
{
  "app": {
    "platform": "ios",
    "bundleId": "com.example.shop",
    "launch": "dev-client",
    "device": { "type": "iPhone 17", "strict": true },
    "android": { "device": { "type": "pixel_8", "runtime": "36" } }
  }
}
```

`runtime` takes a simulator runtime, or an Android system image as a package id or an API level. Without `strict`, a full pool hands the lane a free device of another type rather than deleting one to make the type you asked for. Set `strict` when your flows tap by point or were measured on one model, because on another screen the points land elsewhere. From the command line, `claim` takes the same choices:

```sh
npx agentlane claim --platform android --device-type pixel_8 --strict --boot
```

## Capture hygiene

A screenshot from one lane should look like one from any other. `up` sets each device to the same state and reads every setting back, and `doctor`'s `hygiene` line checks it again.

| Step           | iOS simulator                                                  | Android emulator |
| -------------- | -------------------------------------------------------------- | ---------------- |
| Location       | 37.3349, -122.009, unless `hygiene.location` says otherwise     | The same         |
| Appearance     | Light, unless `hygiene.appearance` says `dark`                 | The same         |
| Status bar     | 9:41, full Wi-Fi and cell bars, battery at 100%                | Not set          |
| Keyboard       | The hardware keyboard disconnected, so the software one shows  | Not set          |
| Keyboard intro | The slide-to-type intro marked as shown                        | Not set          |
| Animations     | Not set                                                        | Off, so screen reads settle |

On a simulator, `up` also approves the app's URL scheme (`app.scheme`) before boot, so opening a link never stops at an "Open in" prompt.

Your app's own first-run screens, such as onboarding, a what's-new sheet or a permission prompt, are the project's to clear. The run skill names each one and how the `signin` or `launch` hook clears it.

## Device controls

Settings that aren't taps are commands, on the lane's own device:

```sh
npx agentlane device location 51.5072,-0.1276
npx agentlane device permission grant photos com.example.shop
npx agentlane device appearance dark
npx agentlane device push com.example.shop payload.json
npx agentlane device clipboard set "SAVE20"
npx agentlane device open "shop://orders/42"
```

On an emulator, `location clear`, `push` and `clipboard` have no adb equivalent and refuse with the reason. `permission` there takes the package name and grants the Android permissions behind the service that the app declares. A grant before the app asks keeps its prompt from appearing at all.

## Pruning the pool

Pool devices take disk. `prune` lists the ones no lane holds, and `prune --yes` deletes them:

```sh
npx agentlane prune
npx agentlane prune --yes
```

Each deletion takes the registry's lock and checks again that no lane holds the device, so one claimed in the meantime is kept. A device the registry has no record of is never deleted, even one named like a pool device. The next lane after a prune waits while a new device is created, so prune when you want the disk back; cleaning up after your own work is `release`.

## Sharing a Mac with 0.2.x

0.3.0 runs beside 0.2.x, the versions named `agent-env`, on the same Mac. While only the earlier registry exists, 0.3.0 uses it as it is, so both versions see every lane and neither hands out a device the other holds. In that registry, new pool devices keep the earlier names, `agent-env-pool-*` and `agent-env-emu-*`, and `prune --yes` deletes free ones of either version, never one an earlier lane holds. The [changelog](../changelog.md) has the full rules and how to move the folder once nothing runs the earlier version.
