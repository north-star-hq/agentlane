---
name: run
description: Run and drive the example project - its Expo app on the lane's simulator or emulator, its Vite web app, and the API with the SQLite database each lane gets - through agentlane up, doctor, exec and release, then prove a change with the Maestro flows, the Playwright tests and API calls. Use before running either app, starting their servers, signing in as the test account, or proving a change to a screen, a page, the API or the database.
---

# Run the example

The project has two apps over one API: the Expo app (`src/`) and the web app (`web/`). Each lane gets its own API and web ports, Metro on a mobile lane, a browser on a web lane, and its own database, a SQLite file the toolkit creates on the lane's first `up` and deletes when the lane ends. Run everything from `examples/expo-app`. `README.md` has the API's requests, the test account and the testIDs; `features/` has one page per feature.

## Launch

```bash
node_modules/.bin/agentlane up                  # iOS: simulator, build, Metro, API, web app, launch
node_modules/.bin/agentlane up --platform web   # the web app in the lane's own browser, signed in: no device, ready in seconds
```

Either ends on doctor's `ready`. A web `up` starts the API and the web app (not Metro), opens `$AGENTLANE_WEB_URL` in the lane's Playwright browser and prints `the web app is at <url>`. The lane's first `up` logs `resources: created db`; later ones keep the same database, so rows written earlier are still there. To start from the seed again, `release`, then `up`.

The `signin` hook (`scripts/signin.mjs`) signs the test account, `tester@example.com` with `example-password`, in through the API and writes the cookie to `$AGENTLANE_STORAGE_STATE`, so the lane's browser starts on the signed-in places page. A sign-in form in the lane's browser means that hook failed: read `hooks/signin.log` in the lane's logs. The mobile app doesn't sign in.

## Doctor

`node_modules/.bin/agentlane doctor`. Beyond the service checks, two lines matter here: `resource db` says the lane's database was created, and `web app` gives the URL. `GET /items` answers with the `port` that served it: `agentlane exec -- sh -c 'curl -s "${AGENTLANE_WEB_URL}api/items"'` showing `$AGENTLANE_API_PORT` proves the web app talks to this lane's API.

## Drive

- **Web:** the lane's browser with `agentlane look` and the driver's CLI under `exec` (load the `drive` skill), for example `node_modules/.bin/agentlane exec -- playwright-cli click "getByTestId('sort-shortest')"`. Each element has a `data-testid` from the README. The committed tests are the replayable path: `node_modules/.bin/agentlane exec -- npx playwright test`. Under `exec` they use the toolkit's pinned browsers and start signed in from the lane's saved login; the tests of sign-in itself start signed out. The toolkit installs its browsers itself (`agentlane browser install` does it ahead of time), and `@playwright/test` is pinned to the toolkit's Playwright version so they match.
- **Mobile:** the device tools on the lane's device (load the `drive` skill), by testID. The flows take the ports as parameters: `node_modules/.bin/agentlane exec -- sh -c 'maestro test -e METRO_PORT="$AGENTLANE_METRO_PORT" -e API_PORT="$AGENTLANE_API_PORT" .maestro'`. Under `exec`, `maestro` is the toolkit's build, bound to the lane's device.
- **API:** `curl` against `http://127.0.0.1:$AGENTLANE_API_PORT` or through the web app at `${AGENTLANE_WEB_URL}api/`. A write needs a session: `POST /session` with the test account returns a `token` for `Authorization: Bearer <token>`.
- **Database:** the lane's database is the file at `$DATABASE_PATH`, set under `exec`. Read it with `node -e` and `node:sqlite` or with `sqlite3`; write through the API, so the API's checks run.

## Evidence

A row a change writes is proven by reading it back through the API (`GET /items`) as well as on the screen or page. A passing `npx playwright test` or Maestro run under `exec` is the proof; probing with `look`, the driver's CLI or a one-off `curl` only finds the steps. Under `exec`, each Playwright run writes its output to `$AGENTLANE_EVIDENCE/<stamp>-playwright-test/`, with a `trace.zip` per failed test (`npx playwright show-trace <file>`), and the toolkit keeps the browser's own trace and a screenshot in `<stamp>-npx-playwright-test-failed/`. The evidence folder outlives `release`.

## Cleanup

`node_modules/.bin/agentlane release` stops the services `up` started, closes the lane's browser and deletes the lane's database; the evidence folder stays. Copy anything you need from it first. Never stop the servers by name or port: another worktree's lane runs the same commands.
