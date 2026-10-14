---
name: maintain-verification-skill
description: Keep a project's run skill and feature map true as the app changes, for its mobile app, its web app or both. One read-only reader per feature page checks it against the code, then one live pass drives every feature on the session's own lane (a simulator or emulator, a browser), ending in at most one PR of proven corrections. Product bugs it finds are reported, never written around in the map.
when_to_use: The user asks to audit or refresh a project's run skill or feature map; a run found a page wrong in a way that suggests wider drift; or a scheduled upkeep run. Needs a run skill with a features/ map; without one, use create-verification-skill.
license: Parts adapted from cursor/plugins (pstack) under the MIT License, Copyright (c) 2026 Lauren Tan; the full notice is in LICENSE beside this skill in the toolkit package
---

Run `node_modules/.bin/agentlane skills get maintain-verification-skill` from the project root and follow what it prints. It prints this skill for the version of the toolkit installed in this project.
