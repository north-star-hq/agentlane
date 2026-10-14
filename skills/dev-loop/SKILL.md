---
name: dev-loop
description: The contract for running a project's app as an agent with the toolkit - one lane per session and folder (a simulator or emulator, a browser, the ports for Metro, the API and the web app, and per-lane resources such as a database), `agentlane up` from bare worktree to running app, `doctor` before trusting an instance, `release` when done - plus what a project's run skill holds and what counts as proof and evidence from a running app. Use when about to run, build, launch or capture a project's mobile or web app, start its dev servers, hand an agent work that runs the app, or when an agent loses turns to ports, simulators, browsers, databases or half-started servers.
when_to_use: Booting a simulator or emulator, opening the web app in a browser, starting Metro or a dev server, running the app for verification, capture, e2e or debugging; dispatching agents that will run the app; a project with no agentlane.json or no run skill. Not for test-only work that never runs the app.
license: Parts adapted from cursor/plugins (pstack) under the MIT License, Copyright (c) 2026 Lauren Tan; the full notice is in LICENSE beside this skill in the toolkit package
---

<!-- "What a run skill holds" and "What counts as proof" are adapted from cursor/plugins (pstack/skills/create-verification-skill), MIT License, Copyright (c) 2026 Lauren Tan; full notice in ./LICENSE -->

# Dev loop: running the app without losing turns to it

Every agent session gets its own running copy of the project, mobile app or web app: its own simulator or emulator, its own browser, its own ports for Metro, the API and the web server, its own resources such as a database, and its own processes on them. The toolkit keeps that in one registry per machine, shared by every project and every agent, so two agents never build onto the same simulator, sign in through the same browser profile, bind the same port or write to the same per-lane database. Everything here runs from a shell at the project root, as `node_modules/.bin/agentlane <command>`: that path works in every agent's shell, while a bare `agentlane` is on the PATH only in Claude Code with the toolkit's plugin. In a fresh worktree with no `node_modules` yet, run the project's install command first. The project's specifics live in its `agentlane.json` (`node_modules/.bin/agentlane schema` prints the format) and its run skill.

The loop is done when you have run `release` in your folder, and what you claim about the app rests on a replayable run whose evidence is where you say it is.

## The loop

1. **`node_modules/.bin/agentlane up`** takes the folder you're in from bare to the running app. It checks the toolchain and the project's preconditions before claiming anything, claims what the platform needs and ports, runs the project's setup, creates the lane's resources the first time (a database, say, whose values such as `DATABASE_URL` reach every service, hook and `exec`), starts each service on its claimed port and waits until it answers, then runs `doctor`.
   - For the mobile app (`--platform ios`, the default when the project has one, or `--platform android` for an emulator) it also builds through the build cache, applies capture hygiene, and launches and signs in. When another worktree is already building the same cache key, `up` prints "waiting for <worktree>'s build of <key>" and installs that build when it lands (it builds itself after 45 minutes, or at once if that builder has died), so a quiet `up` there is waiting, not stuck.
   - For the web app (`--platform web`, the default when the project has only a web app) it claims a browser with its own profile, opens the web app in it, signs in through the project's `signin` hook, and prints `the web app is at <url>`. There is no build, and it is ready in seconds.
   - One lane can hold a device and a browser at once: `up` for one platform keeps what an earlier `up` for the other gave the lane.

   Run it again to reuse the same lane; healthy services are kept, and one that fails its check is replaced, with the line naming the old pid and the failed check. A refusal names its fix; do the fix, not a workaround.

