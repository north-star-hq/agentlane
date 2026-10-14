---
title: "Troubleshooting"
short: "Common failures and their fixes."
summary: "Most failures come with their fix: `up` and `doctor` name it on the line that failed. This page collects the ones that need more than that line, such as a full device pool, a server another checkout left on a port, missing browser libraries on Linux, or a Maestro download that macOS has quarantined."
---

## Reading a failure

Every refusal and every failed check ends in the fix. `up` stops at the first step that fails, prints the step and the last lines of its log, and names the log file. `doctor` puts a `fix:` line under each failure. Do the fix it names rather than working around it; most of them are `up` again, which keeps what is healthy and redoes what isn't.

| Exit code | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| 1         | A step or check failed. The output names the fix.                       |
| 2         | The command line or `agentlane.json` is wrong, such as a field the schema doesn't allow. |
| 3         | Refused: another session holds what you asked for, or this folder has no lane. |

When `up` and `doctor` find no `agentlane.json`, or no agent wired, they say so and name the `setup` skill. Ask your agent to set the project up with agentlane.

## The pool is full

Every simulator or emulator in the pool is held by a lane, and none is idle long enough to take over. `claim` and `up` wait in the queue for up to 600 seconds, naming the lanes ahead and the holders, then refuse with three ways out:

```text
node_modules/.bin/agentlane claim --timeout 1800   (wait up to 30 minutes for a slot)
node_modules/.bin/agentlane release   (run by a holder's session, in its folder)
set "poolSize": 6 or "memoryBudgetGB": 24 in ~/.local/state/agentlane/config.json   (allow one more simulator)
```

`npx agentlane status` shows who holds each device and when each lane last did something. A lane of your own in another folder counts too: release the ones you're done with.

## A port is taken

A port can be taken by a process agentlane didn't start, such as a dev server you ran by hand or one another checkout left behind. The registry skips ports something already listens on when it hands them out, so this shows up as a service that answers with the wrong code. `doctor` fails that service and names the listener's pid and the folder it runs in:

```text
FAIL  service web: ... the listener pid 4188 runs in ~/code/shop, outside this worktree ~/code/shop/.claude/worktrees/checkout-fix, so 41300 serves that folder's code
        fix: make services.web.start run this worktree's code (its cwd and the paths it starts), then node_modules/.bin/agentlane restart web
```

When the server hard-codes its port, make it read `AGENTLANE_<NAME>_PORT`. Every hard-coded port is a collision between agents.

## Linux browser libraries

On a slim Linux image, Chrome for Testing can't start without system libraries the image leaves out. `doctor`'s `browser libraries` check names each missing library, and `up` stops before it opens the browser. The fix it prints runs `install-deps chromium` from agentlane's pinned Playwright, with `sudo` when you aren't root. In a Dockerfile, run the same command once at build time.

## A quarantined Maestro download

agentlane downloads its Maestro build on first use. When that download can't run, such as behind a proxy, download the zip in a browser and install it from the file:

```sh
npx agentlane driver install --from ~/Downloads/maestro-2.11.0-agentlane.1.zip
```

`install` checks the zip's sha256 against the pinned one before it unpacks anything. On macOS, a zip a browser downloaded carries the `com.apple.quarantine` attribute, and `unzip` copies it onto every file it unpacks, which can make Gatekeeper block Maestro. `driver install --from` clears the attribute from what it unpacked, so there is nothing for you to do.

## Releasing a stuck lane

`release` in a folder frees that folder's lane for the session that holds it. A lane whose session has died is freed at the next `claim` or `up` anywhere on the machine. To free one by hand:

```sh
npx agentlane status
npx agentlane release --lane 71d66b95
npx agentlane release --lane 71d66b95 --force
```

Without `--force`, `release --lane` frees your own lane or one whose owner is proven gone. `--force` frees it even when its owner is alive or can't be judged, so use it only when you know that session is finished. For a lane that has already ended, `release --lane` runs the teardowns still pending for it, and with `--force` drops the record of a teardown that fails again.

## The browser opens signed out

A page that shows a sign-in form means the `signin` hook or its account is wrong. Read the hook's log, at `hooks/signin.log` in the lane's folder, fix the hook, and run `up --platform web` again. Signing in by hand would hide the problem from the next lane.

## A build that seems stuck

When `up` prints `waiting for <worktree>'s build of <key>`, another worktree is building the same native app, and `up` will install that build when it lands. It builds by itself after 45 minutes, or at once if that build's process has died. A first native build takes many minutes anyway; follow it in the log `up` names, `hooks/build.log`.

## Moving from 0.2.x

0.3.0 renamed the package, the command, the config file and the variables. `up`, `doctor` and `restart` refuse a project that still has only `agent-env.json`, and their message names the renames. The [changelog](../changelog.md) has the steps.
