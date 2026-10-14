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
