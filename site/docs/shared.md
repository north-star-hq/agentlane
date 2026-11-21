---
title: "A server the lanes share"
short: "One database server per repository, started when a lane needs it and stopped when none does."
summary: "A shared service is a server the lanes of one repository use together, such as the Postgres server each lane's database lives in. You give agentlane the commands that start it, stop it and check it. A lane whose resources or services name it in `needs` starts it, and agentlane stops it 5 minutes after the last lane that needs it parks or ends. It never removes one, so the data stays."
---

## Why a shared service

Each lane gets its own database as a [resource](resources.md), but the databases live in one server. Started by hand, or by a resource's `create`, that server keeps running after every lane is gone, and a Docker server keeps Docker's VM running with it. Declared under `shared`, the server runs while a lane needs it and stops once none does.

## Declare one

Shared services live under `shared` in `agentlane.json`, by name. Each resource and service that uses one names it in `needs`. This config runs one Postgres container per repository, gives each lane a database in it, and gives the tests a database of their own:

```json title="agentlane.json"
{
  "shared": {
    "postgres": {
      "start": "docker start shop-pg 2>/dev/null || docker run -d --name shop-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -v shop-pg-data:/var/lib/postgresql/data postgres:17",
      "stop": "docker stop shop-pg 2>/dev/null || ! docker container inspect shop-pg >/dev/null 2>&1",
      "ready": "docker exec shop-pg pg_isready -U postgres"
    }
  },
  "resources": {
    "db": {
      "create": "LANE_PG_SERVER=postgres://postgres@localhost:5432 scripts/lane-pg.sh create",
      "exports": ["DATABASE_URL"],
      "teardown": "LANE_PG_SERVER=postgres://postgres@localhost:5432 scripts/lane-pg.sh drop",
      "needs": ["postgres"]
    },
    "testdb": {
      "create": "docker exec shop-pg dropdb -U postgres --if-exists \"test_$AGENTLANE_LANE\" && docker exec shop-pg createdb -U postgres \"test_$AGENTLANE_LANE\" && echo \"TEST_DATABASE_URL=postgres://postgres@localhost:5432/test_$AGENTLANE_LANE\" >> \"$AGENTLANE_EXPORTS\"",
      "exports": ["TEST_DATABASE_URL"],
      "teardown": "docker exec shop-pg dropdb -U postgres --if-exists \"test_$AGENTLANE_LANE\"",
      "needs": ["postgres"]
    }
  },
  "services": {
    "api": {
      "type": "api",
      "start": "PORT=\"$AGENTLANE_API_PORT\" exec node api/server.mjs",
      "ready": { "kind": "http", "path": "/health" },
      "needs": ["postgres"]
    }
  }
}
```

`db` is the app's database, cloned from a template by the recipe in [A database per lane](resources.md#clone-a-template-instead-of-migrating-each-lane). `testdb` is an empty database for the test suite, which migrates it as it does today.

## Write start, stop and ready

The three are shell commands, run from the folder that holds `agentlane.json` unless you set `cwd`.

- **`start`** starts the server and exits, leaving it running. The one above starts the container when it exists and creates it when it doesn't.
- **`stop`** stops the server and keeps its data. The one above stops the container, and counts a container that isn't there as stopped. The data lives in the named volume `shop-pg-data`, which outlives the container.
- **`ready`** exits 0 when the server answers. agentlane runs it after `start` until it passes, and also to tell whether the server is already running.

> [!WARNING]
> `start` and `stop` each have to cope with running twice, and with finding the server already in the state they set: `start` with a server that already runs, `stop` with one that is already stopped or only partly started. A failed stop is tried again a minute later, so a `stop` that exits non-zero on a missing container fails every minute for good.

Leave out restart policies such as `--restart unless-stopped` or `restart: always`. They start the container again whenever Docker starts, with no lane that needs it.

`start` gets `timeoutSeconds` to run, and then `ready` gets the same time to pass, 180 seconds each by default, which covers a cold start of Docker's VM. `stop` gets `timeoutSeconds` too.

A stop can run long after the start, from another worktree, after the one that started it is deleted. So it runs the commands, the folder, the `PATH` and the variables that pick a container tool's daemon and project (`DOCKER_HOST`, `DOCKER_CONTEXT`, `COMPOSE_PROJECT_NAME`, `CONTAINER_HOST` and the like) recorded at the last start. When the folder is gone, it runs in the shared service's log folder, so write `stop` as a command that needs no script from the worktree, as above. A change to the commands in `agentlane.json` counts from the next start.

