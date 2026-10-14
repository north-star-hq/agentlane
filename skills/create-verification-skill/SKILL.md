---
name: create-verification-skill
description: Build or extend a project's run skill so any agent can bring the real app up on its own lane (a simulator or emulator, a browser, its own servers and data), drive it the way a user does and prove what it does - the project's agentlane.json with its services, per-lane resources and sign-in, launch, doctor, drive, evidence and cleanup, the project's Maestro flows and Playwright tests adapted to run in a lane, plus a feature map with one page per user-facing feature - and run it once end to end before calling it done. Any surface - iOS or Android app, web app, CLI, service.
when_to_use: A project has no agentlane.json or no scripted way to drive its app and prove behavior; its run skill lacks drive or evidence sections or a feature map; the setup skill hands over to it; or dev-loop's bootstrap offer was accepted. Not for keeping an existing map current, which maintain-verification-skill does.
license: Parts adapted from cursor/plugins (pstack) under the MIT License, Copyright (c) 2026 Lauren Tan; the full notice is in LICENSE beside this skill in the toolkit package
---

<!-- Adapted from cursor/plugins (pstack/skills/create-verification-skill), MIT License, Copyright (c) 2026 Lauren Tan; full notice in ./LICENSE -->

# Create a verification skill <!-- upstream: pstack-create-verification-skill -->

The output is the project's `agentlane.json`, its committed flows and tests adapted to run in a lane, and its run skill in `.agents/skills/run/` (the toolkit's `init` mirrors it into `.claude/skills/run/` for Claude Code), the skill an agent finds whenever anyone asks to run the app or see a change working. Load the `dev-loop` skill for what the run skill must hold; this is how a project gets there. Write it for the next agent, which will read it cold, mid-task, having never seen the app.

Done when step 5 has passed: the run skill's own instructions, followed from a fresh lane, brought each app up to `doctor` ready, drove one mapped feature per app, and left evidence that still exists after `release`.

When the `setup` skill sent you here, its survey answers step 1 and its decisions (which apps, data per lane or shared, how sign-in gets a session) settle what step 2 writes; take them as given and do the rest.

## 1. Interview the repo, not the user

Answer these from the codebase, and ask the user only what you can't observe:

- **Surface:** what does a user actually touch: a mobile app, a web app, both? When there are several, note each; the run skill covers every one the project ships.
- **Run:** how does each app start locally? Prefer the repo's own scripts. Note the long-running servers (Metro, an API, a web dev server, workers), the ports they bind by default, devices, env files, seed data and auth.
- **Drive:** what can act on it programmatically? For a mobile app, the device tools (load the `drive` skill) on the claimed simulator, plus the project's committed Maestro flows. For a web app, the lane's browser through its driver, plus the project's Playwright suites. Otherwise existing harnesses first (curl-able endpoints, a debug port), then a generic recipe: a PTY for a CLI, HTTP for a service.
- **Observe:** what evidence can be captured: screenshots, recordings, traces, logs, response bodies, exit codes, database state.
- **Data:** where the app's data lives, and how the project's tests create and reset it today (migrations, a seed script, a Docker database, a SQLite file, fixtures). That decides whether each lane gets its own copy (a resource, step 2) or shares one.
- **Sign-in:** how a user signs in, which test accounts exist and where their credentials come from, and whether the project already has a seam (a token endpoint, a deep link, a Playwright setup project that saves a login).
- **Isolate:** can two instances run side by side? Every port the app or its servers hard-code is a collision between agents. The toolkit claims a port per service and passes it in, so each server has to take its port from the environment, and the mobile app has to take its API address at launch (a launch argument in debug builds) instead of a baked-in one. Shared outside state, such as a hosted dev database or test accounts, stays shared: say so in the skill and name what must be cleaned up after a write.
- **Worktrees:** agents work in git worktrees, often inside the repo (Claude Code puts them under `.claude/worktrees/`). Check that the project's watchers and test runners (Metro, Jest's haste map, Vite, linters, Playwright's test match) don't scan them, and add excludes where they do.

When a run skill already exists, read it and its scripts first. Keep what works and add what's missing; it usually holds traps someone paid for, and a rewrite loses them. If the checkout doesn't build or start, fix that or report it precisely before writing anything. A skill written against a broken base teaches wrong steps.

## 2. Write the project config

`agentlane.json` at the repo root (`node_modules/.bin/agentlane schema` prints its JSON Schema; point `$schema` at `node_modules/agentlane/schema/agentlane.schema.json` so editors check it) declares what the project has. `node_modules/.bin/agentlane doctor` validates it: its `config` line names any field that breaks the schema, and the bar is `node_modules/.bin/agentlane up` from a clean worktree followed by `doctor` reporting ready on each platform.

