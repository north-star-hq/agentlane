---
title: "Honorable mentions"
short: "The projects agentlane builds on."
summary: "agentlane builds on open-source projects. This page credits each one and says what agentlane takes from it."
---

## What agentlane builds on

- **[Maestro](https://github.com/mobile-dev-inc/Maestro)** by mobile.dev drives every simulator and emulator in agentlane. Its readable YAML flows are why an agent's probe can become a committed test with one command. agentlane ships a patched build under Maestro's Apache 2.0 licence, and the patches are public in the agentlane repository.
- **[Playwright](https://github.com/microsoft/playwright)** by Microsoft drives web lanes through `playwright-cli`, and it is the test runner most web projects already trust.
- **[agent-browser](https://github.com/vercel-labs/agent-browser)** by Vercel Labs is a browser CLI built for agents from the start, and agentlane offers it as a first-class driver.
- **[Chrome for Testing](https://github.com/GoogleChromeLabs/chrome-for-testing)** by Google Chrome Labs gives automation exact, versioned Chrome builds, which is how every lane on every host runs the same browser.
- **[pstack](https://github.com/cursor/plugins/tree/main/pstack)** by Lauren Tan is a set of skills for shipping careful, verifiable work with agents. Parts of agentlane's `dev-loop` skill and both verification skills are adapted from pstack's `create-verification-skill` and `maintain-verification-skill`: the run skill, the feature map and what counts as proof. They are used under the MIT License, Copyright (c) 2026 Lauren Tan, and each of those skills' folders carries the licence.

[agentlane and Simlock, agent-device, portless, worktrunk, Playwright, Maestro, Conductor and Paradev](neighbours.md) covers the tools agentlane works beside and what a lane adds to each.

The Android robot in the animation is Google's, used under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
