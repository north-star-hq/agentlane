---
title: "Ports and dev servers"
short: "Each service gets a free port and a ready check."
summary: "Services are the long-running processes an app needs, such as Metro, an API or a web dev server. Each gets a port from its type's block, passed as `AGENTLANE_<NAME>_PORT`, and `up` waits for its ready check before it moves on. `doctor` checks that the process on each port runs this worktree's code, not a server another checkout left behind."
---

## Declaring a service

Services live under `services` in `agentlane.json`, by name. These are the example app's three:

```json title="agentlane.json"
{
  "services": {
    "metro": {
      "type": "metro",
      "platforms": ["ios", "android"],
      "start": "EXPO_NO_TELEMETRY=1 exec node_modules/.bin/expo start --dev-client --port \"$AGENTLANE_METRO_PORT\" </dev/null",
      "ready": { "kind": "http", "path": "/status", "body": "packager-status:running" },
      "timeoutSeconds": 120
    },
    "api": {
      "type": "api",
      "start": "PORT=\"$AGENTLANE_API_PORT\" exec node api/server.mjs",
      "ready": { "kind": "http", "path": "/health" },
      "dial": { "argument": "-apiBaseUrl" }
    },
    "web": {
      "type": "web",
      "start": "API_URL=\"http://127.0.0.1:$AGENTLANE_API_PORT\" exec node_modules/.bin/vite web --port \"$AGENTLANE_WEB_PORT\" --strictPort --host 127.0.0.1 </dev/null",
      "ready": { "kind": "http", "path": "/" }
    }
  }
}
```

`start` runs the server in the foreground on the port in `AGENTLANE_<NAME>_PORT`: the service's name upper-cased, with dashes as underscores. `up` starts it in its own process group, from the folder that holds `agentlane.json` unless `cwd` says otherwise, and logs it to a file in the lane's folder.

A server has to take its port from that variable. One that hard-codes its port collides with the next lane's, and making it read the variable is the one change setup makes to such a server.

> [!TIP]
> Every lane starts its own copy of each server. When a server's CLI sends usage telemetry, turn it off in `start` with the variable the CLI documents, such as `EXPO_NO_TELEMETRY=1` or `NEXT_TELEMETRY_DISABLED=1`.

## Port blocks and types

`type` names the block the port comes from: `metro`, `api` and `web` are built in, at 41100, 41200 and 41300. A type of your own declares its block with `ports`:

```json title="agentlane.json"
{
  "services": {
    "worker": {
      "type": "worker",
      "ports": [41500, 41519],
      "start": "exec node worker.mjs --port \"$AGENTLANE_WORKER_PORT\"",
      "ready": { "kind": "tcp" }
    }
  }
}
```

The machine's own blocks win where they overlap, and no block may overlap the Android emulator's ports, 5554–5585. When a lane has exactly one service of a built-in type, it also gets that type's variable, such as `AGENTLANE_API_PORT`, whatever the service is called.

## Ready checks

`up` moves on only when the service answers its ready check, and waits up to `timeoutSeconds` (60 by default).

| Check | Passes when                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------- |
| HTTP  | `GET path` on the service's port returns `status` (200 by default), and the body contains `body` when you set it |
| TCP   | Something accepts a connection on the port                                                     |

Both connect to `127.0.0.1` unless `host` says otherwise. A service that exits or never answers fails the step with the last lines of its log.

## Platforms

`platforms` limits a service to the apps that need it. In the example above, Metro serves only the mobile app, so `up --platform web` doesn't start it, and `doctor` and `restart` for the web leave it out. Leave `platforms` out to run a service for every platform.

## Dialing a service from the app

A mobile app needs this lane's API address, not one baked into the build. `dial` passes it as a launch argument:

```json
"dial": { "argument": "-apiBaseUrl", "value": "http://localhost:{port}" }
```

`up` launches the app with `-apiBaseUrl http://localhost:41201`, with `{port}` replaced by the lane's port. `value` defaults to `http://localhost:{port}`. A debug build reads the argument at launch. `doctor`'s `dials` line checks that the running app got it.

## This worktree's code

A port can answer with the wrong code: a dev server another checkout left running, or one started from the wrong folder. For each service, `doctor` checks the process listening on the port as well as the response. It fails when the listener isn't one `up` started for this lane, or when it runs in a folder outside this worktree, and names the pid and the folder:

```text
FAIL  service web: pid 4021 is running; listening on 41300; ... the listener pid 4188 runs in ~/code/shop, outside this worktree ~/code/shop/.claude/worktrees/checkout-fix, so 41300 serves that folder's code
```

A listener started through a package manager, such as `pnpm exec next dev`, counts as the service's own, because agentlane looks at every process below the one it started.

## Restarting with a new environment

```sh
FEATURE_CHECKOUT_V2=1 npx agentlane restart web
```

`restart` stops one service and starts it on the same port with the lane's variables plus that call's environment. It returns when the ready check passes, and leaves the device, the app and the other services as they are. [Bring a worktree up](up.md#restarting-one-service) has more.