- **Apps:** `app` for the mobile app, `web` for the web app (`service`, the service that serves it, and `path`, the page to open), or both. `web.browser.driver` picks the browser driver: `playwright` (the default) or `agent-browser` when the project already uses it. `web.browser.headed: true` shows the window for a person to watch, with Playwright only; agent-browser runs headless.
- **Device:** when committed flows tap by point, or the repo says which device they were measured on, pin that model in `app.device` with `strict: true` (`{"type": "iPhone 17", "strict": true}`, or under `app.ios` or `app.android` when only one platform's flows depend on it). Without `strict`, a full pool hands the lane another model, and the points land elsewhere on its screen.
- **Services:** each long-running server with its start command, reading its port from `AGENTLANE_<SERVICE>_PORT`, and a readiness check. `platforms` limits a service to the apps that need it, so a web `up` doesn't start Metro. When a server's CLI sends usage telemetry, switch it off in the start command with the variable the CLI documents (`EXPO_NO_TELEMETRY=1`, `NEXT_TELEMETRY_DISABLED=1`), since every lane starts its own copy of the server.
- **Resources,** for data each lane gets its own copy of: `create`, `exports` and `teardown`. `create` runs once per lane, after setup and before the services, and appends a `NAME=value` line for each declared export to the file at `$AGENTLANE_EXPORTS` (`echo "DATABASE_URL=$url" >> "$AGENTLANE_EXPORTS"`); anything it prints only goes to the log. The values then reach every service, hook and `exec`, and replace whatever the caller's shell had. Name the copy after `$AGENTLANE_LANE` so two lanes never meet. `teardown` runs when the lane ends, also after a crash and possibly after the worktree is deleted, so it needs only the exported values (`dropdb … "$DB_NAME"`, `rm -f -- "${DATABASE_PATH:?}"`), never a script from the worktree. Since create runs once per lane, run migrations where every `up` reaches them too, such as in the API's start command.
- **Hooks** the project owns: `setup`, `build`, `launch` when the built-in launch modes don't fit, `signin`, `teardown`. Hooks are shell commands that read the lane from the environment (`AGENTLANE_DEVICE`, `AGENTLANE_<SERVICE>_PORT`, `AGENTLANE_WEB_URL`, the resources' values); they are non-interactive and fail with a non-zero exit when they didn't do their job.
- **Sign-in:** on a device, `signin` signs the launched app in through the project's seam. On the web, `signin` writes the lane's saved login to the file at `$AGENTLANE_STORAGE_STATE`, in Playwright's storage-state format (`{"cookies": [...], "origins": [...]}`), for the web app's origin; the lane's browser starts with it, and the project's tests can load it. Get the session the way a real client does, through the app's own sign-in endpoint with a test account, and write the cookie or token it returns. In a project with both apps, one `signin` hook branches on `$AGENTLANE_PLATFORM`. `up` checks the file and keeps its values out of every log.
- **First-run sheets:** a lane's simulator or emulator may never have run the app, so `up` can meet the app's first launch: onboarding, a what's-new sheet, a permission prompt, a rating or cookie banner. Each covers the screen an agent came to capture and takes its taps. On a simulator, `up`'s capture hygiene already marks the keyboard's slide-to-type intro as shown; the app's own sheets are the project's to clear, before anything is captured. Clear each through the app's own seam where there is one, the default or launch argument its debug build reads to mark the sheet seen, set from the `signin` or `launch` hook. A permission prompt stays away once `node_modules/.bin/agentlane device permission grant <service> <bundle id>` has granted the permission before the app asks. Dismiss any other sheet in the sign-in flow with an `optional` tap on its id or label. The run skill names each sheet and how it's cleared, and the feature map's baseline is the screen the app shows once they're gone.
- **Build cache,** for a mobile app: `buildCache.inputs` lists what the native build reads (the app config, the lockfile, native folders, plugins, assets, the build scripts, per platform where they differ), so an unchanged worktree installs a cached build instead of building. The key already covers Xcode, Android's JDK, Gradle and SDK packages and the env file; add a `command` input for every other tool whose version changes the native output, such as `pod --version` for CocoaPods, or a cached build outlives that tool's upgrade.
- **Preconditions** go in `preconditions` for whatever would otherwise fail a slow step late, each with the fix it names:
  - one per tool a hook or a start command calls that the project doesn't install itself (`command -v pod`, `command -v uv`), one tool to a check, with its install command as the fix;
  - one that the project's dependencies are installed (`test -d node_modules`, `before: build`, with the install command as its fix), so `up --no-setup` in a fresh worktree stops there with that fix instead of failing inside the build;
  - one per env file a hook or the app needs, and, when the repo documents a failure that stays silent without a particular variable (an app that accepts a sign-in link and stays signed out without its seam key, say), one that the variable has a value, not just that the file exists: `grep -q '^SEAM_KEY=.' .env.test`. The check prints nothing, so the value stays out of every log;
  - any other state the repo warns about, such as a dirty native project.

## 3. Adapt the flows and tests, then write the run skill

The project's committed flows and tests are its proof, and they keep passing where they ran before (CI, a person's machine). Adapt them to run in a lane as well; don't replace them.

