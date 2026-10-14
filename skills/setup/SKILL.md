---
name: setup
description: Set a project up with the toolkit from nothing - find how it runs its mobile app, web app, servers, data and sign-in, wire the agents the user works in with `agentlane init`, write and validate `agentlane.json` (services, a device or a browser or both, per-lane resources, sign-in), build or adapt the run skill and its flows through create-verification-skill, then bring each app up until `agentlane doctor` reports ready. Use when a user asks to set up, install, adopt or configure the toolkit in a project, or when `up` or `doctor` names the setup skill because the config is missing or invalid or no agent is wired.
when_to_use: A project with no agentlane.json, an agentlane.json that fails validation, no agent wiring, or a user asking to set the toolkit up, redo its setup or add a platform to it. Not for a project that already reaches doctor ready and only needs its run skill or feature map, which create-verification-skill and maintain-verification-skill cover.
---

# Set a project up with the toolkit

Setup takes a project from no toolkit wiring to every app it ships coming up on its own lane. The agent decides per project from what the repo already does; there are no presets. It asks the user only for real trade-offs and for facts it can't find, and it changes the project's own code only where the toolkit can't work without it (a server that hard-codes its port, say).

Setup is done when `node_modules/.bin/agentlane doctor --platform <p>` reports `ready` for every platform `agentlane.json` declares, every committed flow and test suite has a result in the lane (through `node_modules/.bin/agentlane exec`) or is listed with the command that runs it and why it didn't run, none that passed before setup fails now, every lane you claimed is released, and the user has the summary from step 7.

Run the toolkit from the project root as `node_modules/.bin/agentlane <command>`, as written here; a bare `agentlane` is on the PATH only in Claude Code with the toolkit's plugin, and the run skill you write has to work in every agent the user names.

Its quality depends on the model. If the user didn't say they started it that way, tell them once, in your first message, that setup works best on their agent's strongest model at its highest effort (in Claude Code, `/model opus` and `/effort xhigh`), then carry on.

## 1. Survey the project

Read the repo before deciding anything; the answers are usually there. For each item, note where you found it, or that the project has none:

