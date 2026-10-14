# agentlane

A local toolkit that gives each AI coding agent its own lane, a running copy of a project: claimed ports, dev servers and simulators, plus tools to see and drive the app. Keep the name, agentlane, in as few places as practical (`src/name.ts` holds it, and the 0.2.x name it still reads).

## Commands

Node 24 (`.nvmrc`) and pnpm through Corepack (`corepack enable`, then `pnpm install`). CI runs exactly these, in this order, and so should you before you commit:

```bash
pnpm run lint        # ESLint with typescript-eslint's type-checked rules, then prettier --check
pnpm run lint:sh     # shellcheck over every tracked *.sh, so git add a new script before checking it
pnpm run typecheck
pnpm test            # node --test on tests/**/*.test.ts, no build step
pnpm run build       # tsc to dist/, then: node dist/cli.js --version
```

## Layout

- `src/`: TypeScript source. `src/cli.ts` is the `agentlane` bin. Each module arrives with its code; don't create empty folders for later phases.
- `tests/`: `*.test.ts` files run by `node --test` straight from source through Node's type stripping. Import source files with their `.ts` extension; the build rewrites them to `.js`.
- `maestro/`: the patched Maestro build, with its own `.gitignore`.
- `skills/`: the skills' text, shipped in the package and printed by `agentlane skills get <name>`. `plugin/skills/` and the files `init` writes hold stubs generated from it (`stubOf` in `src/agents/skills.ts`); `tests/agents/skills.test.ts` fails when they drift.
- `plugin/`: the Claude Code plugin and the Codex, Cursor and Gemini manifests over the same stubs and MCP launcher. Claude's hooks are in `plugin/hooks/claude.json`, because the other three each read `hooks/hooks.json` as their own.
- `site/`: the docs site. `pnpm run site` builds it into `site/dist/`; its CLI, MCP and config pages are generated from the source, and `tests/site.test.ts` fails when a page names a command, flag or variable the source doesn't have.
- `brand/`, `media/`, `scripts/hero/`: the logo and colours, and the README's animation with the script that generates it (`pnpm run hero`).
- `examples/expo-app/`: the app agentlane is tested on, for web, iOS and Android.
- `private/`: the maintainers' plans and research, a gitignored clone of a private repository. CI fails if anything under it is tracked.

## Gotchas

- Tests run the `.ts` files unbuilt, so only erasable TypeScript works: no enums, namespaces or parameter properties. The tsconfig enforces this.
- The published package ships `dist/`, because Node won't strip types inside `node_modules`.
- TypeScript is pinned to 6.0 because typescript-eslint supports only TypeScript below 6.1. Raise both together.
- CI's shellcheck (0.9 on the Ubuntu image) fails on info-level findings that Homebrew's newer shellcheck doesn't report, such as SC2015 for `[ a ] && [ b ] || die`. Write `if` statements for those.

## Comments

Comment only what we can't change: a constraint from an upstream, vendor or platform, plus licence headers, public API docs and issue links. Fix a surprise in our own code, or encode it in a name, type or test, instead of explaining it. Inside the Maestro patches, a comment explaining a Maestro or Apple constraint is fine.