- **Maestro flows:** a hard-coded port, host or account becomes a flow variable (`${API_PORT}`), passed under exec as `maestro test -e API_PORT="$AGENTLANE_API_PORT" <flow>`. Point `driver.flows` at their folder. A script that collects what a flow wrote (its `takeScreenshot` files, a failure's bundle) reads it from `$AGENTLANE_EVIDENCE` in a lane, at `<stamp>-maestro-test-<pid>/.maestro/tests/<run>/<flow>/`, ending `-failed` when the test failed. The toolkit also links each run into Maestro's own `~/.maestro/tests`, so a script that reads that folder keeps working, but there it can pick up another lane's run.
- **Waits in a sign-in or setup flow:** a flow a hook runs on every `up` pays the full timeout of each wait or tap that never matches, and the driver only warns about it (Maestro marks an optional step WARNED and moves on), so a broken step costs every lane its timeout without failing anything. Wait on a handle the driver can see in the screen's accessibility tree, an id or a label, rather than on text inside a system sheet, web view or other view the driver doesn't read. A wait that guards readiness is required, with a timeout no longer than the step needs, so a broken step fails at once and says where; keep `optional` for a screen that may or may not appear. A WARNED step in a sign-in or setup flow is a defect to fix, not a pass.
- **Playwright suites:** the config reads the lane when it's there and keeps its own behaviour when it isn't.
  - Pin `@playwright/test` to the toolkit's Playwright version (`node_modules/.bin/agentlane browser status` names it). Under exec the tests launch the toolkit's pinned browsers, and another Playwright version looks for a browser build that isn't there.
  - Exec sets `PLAYWRIGHT_TEST_BASE_URL` to the lane's web app, which Playwright Test uses as `baseURL` when the config sets none. A config that sets `baseURL` itself uses that variable when it is set. Skip the config's own `webServer` in a lane (when `AGENTLANE_WEB_URL` is set), since the lane's services already run.
  - Give the tests that start signed in `storageState: process.env.AGENTLANE_STORAGE_STATE`.
  - Keep traces on failure (`trace: 'retain-on-failure'`) and, when `AGENTLANE_EVIDENCE` is set, write `outputDir` to a folder of its own per run under it, such as `` `${process.env.AGENTLANE_EVIDENCE}/${stamp}-playwright-test` ``. Playwright empties `outputDir` at the start of every run, and each worker loads the config again, so compute the stamp once and keep it in `process.env` (`process.env.RUN_STAMP ??= new Date().toISOString().replace(/[-:.]/g, '')`). The trace of a failed run then survives the next run and `release`.
  - Run them as `node_modules/.bin/agentlane exec -- npx playwright test` or the project's script.

`.agents/skills/run/SKILL.md` needs frontmatter (`name: run`, and a description naming the app, its surfaces and when to reach for it) and the sections `dev-loop` lists, for each app, each grounded in what the interview found, with no placeholders left. Write every toolkit command in it as `node_modules/.bin/agentlane …`, run from the project root: Codex, Cursor, Copilot and Gemini run the skill's commands in a plain shell, where a bare `agentlane` isn't found, and only Claude Code with the toolkit's plugin has one on the PATH. Any helper ships as an executable script whose invocation the skill shows; a helper the reader has to reverse-engineer is not a helper.

When agents keep writing throwaway scripts to click through the app, add a command to the project's CLI instead: a few composable commands that each do real work, `--dry-run` on anything destructive, errors that say what to do, and machine-readable output.

## 4. Seed the feature map

Create `.agents/skills/run/features/README.md` and one page per user-facing feature. When the repo lists its features itself (a `docs/INDEX.md` per app, a features folder, the docs site's navigation), seed a page for every feature it lists, so `maintain-verification-skill` has every page to fill in; otherwise find them from routes, deep links, tabs, menus, pages, commands and docs. Write the three to five that matter most in full. Each other page may be thin: what the feature is, where the repo documents it, how a user reaches it, and a first line saying it hasn't been driven yet. The README holds the baseline every page starts from (launch state, seed data, signed in or not, on which platform) and the index of every page.

A full page answers, from the user's side:

- what the feature is, and its sub-features;
- every way a user reaches it, on each platform it ships on;
- how to drive each way with the harness, pairing each action with its exact command and the result to look for;
- the end state that proves it works;
- the traps that can waste or falsify a run.

Leave implementation details out. Name user paths, stable handles, required state, commands and visible proof.

## 5. Prove it before handing it over

Run the skill's own instructions once, end to end, for each app: `up` (with `--platform` for each), `doctor`, drive one mapped feature, run its committed flow or test under `exec`, capture evidence, `release`. Then confirm the evidence still exists where the skill says it lands; a cleanup that eats the proof fails this step. Read the output of the flows the hooks run during `up` as well (`up` prints each hook's log path): a WARNED step there fails this step until it is fixed. Release after every failed attempt too, so broken tries don't strand processes, ports, devices, browsers or databases. A run skill that was never executed is a draft.

## 6. Hand over

Report what the skill covers, the feature you drove per app and its evidence, the flows and tests you adapted, the pages still thin, and anything the interview couldn't answer. Point at `maintain-verification-skill` for keeping the map true as the app changes.