## When it starts

A lane needs a shared service when one of its resources, or one of the services of a platform it was brought up for, names it in `needs`. agentlane starts it:

- in `up`, in the `shared` step, after the build preconditions and before the resources' `create`;
- when a parked lane wakes, before its services start;
- in `restart`, before it stops the service it restarts;
- before a resource's teardown that needs it, so a release, a session-end release or a reap can drop the lane's database after the server stopped.

Each start first runs `ready`. A server that already answers is kept, and `start` doesn't run. Two lanes that come up together start it once. In `up` the step reads:

```text
agentlane up: shared: starting shared service postgres: docker start shop-pg 2>/dev/null || docker run -d ...   (log: ~/.local/state/agentlane/shared/shop-3f9a1c2b7e/postgres.log)
agentlane up: shared: postgres started (4.2 s)
```

The `shared` step says `running` for a server it kept, and `already up, so its start did not run` for one it found answering. A lane that needs none of the declared services shows `none needed`.

When `start` fails, or `ready` doesn't pass in time, `up` stops with the shared service's name, the end of its output and its log. The lane stays, so the next `up` tries again.

## When it stops

agentlane stops a shared service 5 minutes after the last lane that needs it parks or ends. A lane that is parked, or ended, no longer needs anything. A lane held with `keep` isn't parked, so it keeps its server up. A resource teardown that needs the server holds it up while it runs, and the 5 minutes count from when it finishes.

The stop runs from the [sweep](lanes.md#the-sweep), which runs while any agentlane process runs: each MCP server checks every minute, and every agentlane command checks as it starts. With no agentlane process running, a stop that is due happens at the next agentlane command.

A stop that fails leaves the server running, and the sweep tries it again a minute later. A start that failed may have left the server partly up, so it counts as running and stops under the same rule.

Declaring a server under `shared` hands its life to agentlane. A server that was already running when a lane first needed it, such as one you started by hand, is kept as it is, and stopped like any other once no lane needs it.

agentlane stops a shared service and never removes one. Its container, its volume and its data stay, and the next start brings the same data back.

## One per repository

There is one of each shared service per repository, used by the lanes of all its worktrees. agentlane tells repositories apart by their git folder, so two worktrees of one repository share the server, and two repositories each get their own, even when both name it `postgres`. A container's name, its volume and its port belong to the whole machine, though, so give each repository's server names and a port of its own.

## Tests that need only the data

Tests that read a database need no device, browser or app. `up --no-app` brings up the project's data alone: it runs the preflight, setup, the shared services the resources need, and the resources, and claims no device, browser or port:

```sh
npx agentlane up --no-app
npx agentlane exec -- pnpm test
```

`exec` gives the tests the resources' values, `TEST_DATABASE_URL` in the config above. Make every database the tests create a resource, a test-only one included, and its server a shared service. Then a test run never needs a container started by hand, which the [guard](guard.md#containers) denies.

A lane brought up with `--no-app` parks and wakes like any other, and a later plain `up` in the same folder adds the app to it, with the same data.

## Check it

`agentlane status` lists every shared service after the lanes, with the lanes that need it and when it stops:

```text
shared service postgres: running, used by no lane; stops 2026-11-21 14:35:00 (in 4m)
      repository   shop  (~/code/shop)   running since 2026-11-21 13:02:11
```

A stop or start that failed shows its problem and log. `lanes --json` has the same in a top-level `shared` array, and `reap` exits 1 when a stop fails. `doctor` has a `shared <name>` line for each shared service the lane needs, which runs its `ready`.

## Fields

| Field            | Required | What it is                                                                          |
| ---------------- | -------- | ----------------------------------------------------------------------------------- |
| `start`          | Yes      | Starts the server and exits, leaving it running.                                    |
| `stop`           | Yes      | Stops the server and keeps its data.                                                |
| `ready`          | Yes      | Exits 0 when the server answers.                                                    |
| `cwd`            | No       | The folder the three run in, relative to `agentlane.json`.                          |
| `timeoutSeconds` | No       | How long `start` may run, then how long `ready` may take, and how long `stop` may run. Default 180. |

`needs` on a resource or a service lists the shared services it uses, by name. A name not declared under `shared` fails validation, naming the ones that are.
