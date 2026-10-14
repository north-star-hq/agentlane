# Contributing

Bug reports, fixes and new platform support are welcome. For a question or an idea, start a thread in [Discussions](https://github.com/north-star-hq/agentlane/discussions). For a bug, open an issue with the output of `npx agentlane doctor` and the command that failed.

## Setup

You need Node 24 (`.nvmrc`) and pnpm through Corepack:

```sh
corepack enable
pnpm install
```

`AGENTS.md` describes the layout and the gotchas; your coding agent reads it too.

## Before you open a pull request

CI runs these, in this order, and so should you:

```sh
pnpm run lint        # ESLint with typescript-eslint's type-checked rules, then prettier --check
pnpm run lint:sh     # shellcheck over every tracked *.sh, so git add a new script first
pnpm run typecheck
pnpm test            # node --test on tests/**/*.test.ts, no build step
pnpm run build       # tsc to dist/, then node dist/cli.js --version
```

A change to what the CLI does comes with a test that fails without it. A change to a command, flag, config field or `AGENTLANE_` variable also updates its page in `site/docs/`; `pnpm test` checks the site against the source.

## The patched Maestro

`maestro/` holds the upstream pin and our patches. `maestro/README.md` explains how to build and check a release zip on macOS. A new patch is a `git format-patch` file in `maestro/patches/`, with a test in Maestro's own suite where the change allows one.

## Licence

By contributing, you agree that your contribution is licensed under the MIT License in `LICENSE`. Changes to files under `maestro/` are also offered under Maestro's Apache License 2.0.
