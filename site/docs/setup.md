---
title: "How setup decides"
short: "What the setup skill reads, asks and writes."
summary: "The setup skill takes a project from no agentlane wiring to every app coming up in its own lane. It decides from what the repository already does: how the apps, servers, data and sign-in work, which flows and tests exist, and which agents the project uses. It asks you only about real trade-offs and facts it can't find, then records each decision and its reason."
---

Setup has no presets. Your agent reads the project and decides per project, following the skill's seven steps. It changes your own code only where agentlane can't work without it, such as a server that hard-codes its port. It's done when `doctor` reports ready on every platform the config declares, every committed flow and test suite has a result in a lane, none that passed before fails now, every lane it claimed is released, and you have its summary.

Start it by asking your agent to set the project up with agentlane. [Getting started](getting-started.md) lists each agent's command for it.

## Survey

The agent reads the repository before it decides anything, and notes where it found each answer, or that the project has none:

- **Apps.** A mobile app (Expo or React Native, an Xcode project, a Gradle project), a web app, or both, and where each lives in a monorepo.
- **Servers.** Every long-running process the apps need, such as Metro, an API, a web dev server, workers or a local database container, how the repository starts each, and the port each binds.
- **Data.** The databases and other stores, local or hosted, and how the tests create, migrate, seed and reset them.
- **Sign-in.** The test accounts, where their credentials come from (by variable name, never by value), and any seam the tests already use.
- **Proof that exists.** Committed Maestro flows, Playwright suites, other end-to-end tests, and how CI runs them.
- **How agents run it today.** Existing run skills, `AGENTS.md`, `CLAUDE.md`, the README, and the agent folders the repository commits.

## Baseline

Before it changes anything, the agent records which committed flows and suites pass. It runs each one where it can without installing simulators or browsers, or reads its last result in CI, or marks it unknown. That baseline is how the summary shows that setup broke nothing.

## Decisions

Each of these gets an answer and a one-line reason:

| Decision                | How setup decides                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Platforms               | Each app the project ships: `app` for the mobile app, `web` for the web app, or both.                                                   |
| Data per lane or shared | Per lane, as a [resource](resources.md), when the tests already create a local database. Shared, with cleanup named, when only a hosted one exists. |
| Sign-in                 | The app's own sign-in endpoint with a test account, called from the `signin` hook.                                                       |
| Browser driver          | Playwright, unless the project already drives browsers with agent-browser.                                                               |
| Agents to wire          | The agent running setup, and every agent whose folder the repository commits.                                                            |

What only you can answer, such as a real trade-off, a credential it can't find or a hosted database the project must keep, it asks in one message, each question with its recommended answer. It keeps working on everything else while it waits. In a run with nobody to answer, it takes its recommendation and lists it as an assumption.

## Wiring the agents

When `node_modules/.bin/agentlane` is missing, setup adds agentlane as a dev dependency with the project's package manager. Then it runs `init` with the agents it decided on:

```sh
node_modules/.bin/agentlane init --agents claude,codex
node_modules/.bin/agentlane init --agents claude,codex --check
```

It keeps the notes `init` prints for each agent: those are the trust prompts you accept once.

## Config and run skill

Setup hands this part to the `create-verification-skill` skill, with its survey and decisions as the answers. That skill writes `agentlane.json`, adapts the committed Maestro flows and Playwright suites to run in a lane while they keep passing where they ran before, and writes the run skill in `.agents/skills/run/` with its feature map. [The skills](skills.md) shows what each one holds.

The config has to pass `doctor`'s `config` check, which validates it against the schema `node_modules/.bin/agentlane schema` prints.

## Bringing each platform up

For each platform the config declares, the agent runs `up --platform <name>` and reads every `FAIL` line and its fix. It fixes the cause where it lives, such as the config, a hook, a server that ignores its port or a missing precondition, and runs `up` again, which reuses the lane and keeps healthy services. A first native build can take many minutes, so the agent runs it in the background and follows the build log `up` names.

Then it runs every committed flow and suite once in the lane, through `exec`, and records each result by name. Where setup changed code those flows run through, it runs them before and after the change, so a failure setup caused shows up as a change. Last, it runs `release`.

## The summary

Setup ends with a short summary in a fixed order:

1. **Wrote**: each file it created or changed, and what the file is for.
2. **Decided**: each decision with its reason, and each assumption.
3. **Checked**: the `doctor` result per platform, and every committed flow and suite with its baseline mark and its result in the lane.
4. **You need to**: the trust prompts `init` named, secrets or accounts it couldn't create, and reviewing and committing the changes, which it leaves to you.
