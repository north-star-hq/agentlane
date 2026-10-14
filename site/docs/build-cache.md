---
title: "The build cache"
short: "One build per set of inputs, shared by every worktree."
summary: "Building an iOS or Android app takes minutes, so `up` builds through a cache keyed on the inputs you name in `buildCache`. A worktree whose inputs match an earlier build installs that build instead of building again. When another worktree is already building the same key, `up` waits for that build and installs it."
---

## Inputs and the cache key

The cache key is a hash of everything that can change the native build. You name the project's part of it in `buildCache.inputs`. These are the example app's:

```json title="agentlane.json"
{
  "buildCache": {
    "inputs": [
      { "kind": "files", "paths": ["app.json", "assets", "plugins", "scripts/native-deps.mjs"] },
      { "kind": "command", "run": "node scripts/native-deps.mjs" },
      { "kind": "files", "paths": ["scripts/build-ios.sh", "scripts/ios-common.sh"], "platforms": ["ios"] },
      { "kind": "files", "paths": ["scripts/build-android.sh", "modules"], "platforms": ["android"] },
      { "kind": "command", "run": "pod --version", "platforms": ["ios"] }
    ],
    "cacheableVariants": ["Debug"]
  }
}
```

- A **files** input lists files, folders or globs. Each matching file that git tracks, or that git sees and doesn't ignore, enters the key by its path, mode and content. `exclude` leaves some out.
- A **command** input runs a shell command, and its output enters the key. Use one for each tool whose version changes the native output, such as `pod --version` for CocoaPods. A command that fails means no key, and the build runs uncached.
- `platforms` limits an input to iOS or Android.

The example app keys on its native packages, not on `package.json` and the lockfile. Those two files change with every dev-dependency bump, agentlane's own upgrades included, and each change would rebuild an app whose native code is the same. Its `scripts/native-deps.mjs` prints the name and version of each installed package with a podspec, an Expo module, an Android project or a config plugin, plus the Expo and React Native packages that prebuild and codegen run. Hashing the lockfile is the safer default; a list like this one trades some of that safety for fewer rebuilds.

agentlane adds the rest of the key itself: the platform, the build variant, and the toolchain. On iOS that is the Xcode version. On Android it is the JDK at `AGENTLANE_JAVA_HOME` or `JAVA_HOME` (which the build hook gets as `JAVA_HOME`), the Gradle distribution the wrapper names, and the revision of every installed SDK build-tools, platform, NDK and CMake package. An `envFile` that the build bakes in enters the key by its contents, which matters for env files git ignores.

JavaScript changes don't change the key, because a debug build loads its JavaScript from the lane's Metro. That is why the cache pays off: most worktrees differ only in JavaScript and share one native build.

## Variants

Only the variants in `cacheableVariants` are stored and served. Leave out any variant that embeds its JavaScript bundle, such as a Release build, because its output changes with code the key doesn't cover. The lane's variant is `app.variant`, `Debug` by default, and hooks get it as `AGENTLANE_VARIANT`.

The build hook either writes the app to `app.output`, which agentlane installs and stores, or installs it itself, in which case agentlane reads the installed app back from the device to store it. `doctor`'s `app variant` line checks that the app on the device is the one `up` installed.

## Waiting for another worktree's build

Two agents that start in fresh worktrees at once would both build the same app. Instead, the second `up` finds the first one building the same key, prints that it is waiting, and installs that build when it lands:

```text
agentlane up: build: waiting for ~/code/shop/.claude/worktrees/search's build of 84304cf29259 (pid 51123); building here instead after 45m
```

It builds by itself after 45 minutes, or at once when the other build's process has died. A quiet `up` at this step is waiting, not stuck.

## Skipping or refreshing the cache

```sh
npx agentlane up --no-cache         # build, and leave the cache alone
npx agentlane up --refresh-cache    # build, and replace the cached build
```

`up` says on its build line which it did: `served from the build cache` with the key and the worktree that built it, or `built` with the reason it missed and the key it stored.

## Where the cache lives

The cache is in the repository's git folder, at `.git/agentlane/build-cache`, so every worktree of the repository shares it and nothing lands in your working tree. An entry unused for `maxAgeDays` (14 by default) is pruned, and only the `maxEntries` most recently used (6 by default) are kept.
