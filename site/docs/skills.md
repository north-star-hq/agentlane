---
title: "The skills"
short: "`setup`, `dev-loop`, `drive` and the verification skills: how an agent learns the project."
summary: "The commands give an agent a lane. The skills teach it how to work in one: `setup` wires a project, `dev-loop` is the contract for running the app, `drive` drives it and turns probes into proof, and `create-verification-skill` and `maintain-verification-skill` write the project's run skill and keep it true. They ship in the package, so they always match the installed version."
---

A lane is only useful if the agent knows how to use it: when to bring the app up, how to tell a healthy instance from a stale one, how to drive it, and what counts as proof. agentlane ships that knowledge as skills, short instructions an agent loads when its task calls for them. Every agent `init` wires gets the same six.

## The suite at a glance

| Skill                         | When it runs                                                         | What it gives the agent                                               |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `setup`                       | Once per project: "Set this project up with agentlane", or when `up` and `doctor` find no config | A project wired from nothing to `doctor` ready on every app |
| `create-verification-skill`   | Inside setup, or when a project has no run skill                     | The project's `agentlane.json`, its run skill and its feature map     |
| `dev-loop`                    | Whenever the agent is about to run, build or capture the app         | The loop: `up`, `doctor`, work, `release`, and what counts as proof   |
| `drive`                       | Whenever the agent looks at, taps through or records the app         | How to read the screen, act on it, and turn a probe into a committed flow or test |
| `maintain-verification-skill` | When the run skill may have drifted, or on a schedule                | Every feature page checked against the code and driven live           |
| `device`                      | When an older run skill asks for it                                  | A pointer to `drive`, its former name                                 |

## How they fit together

1. **Setup**, once. The agent surveys the project, decides, asks you once, installs and wires agentlane, and hands over to `create-verification-skill`.
2. **The run skill.** `create-verification-skill` writes `agentlane.json` and the project's own run skill, `.agents/skills/run/`, with one page per user-facing feature. From then on, any agent asked to run the app finds the run skill first.
3. **Every task.** `dev-loop` and `drive` are the day-to-day pair: bring the app up in the lane, check it, drive it, prove the change with a committed flow or test, release.
4. **Upkeep.** As the app changes, `maintain-verification-skill` checks each feature page against the code, drives every feature live, and ships the corrections in one PR.

So a project ends up with two kinds of skill: agentlane's, which know how lanes work, and its own run skill, which knows how this app works. Both are written for an agent that has never seen the app.

## setup

Takes a project from no agentlane wiring to every app it ships coming up in its own lane. It reads how the project runs its apps, servers, data and sign-in; records which flows and tests pass before it changes anything; decides platforms, data per lane, sign-in, the browser driver and the agents to wire; and asks you only what it can't find. It is done when `doctor` reports ready on every platform, every committed flow and suite has a result in a lane, and you have a summary of what it wrote and decided. [How setup decides](setup.md) has each step.

## create-verification-skill

Writes what lets any agent bring the real app up and prove what it does:

- `agentlane.json`: services that read their ports from the lane, resources for per-lane data, a `signin` hook, preconditions for each tool the hooks call, and the build cache's inputs;
- the project's Maestro flows and Playwright suites, adapted to run in a lane while they keep passing where they ran before;
- the run skill, with launch, doctor, drive, evidence and cleanup sections for each app;
- the feature map: a README with the baseline every page starts from, and one page per user-facing feature, saying how a user reaches it, how to drive each way, and the end state that proves it works.

It isn't done until its own instructions, followed from a fresh lane, brought each app up, drove one feature, and left evidence that survives `release`.

## dev-loop

The contract for running a project's app as an agent: one lane per session and folder, `up` from a bare worktree to the running app, `doctor` before trusting an instance, `exec` for commands that need the lane's variables, `restart` to change one service's environment, and `release` when done. It also says what counts as proof. Exercise the real user path, capture the action and the resulting state, read side effects back, and prove a behaviour with a committed flow or test that the next reader can replay. Interactive probing finds the steps; it never stands in for that run.

## drive

How to act on the app in the lane. On a device, through `look`, `run` and `screenshot`, over MCP or from a shell. In a browser, through the driver's own CLI under `exec`. It teaches the habits that save turns: look before acting and after anything that navigates, act on ids before labels, read a failed step before retrying, and never aim at another lane's device. Then it turns a probe into proof, with `record save` for a Maestro flow or a Playwright test beside the project's others, and keeps the evidence a reader needs. [See and drive the app](drive.md) shows the commands.

## maintain-verification-skill

Keeps the run skill and its feature map true as the app changes. One read-only reader per feature page explains the feature from the code and flags drift. Then one live pass drives every feature on each platform it ships on, in the agent's own lane. Drift in a page gets fixed; a product bug gets reported and left out of the map. The pass ends clean, with one PR of proven corrections, or blocked with the reason.

## How the stubs work

The files `init` writes in `.agents/skills/` are stubs. Each holds the skill's name and description, so the agent knows when to load it, and one instruction:

```text title=".agents/skills/drive/SKILL.md"
Run `node_modules/.bin/agentlane skills get drive` from the project root and follow what it prints.
It prints this skill for the version of the toolkit installed in this project.
```

The skill's full text lives in the agentlane package. So when a project upgrades agentlane, its skills upgrade with it, and two projects on one machine each read the skills for their own version. `skills list` names them:

```sh
npx agentlane skills list
npx agentlane skills get dev-loop
```

> [!NOTE]
> Parts of `dev-loop` and both verification skills are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's skills for Cursor, under the MIT License. Each of those skills' folders in the package carries the licence. [Honorable mentions](acknowledgements.md) has more.
