---
title: A database per lane
short: Give each lane its own copy of the data, created by up and dropped at release.
summary: A resource is data a lane gets its own copy of, such as a database. You give agentlane a command that creates it and one that removes it. `up` runs the first once per lane and passes the values it exports to every server, hook and command in the lane; the second runs when the lane ends, even after a crash.
---

## Declare a resource

Resources live under `resources` in `agentlane.json`, by name. This one gives each lane a Postgres database:

```json title="agentlane.json"
{
  "resources": {
    "db": {
      "create": "scripts/lane-db.sh create",
      "exports": ["DATABASE_URL"],
      "teardown": "scripts/lane-db.sh drop"
    }
  }
}
```

`create` and `teardown` are shell commands, run from the folder that holds `agentlane.json` unless you set `cwd`. A resource needs both.

## Write the create command

`create` makes the resource and hands its values back by writing `NAME=value` lines to the file that `$AGENTLANE_EXPORTS` names. `$AGENTLANE_LANE` holds the lane's id, so a name built from it can't collide with another lane's:

```sh title="scripts/lane-db.sh"
#!/bin/sh
set -eu
name="app_$AGENTLANE_LANE"
url="postgres://localhost/$name"
case "$1" in
  create)
    dropdb --if-exists "$name"
    createdb "$name"
    DATABASE_URL="$url" npm run db:migrate
    echo "DATABASE_URL=$url" >> "$AGENTLANE_EXPORTS"
    ;;
  drop)
    dropdb --if-exists "$name"
    ;;
esac
```

A create must write every variable it lists in `exports`, and no other. Names that start with `AGENTLANE_`, and `LANG` and `LC_ALL`, belong to agentlane and can't be exported.

> [!WARNING]
> Both commands have to cope with being run twice. A create that failed or never finished runs again at the next `up`, so it starts from whatever the first run left. A teardown that failed runs again at the next release or reap, so it may find the resource already gone. The script above drops the database before it creates one, and drops it only if it exists.

## Where the values go

`up` runs each create once per lane, in the order the config lists them, after the setup hook. The values they export then reach:

| Where                                   | Gets the values |
| --------------------------------------- | --------------- |
| The lane's services                     | Yes             |
| The hooks that run after setup          | Yes             |
| `agentlane exec -- <command>`           | Yes             |
| The setup hook                          | No, it runs first |
| Your own shell, outside `exec`          | No              |

A command in the lane never takes an exported name from the environment of whoever called it, so a `DATABASE_URL` left in your shell can't point an agent at the wrong database.

## When teardown runs

Each teardown runs when its lane ends, last created first:

- at `agentlane release`;
- when the agent's session ends and its hook releases the lane;
- when another `claim` or `up` reaps a lane whose owner died, or takes over an idle one.

agentlane records what teardown will run when create starts: the command, its folder and its variables, including the values create exported. So teardown still works after `agentlane.json` changes, after the session that made the lane has died, and after its worktree is deleted, in which case it runs in the lane's log folder. A teardown gets 120 seconds unless `teardownTimeoutSeconds` says otherwise.

## Clone a template instead of migrating each lane

The script above migrates every lane's database from empty. A Postgres template does that work once: migrate one database, mark it as a template, and give each lane a copy with `CREATE DATABASE ... TEMPLATE`. worktree-pg measured an 82 MB template cloned in a median 469 ms, against 18.6 s to create, migrate and seed the same database (Postgres 17, a laptop with an NVMe disk). The copy is a full one, so a lane can change its database in any way without touching the template or another lane.

The example app in the agentlane repository carries this recipe as `examples/expo-app/scripts/lane-pg.sh`. Copy it into your project and wire it in as the resource:

```json title="agentlane.json"
{
  "resources": {
    "db": {
      "create": "scripts/lane-pg.sh create",
      "exports": ["DATABASE_URL"],
      "teardown": "scripts/lane-pg.sh drop"
    }
  }
}
```

It needs `psql` on the `PATH` and Postgres 13 or later, on your Mac or in a container whose port `psql` can reach. These variables change what it does. Set them in front of both commands, as in `"LANE_PG_SERVER=postgres://me@localhost:5433 scripts/lane-pg.sh drop"`, rather than in your shell, so a teardown run by another session's reap uses the same server:

| Variable             | Default                     | What it is                                                                 |
| -------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `LANE_PG_SERVER`     | `postgres://localhost:5432` | The server, as a URL without a database name. Add a user and password here. |
| `LANE_PG_MIGRATIONS` | `migrations`                | The folder of migrations and seeds, relative to `agentlane.json`.          |
| `LANE_PG_MIGRATE`    | none                        | Your own migrate command, run with `DATABASE_URL` set to the new template. Without one, the script runs each `.sql` file in the folder through `psql`, in name order. |
| `LANE_PG_PREFIX`     | `app`                       | The start of every database name it makes. At most 35 bytes, because Postgres cuts names at 63. |

A lane's database is `app_<lane id>`. Its template is `app_template_<fingerprint>`, where the fingerprint is a hash of every file in the migrations folder, leaving out dotfiles such as `.DS_Store`, and of `LANE_PG_MIGRATE`.

**When a template is built.** create looks for the template that matches the migrations as they are now. When it isn't there, create builds it into a database named `<template>_build`, marks that as a template that accepts no connections, and renames it. So the template is rebuilt whenever a migration is added or changed, or the migrate command changes. Databases already cloned from the old template stay as they are, and the old template stays too, for any worktree still on the old migrations. To remove one by hand, run `ALTER DATABASE <name> IS_TEMPLATE false` and then `DROP DATABASE <name>`.

**When several lanes start at once.** Before building, create takes a Postgres advisory lock keyed by the fingerprint and builds the template inside that one session. The other lanes wait on the lock, then find the template and clone it, so it is built once. That session turns off `statement_timeout`, `lock_timeout` and, on Postgres 14 and later, `idle_session_timeout`, so a slow build neither fails the waiting lanes nor loses the lock. Postgres frees the lock when the session ends, so a build that crashed leaves no lock behind, and the next create clears the template mark on the half-built `<template>_build`, drops it and starts again.

**Why a clone finds the template free.** Postgres refuses to copy a database while another session is connected to it. The migrations run while the database still has its build name, and it is closed to connections before it is renamed, so nothing can ever connect to the finished template, not even a superuser.

Running create twice drops and clones the lane's database again, and running drop twice finds nothing the second time, so both cope with a partial earlier run. Drop uses `WITH (FORCE)`, which ends any session still connected to the lane's database, so a server that is still running doesn't stop it.

## Check it

`agentlane doctor` prints a `resource <name>` line for each resource, which says whether the lane created it. To read the values the way a service sees them, run a command through the lane:

```sh
npx agentlane exec -- printenv DATABASE_URL
```

## Fields

| Field                    | Required | What it is                                                      |
| ------------------------ | -------- | --------------------------------------------------------------- |
| `create`                 | Yes      | The shell command that makes the resource for this lane.        |
| `teardown`               | Yes      | The shell command that removes it when the lane ends.           |
| `exports`                | No       | The variables create writes, such as `DATABASE_URL`.            |
| `cwd`                    | No       | The folder both commands run in, relative to `agentlane.json`.  |
| `teardownTimeoutSeconds` | No       | How long teardown may run before it counts as failed. Default 120. |

The example app in the agentlane repository gives each lane its own SQLite file this way: see `examples/expo-app/agentlane.json` and `examples/expo-app/api/database.mjs`.
