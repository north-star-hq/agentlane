---
title: "Browsers for web apps"
short: "Each web lane gets its own browser profile and driver session."
summary: "On the web, a lane gets its own browser: a profile, a debugging port and a driver session. agentlane installs the pinned driver, Playwright or agent-browser, with its browsers into its own data folder. `up` opens the web app in the lane's browser and signs in through the project's `signin` hook, which saves the session for the browser to start with."
---

## The lane's browser

A web lane's browser is Chrome for Testing with three things of its own:

- a **profile folder**, so its cookies, storage and sign-in are the lane's alone;
- a **debugging port** from the `browser` block, 41400–41439;
- a **driver session** named after the lane, such as `agentlane-4b5850b6`.

`up --platform web` starts it on the web app's page and prints the URL. `doctor`'s `browser` line checks that the browser on that port is the one on this lane's profile, not another lane's. At release the browser and its driver's daemons stop, and the profile and the saved login are deleted. The evidence folder stays.

## Playwright or agent-browser

The project picks the driver in `agentlane.json`:

```json title="agentlane.json"
{
  "web": { "service": "web", "path": "/", "browser": { "driver": "playwright" } }
}
```

| Driver          | Version | CLI the agent uses | Window                                             |
| --------------- | ------- | ------------------ | -------------------------------------------------- |
| `playwright`    | 1.64.0  | `playwright-cli`   | Headless, or a window with `"headed": true`        |
| `agent-browser` | 0.39.0  | `agent-browser`    | Headless, on Chrome for Testing's headless shell   |

Playwright is the default. Choose agent-browser when the project already drives browsers with it. Both drive the same pinned Chrome for Testing. `headed` shows the window so a person can watch, and works with Playwright only.

The agent drives the browser through the driver's own CLI, run under `exec`, which binds it to the lane: it sets the driver's session, the web app's URL in `AGENTLANE_WEB_URL`, the saved login in `AGENTLANE_STORAGE_STATE`, and puts agentlane's pinned driver first on the PATH.

```sh
npx agentlane look --browser
npx agentlane exec -- playwright-cli click e5
npx agentlane exec -- agent-browser fill @e2 "ada@example.com"
```

The guard hook denies a driver command aimed at another lane's session or port. The pinned wrappers refuse `playwright-cli kill-all`, which stops every Playwright browser on the machine, and the drivers' own install commands, which would replace builds other lanes use.

## Signing in

The `signin` hook gets the session the way a real client does, through the app's own sign-in endpoint with a test account. It writes the cookie or token it gets back to the file in `$AGENTLANE_STORAGE_STATE`, in Playwright's storage-state format. The lane's browser starts with it, so it opens signed in.

```js title="scripts/signin.mjs"
const url = new URL(process.env.AGENTLANE_WEB_URL);
const response = await fetch(new URL('api/session', url), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password }),
});
const token = /(?:^|;\s*)session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
writeFileSync(
  process.env.AGENTLANE_STORAGE_STATE,
  JSON.stringify({
    cookies: [{ name: 'session', value: token, domain: url.hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [],
  }),
);
```

`up` checks the file and keeps its values out of every log. In a project with a mobile app too, one `signin` hook serves both, branching on `$AGENTLANE_PLATFORM`. A page that shows a sign-in form means the hook or the account is wrong; fix that rather than signing in by hand.

## Headed browsers

```json title="agentlane.json"
{ "web": { "browser": { "driver": "playwright", "headed": true } } }
```

A headed browser opens a window on the machine running the lane. To show a run to someone later, record a video instead, with `evidence video start` and `evidence video stop`.

## Your own Playwright tests

The project's Playwright tests can run in a lane too, against its services and signed in as its account, with `exec`:

```sh
npx agentlane exec -- npx playwright test
```

Under `exec`:

- `PLAYWRIGHT_TEST_BASE_URL` is the lane's web app, which Playwright Test uses as `baseURL` when the config sets none;
- `AGENTLANE_STORAGE_STATE` is the saved login, for `storageState`;
- `AGENTLANE_EVIDENCE` is the evidence folder, a good home for `outputDir` so a failed run's trace outlives the lane;
- the tests launch agentlane's pinned browsers, so the project's `@playwright/test` must be 1.64.x.

The example app's `playwright.config.ts` reads each of these when it's set and keeps its own behaviour when it isn't:

```ts title="playwright.config.ts"
export default defineConfig({
  outputDir: evidence ? `${evidence}/${process.env.EXAMPLE_RUN_STAMP}-playwright-test` : 'web/test-results',
  use: { baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? ownBaseUrl, trace: 'retain-on-failure' },
  projects: [{ name: 'signed-in', use: { ...chrome, storageState: process.env.AGENTLANE_STORAGE_STATE ?? OWN_LOGIN } }],
  webServer: process.env.AGENTLANE_WEB_URL ? undefined : ownServers,
});
```

## Installing the browsers

`up` installs the driver and its browsers on first use. To do it ahead of time, or to see what is installed:

```sh
npx agentlane browser install
npx agentlane browser install --driver agent-browser
npx agentlane browser status
```

They go into agentlane's data folder, `~/.local/share/agentlane/`, shared by every project on the machine and checked against pinned sha256 sums. Never run `npx playwright install` for a lane; agentlane's builds are already there. `--from <dir>` takes the same archives from a folder instead of downloading them, and they are still checked. On a host with no pinned build, install Playwright's browsers yourself and point `AGENTLANE_PLAYWRIGHT_BROWSERS` at the folder.