- **Apps:** a mobile app (Expo or React Native, an Xcode project, a Gradle project), a web app (Next.js, Vite, Remix and the like, an admin panel), or both, and where each lives in a monorepo.
- **Servers:** every long-running process the apps need (Metro, an API, a web dev server, workers, a local database container), how the repo starts each (package scripts, a justfile or Makefile, Procfile, docker compose, dev scripts), and the port each binds. A hard-coded port is a collision between agents.
- **Data:** the database and other stateful stores, whether they run locally or are hosted, and how the project's tests create, migrate, seed and reset them.
- **Sign-in:** how a user signs in, the test accounts, where their credentials come from (variable names in env example files and CI; never print a secret's value), and any seam the tests already use (a token endpoint, a deep link, a Playwright setup project that saves a login).
- **Proof that exists:** committed Maestro flows, Playwright suites (and the `@playwright/test` version they pin), other end-to-end tests, and how CI runs them.
- **How agents run it today:** run skills (`.agents/skills/run/`, `.claude/skills/run/`), `AGENTS.md`, `CLAUDE.md`, README and docs pages on running locally, and the agent folders the repo commits (`.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.github/hooks/`, `.agents/`).
- **The toolkit itself:** `node_modules/.bin/agentlane --version` at the project root. The hooks and MCP servers that `init` writes look for it there.

The survey is done when every item has an answer with its file path, or "none".

## 2. Record the baseline

Find out which committed flows and suites pass before you change anything, so you can show later that setup broke none of them. Run each the way CI or the docs run it where that works on this machine without installing simulators or browsers; otherwise read its last result on the default branch in CI, or mark it unknown. The baseline is done when each suite is marked pass, fail or unknown, with the command or CI run behind the mark. An unknown mark is settled in step 6, which runs every flow and suite in the lane.

## 3. Decide, and ask once

Decide each of these from the survey, with a one-line reason you'll repeat in the summary:

- **Platforms:** declare each app the project ships: `app` for the mobile app, `web` for the web app, or both. A project with an admin panel beside its site has two web services; declare the one agents most need as `web` and the other as a service the run skill opens by URL.
- **Data per lane or shared:** when the tests already create a local database (a Docker Postgres, SQLite, a local Supabase stack), give each lane its own copy as a resource: a database named after the lane, created, migrated and seeded the way the tests do, and dropped at teardown. When the project relies on a shared hosted database with no local equivalent, keep it shared, and have the run skill name what a write must clean up. When both are possible but they differ in a way the user cares about (local needs Docker, lacks an extension, or misses data only the hosted copy has), that is a trade-off to ask about.
- **Sign-in:** which account each lane signs in as, and through which seam. Prefer the app's own sign-in endpoint with a test account, called from the `signin` hook; on the web the hook writes the saved login the lane's browser starts with.
- **Browser driver:** Playwright, unless the project already drives browsers with agent-browser. When a person wants to watch the browser, Playwright with `web.browser.headed: true`, since agent-browser runs headless only. The project's `@playwright/test` must be the toolkit's Playwright version (`node_modules/.bin/agentlane browser status` names it), or its tests find no browser in a lane; moving the pin to that version is a change setup makes and reports, and a pin the project must keep for another reason is a question for the user.
- **Agents to wire:** the agent you are running in, and every agent whose folder the repo already commits. Wherever Claude Code loads the toolkit's plugin (the project's settings, the user's, or the session you run in), `init` leaves Claude Code to the plugin rather than writing a second copy of its skills, MCP server and hooks, and says which it found. When only the user's settings or the session load it, someone who opens the project without the plugin gets no Claude Code wiring from the committed files; that goes in the summary with init's note.

Collect what only the user can answer as you go: a real trade-off, a credential or account you can't find or create, a hosted database the project must keep. Ask them in one message, after the survey, each with your recommended answer, and keep working on everything that doesn't depend on the answers. When no one can answer, as in a non-interactive run, take your recommendation and list it in the summary as an assumption.

This step is done when every decision above has an answer and a reason, and every question has a reply or a recorded assumption.

## 4. Install the toolkit and wire the agents

Run `node_modules/.bin/agentlane init --agents <list>` (the names it takes: `claude`, `codex`, `cursor`, `copilot`, `gemini`, `antigravity`). When `node_modules/.bin/agentlane` is missing at the project root, run `npx agentlane init --agents <list>` instead: init adds the toolkit to the project's `package.json` as a dev dependency with the project's package manager, creating a private `package.json` when there is none, and prints what it did, which goes in the summary. When it exits 1 because the install failed, run the command it prints and fix what stops it. When the user installs the toolkit from another source than npm (ask if the repo doesn't show one), add it from there before you run init. It writes each agent's skill stubs in `.agents/skills/` (mirrored into `.claude/skills/` for Claude Code), its MCP server entry and its hooks, backs up what it changes, and refuses a file it can't parse with nothing written; fix or report a refusal rather than editing around it. Keep the per-agent notes it prints for the summary: they are the trust prompts the user must accept. `node_modules/.bin/agentlane init --agents <list> --check` exits 0 once the wiring is complete.

## 5. Write the config, the run skill and the flows

Load the `create-verification-skill` skill and follow it: your survey and decisions answer its interview, and it writes `agentlane.json` (services, apps, resources, sign-in, preconditions), adapts the committed Maestro flows and Playwright suites to run in a lane while keeping them passing where they ran before, and writes or extends the run skill in `.agents/skills/run/` with its feature map. Keep what a project's existing run skill and dev scripts already get right, and make the servers the project starts by hand into services rather than leaving steps for the agent to repeat.

Once the run skill exists, run `node_modules/.bin/agentlane init --agents <list>` again, so Claude Code's `.claude/skills/` mirrors it too. This step is done when `node_modules/.bin/agentlane doctor`'s `config` line is `ok` (it validates against the schema `node_modules/.bin/agentlane schema` prints), `init --check` exits 0, and create-verification-skill's own completion criterion holds.

## 6. Bring each platform up until doctor is ready

For each platform the config declares, run `node_modules/.bin/agentlane up --platform <p>`, and read every `FAIL` line and its fix. Fix the cause where it lives (the config, a hook, a server that ignores its port, a missing precondition), then run `up` again; the lane is reused and healthy services are kept. A first iOS or Android build can take many minutes: start `up` the way your agent runs a long command in the background, and check on it rather than restarting it. You don't need a log file of your own for it. `up` writes each hook's output, the build's included, into the lane's log folder as it runs, and prints the path when the hook starts (`build: <command>   (log: <folder>/hooks/build.log)`), so follow the build there. Any log you do write goes in that folder too (`$AGENTLANE_LOGS` under `exec`, and the folder `up` names in `logs in <folder>`), not in the project or a folder beside or above it. Release after a failed attempt you won't continue, so nothing is left running.

Then run every committed Maestro flow and every Playwright or other end-to-end suite once in the lane, each the way the project runs it (`node_modules/.bin/agentlane exec -- <command>`, a flow at a time through the project's own runner when it has one), and record each result by name. This run gives the baseline's unknowns their result.

- Where you changed code the flows and suites run through (the app, its servers and their start scripts, the project's test tooling), run them once before those changes and once after, so a failure setup caused shows as a change: bring the lane up on the config and hooks first, run everything, then make the code changes and run everything again. When the lane can't come up without a change, the first run comes right after it; say so for those flows.
- A flow or suite that passed before and fails now is setup's to fix; one that failed before is reported, not fixed.
- One that needs what `up` doesn't make, such as a Release build for performance flows or data only an exclusive reset writes, may stay unrun, listed with the command that runs it and the reason. Every committed flow and suite appears in the results either way.

When every platform reports ready and the results are in, run `node_modules/.bin/agentlane release`.

This step is done when the completion criterion at the top holds, apart from the summary.

## 7. Summarize for the user

End with a short summary, in this order:

- **Wrote:** each file created or changed, one line each, with what it is for.
- **Decided:** each decision from step 3 with its reason, and each assumption you made for an unanswered question.
- **Checked:** the `doctor` result per platform, and every committed flow and suite by name: its baseline mark, its result in the lane (before and after your code changes, where you made any), or the command that runs it and why it stayed unrun. A table holds many flows best.
- **You need to:** what only the user can do: the trust prompts `init` named for each agent, secrets or accounts you couldn't create (where each goes), and reviewing and committing the changes. Leave the commit to them unless they asked you to make it.
