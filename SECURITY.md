# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue for it.

Say which version you ran (`npx agentlane --version`), on which platform, and how to reproduce it. We answer in the private advisory, and the release that fixes it credits you unless you'd rather not be named.

## What counts

agentlane runs on your machine with your permissions, so a report is most useful when it shows one of these:

- One lane reading or driving another lane's device, browser, ports or data, or a process outside the lane driving a lane's iOS runner without its token.
- A command or hook running something the config didn't ask for.
- A downloaded tool installed without matching the hash pinned in the package.
- The patched Maestro sending data off the machine through a local tool.

## Supported versions

Fixes go into the latest release on npm.
