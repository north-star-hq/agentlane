---
title: "Docker image"
short: "agentlane, Node and a pinned browser in one image, for web lanes, the CLI and the MCP server."
summary: "The Docker image holds agentlane, Node 24 and the browser agentlane drives on Linux, with the system libraries it needs. It runs the CLI and the MCP server on any machine with Docker, and brings a project's web app up in a lane inside the container, as a CI job or a cloud agent's sandbox needs. iOS and Android lanes need a Mac, so the image has neither."
---

## What the image holds

| Part              | What                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Base              | `node:24.22.3-trixie-slim`, Debian 13, pinned by digest                                       |
| agentlane         | The package as npm publishes it, with its production dependencies, on the `PATH` as `agentlane` |
| Browser           | Playwright 1.64.0 with Chrome for Testing, its headless shell and ffmpeg, as `agentlane browser install` puts them |
| System libraries  | The ones Playwright's `install-deps chromium` installs, so `doctor`'s `browser libraries` check passes |
| Tools             | git, `ps`, `lsof`, unzip, and pnpm through Corepack, with agentlane's own pnpm version already downloaded |
| Platforms         | linux/amd64 and linux/arm64                                                                   |

The image runs `agentlane` under [tini](https://github.com/krallin/tini), which passes signals on to it and reaps the orphaned processes that dev servers and browsers leave, so `docker run` needs no `--init`. With no command it runs `agentlane mcp`. It runs as the `node` user, uid 1000, in `/work`, where you mount the project. Any other uid works too with `--user`, because every user can read the browser and write to the home, `/home/node`. agentlane keeps its registry at `/home/node/.local/state/agentlane`, readable only by the user who first runs it, so run every agentlane command in one container as the same user.

## Get the image

The image is published to GitHub's container registry as `ghcr.io/north-star-hq/agentlane` from 0.6.2 onwards, tagged with each version and with `latest` for the highest stable version:

```sh
docker pull ghcr.io/north-star-hq/agentlane:latest
```

To build it yourself, from GitHub or from a checkout:

```sh
docker build --tag agentlane https://github.com/north-star-hq/agentlane.git
docker build --tag agentlane .
```

Both take about 2 GB on disk, most of it Chrome for Testing and its libraries. The commands below use the published name; put `agentlane` in its place for an image you built.

## Run the CLI

```sh
docker run --rm ghcr.io/north-star-hq/agentlane --version
docker run --rm ghcr.io/north-star-hq/agentlane --help
```

Each `docker run --rm` is a fresh container, and a lane lives only as long as its container. Run the commands that bring a lane up, use it and release it in one container, as below.

## A web lane in a container

Mount the project at `/work` and run the steps in one shell, the same three steps a [CI job without an agent](faq.md#can-i-use-it-in-ci-or-without-an-agent) runs:

```sh
docker run --rm --init --user "$(id -u):$(id -g)" --volume "$PWD:/work" \
  --entrypoint sh ghcr.io/north-star-hq/agentlane -c '
    agentlane up --platform web
    agentlane exec -- npx playwright test
    agentlane release'
```

- `--entrypoint sh` replaces tini, so add `--init` to get Docker's own.
- On Linux, `--user "$(id -u):$(id -g)"` lets the container write to the project, as `up`'s setup hook does when it installs dependencies. GitHub's hosted runners run as uid 1001. Docker Desktop on a Mac maps the files' owner itself and needs no `--user`.
- The lane belongs to the shell, so it parks once the shell is gone, which here is when the container stops.

The project's web services start inside the container, so they need what their `start` commands run. npm is there, and so is pnpm, which works offline at agentlane's own pnpm version and downloads any other version a project's `packageManager` names on first use. Add anything else in an image of your own. agentlane's CI brings its example app up this way on amd64 and arm64, then checks `doctor` and takes a screenshot.

## The base of an agent's sandbox

A cloud agent that runs inside a container gets lanes there when its sandbox starts from this image. Install the agent on top, and its sessions own their lanes as they do on any Linux machine:

```dockerfile title="Dockerfile"
FROM ghcr.io/north-star-hq/agentlane:latest
USER root
RUN npm install --global @anthropic-ai/claude-code
USER node
```

The image installs Playwright only. A project whose `agentlane.json` picks agent-browser installs it in the same file, as `node`, and lets every user read it, so that any `--user` finds it installed:

```dockerfile title="Dockerfile"
RUN agentlane browser install --driver agent-browser \
 && chmod -R a+rX /home/node/.local/share/agentlane
```

## The MCP server

`docker run -i --rm <image>` is an MCP server over stdio, with the `look`, `run` and `screenshot` tools, so directories such as Glama can start it and list them. For an agent that starts the server through Docker, in Claude Code's `.mcp.json`:

```json title=".mcp.json"
{
  "mcpServers": {
    "agentlane": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--volume", "${PWD}:/work", "ghcr.io/north-star-hq/agentlane"]
    }
  }
}
```

The tools act on the lane this session holds for the folder, and this server's lanes are those of its own container. That container starts with none, so a tool call answers with the command that makes one. To drive a lane from an agent, run the agent where the lane runs: on the host with agentlane installed in the project as [Install for your agent](install.md) says, or in a sandbox built on this image.

## What it doesn't do

iOS and Android lanes need a Mac, because simulators need macOS and Xcode, and agentlane runs Android emulators on a Mac only. The image runs web lanes, the CLI and the MCP server.