2. **`node_modules/.bin/agentlane doctor`** answers "is this instance worth driving?" read-only, and names a fix for each failure. On a device, its `app variant` line says which build is installed and fails when a hand-made build replaced the one `up` installed. On the web, it checks that the browser is up and that each web service's listener runs this worktree's code, not a server another checkout left on the port. `resource <name>` lines say each resource was created. `--platform` checks the other platform of a project that has both. Run it before the first drive and again whenever something looks off.
3. **Work.** `node_modules/.bin/agentlane exec -- <command>` runs a command with the lane's variables: `AGENTLANE_DEVICE`, `AGENTLANE_<SERVICE>_PORT`, `AGENTLANE_WEB_URL`, the resources' values, the browser driver's session and `AGENTLANE_STORAGE_STATE`, the log folder `AGENTLANE_LOGS` and the evidence folder `AGENTLANE_EVIDENCE`. An agent's shell commands often start with a fresh environment, so prefer `exec` over exporting. Drive the app with the `drive` skill: the device tools on a device, the driver's own CLI under `exec` in the browser, `look` and `screenshot` on both. To change a service's environment, such as a feature switch, an admin toggle or a client gate, run `KEY=value node_modules/.bin/agentlane restart <service>` rather than `release` and `up`, which would cost a re-lane, an install and a sign-in. It restarts only that service, on the same port, and returns once its ready check passes; the lane, the device, the browser, the app and the other services stay as they are. The service gets the lane's variables plus that call's environment, so pass every variable you still want: one given to `up` and not to `restart` is gone.
4. **`node_modules/.bin/agentlane release`** in the same folder when you're done: it stops exactly the processes `up` started, the browser and its driver's daemons included, runs the project's teardown and each resource's teardown (the lane's database is gone after this), and frees the lane. The evidence folder stays. When the session ends, its remaining lanes are released for it.

`node_modules/.bin/agentlane status` lists every lane on the machine with its owner, folder, start, idle time and last action. A lane whose session has exited is freed the next time any session claims one, its resources torn down with it. With the pool full, `claim` and `up` wait in a queue. An idle lane (over 2 hours) can be taken over only when no slot is free, and the taker is told whose it was.

`node_modules/.bin/agentlane prune` lists the pool simulators and emulators no lane holds, and `prune --yes` deletes them to free disk. Every project on the machine shares that pool, and the next lane after a prune waits while a new device is created, so run it when the user asks for disk space back; cleaning up after your own work is `release`.

## Lanes are per session and folder

A lane belongs to the session that made it and the folder it was made in. Subagents of one session share the session, so each one works in its own worktree and claims there; that keeps their devices, browsers, ports and databases apart. Release only your own folder's lane. A refusal names the holder and the exact command that recovers: when it's another session's lane, leave it, take your own, or ask; `release --lane <id> --force` is only for a holder you know is finished. Never reach another lane's device, browser or port by hand: `simctl`, `adb` and the browser drivers aimed at what you don't hold are denied by the toolkit's hook.

Orchestrators name the folder each agent works in, and the agent runs `up` there. Ports an app bakes in (a fixed API port, Metro's 8081, a dev server's 3000) are the app's to remove: each server takes its port from the environment, and debug builds take their API address at launch, which `up` passes from the lane.

## What a run skill holds <!-- upstream: pstack-create-verification-skill -->

A project's run skill (`.agents/skills/run/SKILL.md`, which the toolkit's `init` mirrors into `.claude/skills/run/` for Claude Code) is read cold, mid-task, by an agent that has never seen the app, in whichever agent the reader works. With the repo's real commands and handles, each toolkit command written as `node_modules/.bin/agentlane …` from the project root, for each app the project has, it covers:

- **Launch:** in a fresh worktree, the project's install command first, since `node_modules/.bin/agentlane` exists only after it; then `node_modules/.bin/agentlane up` (with `--platform` where there are several apps) and anything the project adds (a sign-in seam, seed data), how to tell it's ready, and `release`.
- **Doctor:** `node_modules/.bin/agentlane doctor`, plus any check only the project knows (the right account, a feature flag).
- **Drive:** how to act on the app the way a user does, preferring stable handles (testIDs, accessible names and roles, routes, deep links) over coordinates and refs.
- **Evidence:** what proves a behavior, how to run that proof, and where its files land.
- **Cleanup:** stop what you started, never by process name, and leave the evidence in place.

Its `features/` folder is the feature map: a README with the baseline every page starts from and an index, then one page per user-facing feature. A page says what the feature is, every way a user reaches it (on each platform it ships on), how to drive each one, the end state that proves it works, and the traps. A proof that drives one convenient entry point is incomplete when the page lists others. An agent that changes how a user reaches a feature, or what proves it, updates the page in the same change. An agent that verifies a feature with no page writes one from what it just drove.

## What counts as proof <!-- upstream: pstack-create-verification-skill -->

Exercise the real user path. A seam may set up a precondition, such as a signed-in session, but never stands in for the behavior under test. Capture the action and the resulting state, not only the final screen, and read side effects back (rows written, files saved, messages sent) alongside what's visible. Mock only where a production boundary already isolates the outside system. When the safe path is a dry run or test mode, observe what it actually skips instead of trusting its name.

Proof is an assertion the next reader can replay: a committed flow, test or script run through the project's own runner (Maestro flows for the mobile app, the project's Playwright tests for the web app), with the artifacts it writes. Interactive probing (`look`, the driver's CLI, a REPL, a one-off request) is how you find the steps, and its output never stands in for that run.

Evidence beyond the assertion is your call, by who reads the result: a video when a user-visible change goes to a person, a screenshot when the owner judges how it looks, logs or a trace when a failure needs explaining. `node_modules/.bin/agentlane evidence` records each into `$AGENTLANE_EVIDENCE`, and a failed run keeps its trace there on its own; the `drive` skill has the commands.

## Bootstrap and upkeep

In a project with no `agentlane.json`, or no agent wiring, `up` and `doctor` say so and name the `setup` skill. Say so in one line with what setting it up involves, and on yes, load the `setup` skill. When only the run skill lacks the sections above or a feature map, load the `create-verification-skill` skill instead. `maintain-verification-skill` is the upkeep pass: it checks every page against the code and drives every feature live. A specific gap noticed mid-work gets a single offer.
