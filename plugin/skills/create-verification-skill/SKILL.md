---
name: create-verification-skill
description: Build or extend a project's run skill so any agent can bring the real app up on its own lane (a simulator or emulator, a browser, its own servers and data), drive it the way a user does and prove what it does - the project's agentlane.json with its services, per-lane resources and sign-in, launch, doctor, drive, evidence and cleanup, the project's Maestro flows and Playwright tests adapted to run in a lane, plus a feature map with one page per user-facing feature - and run it once end to end before calling it done. Any surface - iOS or Android app, web app, CLI, service.
when_to_use: A project has no agentlane.json or no scripted way to drive its app and prove behavior; its run skill lacks drive or evidence sections or a feature map; the setup skill hands over to it; or dev-loop's bootstrap offer was accepted. Not for keeping an existing map current, which maintain-verification-skill does.
license: Parts adapted from cursor/plugins (pstack) under the MIT License, Copyright (c) 2026 Lauren Tan; the full notice is in LICENSE beside this skill in the toolkit package
---

Run `node_modules/.bin/agentlane skills get create-verification-skill` from the project root and follow what it prints. It prints this skill for the version of the toolkit installed in this project.
