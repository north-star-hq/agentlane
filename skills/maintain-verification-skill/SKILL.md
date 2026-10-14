---
name: maintain-verification-skill
description: Keep a project's run skill and feature map true as the app changes, for its mobile app, its web app or both. One read-only reader per feature page checks it against the code, then one live pass drives every feature on the session's own lane (a simulator or emulator, a browser), ending in at most one PR of proven corrections. Product bugs it finds are reported, never written around in the map.
when_to_use: The user asks to audit or refresh a project's run skill or feature map; a run found a page wrong in a way that suggests wider drift; or a scheduled upkeep run. Needs a run skill with a features/ map; without one, use create-verification-skill.
license: Parts adapted from cursor/plugins (pstack) under the MIT License, Copyright (c) 2026 Lauren Tan; the full notice is in LICENSE beside this skill in the toolkit package
---

<!-- Adapted from cursor/plugins (pstack/skills/maintain-verification-skill), MIT License, Copyright (c) 2026 Lauren Tan; full notice in ./LICENSE -->

# Maintain a verification skill <!-- upstream: pstack-maintain-verification-skill -->

A feature map goes stale the moment the app changes. This pass keeps a project's run skill folder honest (`.agents/skills/run/`, or `.claude/skills/run/` in a project that keeps it there). The unit of rigor is the feature: every page gets checked against the code and every feature gets driven live on each platform it ships on, without turning each bullet into a terminal command.

## Outcomes

The pass is done when every page has a source reader's summary and a live drive on each of its platforms (or a verified-unreachable note), and you have named one of these outcomes:

- **clean:** every feature had source and live coverage, and nothing needs shipping. No branch, no PR.
- **changed:** one PR of proven corrections.
- **blocked:** coverage couldn't finish, or a proven fix couldn't ship safely. Say exactly what blocked it.

## Edit scope

Edit only the run skill's folder (its SKILL.md and `features/`), the project's `agentlane.json`, the hook scripts it names and the flows they run, and the lane-reading parts of the flow and test configs (a Maestro flow's variables, the Playwright config's base URL, saved login and output folder). Never edit product code during a pass. When the app no longer does what a page says, decide which it is: the page drifted, so fix the page, or the product regressed, so report it and leave the page describing what should happen.

## The pass

1. **Index.** Read `features/README.md` and list the pages beside it. Fix missing, extra, duplicate and dead entries. A thin page, one that says it hasn't been driven yet, gets its full sections from this pass: its reader's summary and the live drive.
2. **Source readers.** One read-only subagent per page, all launched at once. Each explains how its feature works from the code, flags likely drift with `file:line` citations, and returns one live recipe. Readers never drive the app or edit files. Each returns: a summary, the source entry points, likely drift or none, and one recipe.
3. **Reconcile.** Every page has a returned summary. Merge overlapping recipes into as few app states as you can. Spot-check cited drift; don't re-prove clean claims. Look through recent commits for user-facing features the map lacks, and name a concrete source path before calling one missing.
4. **Live pass.** Required even when the code looks clean. You do all the driving, on your own lane: `node_modules/.bin/agentlane up` in your folder (`--platform web` for the web app, and the mobile platform for the app; one lane holds both), the `drive` skill for driving (the device tools on a device, the driver's CLI under `exec` in the browser), and the project's committed flows and tests for proof (Maestro flows and Playwright tests, run under `exec`). Drive every feature at least once on each platform its page lists, and hold these the whole way:
   - Run `node_modules/.bin/agentlane doctor` (with `--platform` for each platform you drive) before the first drive and after anything surprising. Where the doctor can't see the fault (a stuck screen on a healthy process, a page that won't load), relaunch with `node_modules/.bin/agentlane up` instead of hoping.
   - Check that evidence survives every cleanup, at its named location; the lane's `$AGENTLANE_EVIDENCE` outlives `release`.
   - Clean up whatever a failed drive left behind.
   - Read the logs of the flows the hooks run during `up`, such as a sign-in or setup flow, whose paths `up` prints. A WARNED step there is a wait or tap that never matches, which costs every lane its timeout: fix it as drift in the hook's flow, waiting on a handle the driver can see, required and with a bounded timeout.

   A doctor failure caused by the skill's own drift is drift: fix it in scope and retry once before calling the pass blocked. A feature you can't reach counts as verified-unreachable only with the missing prerequisite (an account, an entitlement, an OS version, a browser the driver lacks, outside state) and the route you tried; if the page omits that prerequisite, that's drift too. Re-drive anything you fixed before it ships. Run `node_modules/.bin/agentlane release` when the pass is done.

5. **Triage.** A wrong or missing user-side description is drift: fix the page. Working behavior the harness can't drive is a harness gap: fix the harness, as an executable helper the skill shows. Behavior that's actually broken is a product bug: record it for the user, outside this PR.
6. **Ship or stop.** For changed, open one PR through the project's usual gates, after rereading every changed file. For clean or blocked, open nothing and report the outcome and the coverage honestly.

Keep short run notes (features covered, unreachable prerequisites, confirmed drift, outcome) in the scratchpad, not the repo.
