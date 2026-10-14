---
name: setup
description: Set a project up with the toolkit from nothing - find how it runs its mobile app, web app, servers, data and sign-in, wire the agents the user works in with `agentlane init`, write and validate `agentlane.json` (services, a device or a browser or both, per-lane resources, sign-in), build or adapt the run skill and its flows through create-verification-skill, then bring each app up until `agentlane doctor` reports ready. Use when a user asks to set up, install, adopt or configure the toolkit in a project, or when `up` or `doctor` names the setup skill because the config is missing or invalid or no agent is wired.
when_to_use: A project with no agentlane.json, an agentlane.json that fails validation, no agent wiring, or a user asking to set the toolkit up, redo its setup or add a platform to it. Not for a project that already reaches doctor ready and only needs its run skill or feature map, which create-verification-skill and maintain-verification-skill cover.
---

Run `node_modules/.bin/agentlane skills get setup` from the project root and follow what it prints. It prints this skill for the version of the toolkit installed in this project.
