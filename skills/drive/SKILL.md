---
name: drive
description: Drive the app on this session's own lane - its simulator or emulator through the device tools (look, run, screenshot over MCP, or `agentlane look|run|screenshot` from a shell), its browser through the driver's own CLI under `agentlane exec` (playwright-cli or agent-browser) - and turn what works into proof and evidence. Use when seeing what is on a screen or page, clicking or typing in the web app, trying or repairing Maestro steps or a Playwright test, checking what an action did, reading a failed step, recording a video, trace or screenshot, or setting a device's location, permissions, appearance, push, clipboard or URL.
---

# Driving the app on your lane

Everything here acts only on what your session claimed for the folder you work in: a simulator or emulator, a browser, or both. The tools never take a device id or a browser session. Run the toolkit's commands from the project root as written here, `node_modules/.bin/agentlane <command>`, which works in every agent's shell. A lane comes from `node_modules/.bin/agentlane up`: `--platform android` for an emulator, `--platform web` for the web app in its own browser (the default when the project has only a web app). `node_modules/.bin/agentlane claim --boot` gives a bare device. A tool called before any lane answers with the command to run.

The verbs are the same on both. `look` reads the screen or the page, `screenshot` saves it, and `node_modules/.bin/agentlane evidence` keeps proof. Over MCP, `look` and `screenshot` take `browser: true`. From a shell they take `--browser` or `--device` when the lane holds both, and read the browser when the lane holds no device. The MCP server serves the whole agent session, so when your session holds lanes in several folders (parallel subagents in their own worktrees), use the shell form from your worktree, or pass `--worktree <dir>`.

Done when what you set out to show passes as a committed flow or test, run cold through the project's own runner, and the evidence its reader needs is in the lane's evidence folder.

## Look before you act

Most failed steps come from acting on a screen that isn't the one you pictured: a sheet still animating in, a list still loading, a page that redirected. `look` prints one line per element. Act on what it gives you, and look again after anything that navigates.

- **On a device**, each line has the element's role, id (the testID), label and state. `interactiveOnly` keeps what you can tap, toggle or type into, `within` narrows to one element's subtree, and `bounds` adds each frame in points. Act on ids, then labels; fall back to a point only when an element has neither. A read that comes back nearly empty (maps, canvases, some sheets) brings a screenshot with it: tap what it shows by point.
- **In a browser**, the first line is `Page: "<title>" at <url>`, then one line per element, indented by nesting: `[role] ref=eN "name"`. The ref is what the driver acts on, and it changes after navigation. The two drivers print the page differently (playwright-cli keeps generic wrappers, agent-browser shows text as `StaticText`), so match on roles and names rather than on the exact lines. A browser look has no bounds or raw mode.

Take a screenshot when the question is how something looks rather than what is there. A device's is a JPEG and a browser's a PNG.

## Drive a device with run

`run` takes Maestro YAML (a header with `appId:` and `---` is optional when you pass `appId`) or a flow file, and returns what changed on screen between the reads before and after. Each lane keeps one Maestro session warm, so a look returns in a few tenths of a second and a tap in under a second. Text that ticks on its own, such as clocks and counters, is left out of that diff, so an empty diff after a tap means the tap changed nothing visible: look again before you assume it worked. `quick: true` taps without waiting for the screen to settle; it is for exploring, and its results aren't proof. A `takeScreenshot` in the YAML lands in `$AGENTLANE_LOGS/shots/`, and `run` prints each file's path.

A failed step comes back with its kind, the step, whether the action reached the device (yes, no or unknown), the screen as it is now, and selectors that would match. Read it before you retry: "no" means nothing happened and a corrected retry is safe; "unknown" means look first, because the app may have moved. An absence check (`assertNotVisible`) that Maestro passed is checked once more against the screen the step left: it fails when the read fails, and on a nearly empty read it fails only for text that no read in the run held, since that text could be drawn where the tree describes nothing. Select by id when you can: an id lives only in the tree, so its absence holds on any readable screen.

## Drive a browser with its driver

The lane's browser is driven by the driver the project picked (`web.browser.driver` in `agentlane.json`, Playwright by default), through that driver's own CLI. `node_modules/.bin/agentlane exec` binds it to your lane: it sets the driver's session, the web app's URL (`$AGENTLANE_WEB_URL`, and `PLAYWRIGHT_TEST_BASE_URL` for tests) and the saved login (`$AGENTLANE_STORAGE_STATE`), and puts the toolkit's pinned driver first on the PATH.

- Playwright: `node_modules/.bin/agentlane exec -- playwright-cli click e5`, `fill e5 "text"`, `goto <url>` (`playwright-cli --help` lists the rest). Pass a ref as `look` prints it. `playwright-cli find <text>` searches the snapshot `snapshot` prints, ignoring case, as the page is when it runs. It doesn't wait, so right after a `goto` a page that is still rendering gives "No matches": take a `snapshot` or run `find` again before you call the text absent.
- agent-browser: `node_modules/.bin/agentlane exec -- agent-browser click @e1`, `fill @e1 "text"`, `snapshot -i`. Put an `@` in front of the ref `look` prints.

The browser is headless unless the config sets `web.browser.headed`, which only Playwright supports; agent-browser always runs headless. When a person needs to watch the browser, that is the Playwright driver with `headed: true`, or a video.

The browser starts signed in when the project has a `signin` hook, so a page that shows a sign-in form means the hook or the account is wrong; fix that rather than signing in by hand. Pass no session flag (`-s=`, `--session`): `exec` already names yours, and a command aimed at another lane's session is denied. The toolkit installs pinned drivers and browsers in its own folder, so `npx playwright install` and the drivers' install commands aren't needed, and the wrappers refuse them because they would delete builds other sessions use.

## Probe, then prove

A probe shows you the steps; it isn't evidence, because nobody can replay it. A probe is done when the steps it found pass as a committed flow or test, run cold through the project's own runner.

- **Device:** `run` records every passing step of this session. `node_modules/.bin/agentlane record save <file>` writes them as a Maestro flow (`record show` lists them, `record clear` starts over). Steps from a flow file keep its `${NAME}` placeholders, so the saved flow needs the same values at replay (`maestro test -e METRO_PORT=<port> -e API_PORT=<port> <file>`, or the project runner's way of passing them). Steps you typed keep what you typed, such as a claimed port: swap those for the flow's variables. Put the flow beside the project's other flows and run it under `node_modules/.bin/agentlane exec`, where `maestro` is the toolkit's build bound to your device.
- **Browser:** write the steps as a Playwright test beside the project's others, by role and label rather than refs, and run it through the project's runner under exec: `node_modules/.bin/agentlane exec -- npx playwright test <file>`, or the project's script. Playwright Test takes its base URL from `PLAYWRIGHT_TEST_BASE_URL` on its own; the config gives the signed-in tests `storageState` from `AGENTLANE_STORAGE_STATE` and writes each run's output, traces kept on failure, to its own folder under `AGENTLANE_EVIDENCE`. The project's `@playwright/test` has to be the toolkit's Playwright version (`node_modules/.bin/agentlane browser status` names it), or the tests find no browser under exec. A config that doesn't read them yet is the run skill's to fix; the `create-verification-skill` skill says how.

## Evidence

Prove a behaviour with an assertion: the committed flow or test above, checking the end state, read back where it lands (a row, a file, a message) as well as on screen. Then add what the reader of your result needs, which is your call:

- a video when a user-visible change goes to a person: `node_modules/.bin/agentlane evidence video start`, drive it, `node_modules/.bin/agentlane evidence video stop`;
- a screenshot when the owner judges how it looks: `node_modules/.bin/agentlane evidence screenshot`;
- a trace when you need the steps in detail: `node_modules/.bin/agentlane evidence trace start`, then `stop`;
- logs when a server or the console explains a failure: `node_modules/.bin/agentlane evidence logs --since 5m`.

Each prints the file it wrote in the lane's evidence folder, `$AGENTLANE_EVIDENCE`, which outlives `release` by seven days; `node_modules/.bin/agentlane evidence list` shows what is there. A failed run, and a failed command under exec on a browser lane, keep their own bundle there (the trace, a screenshot, the page or screen, the console or driver log) without being asked. `maestro test` under exec or in a hook keeps its whole output there, its `takeScreenshot` files included, in a folder per run: `<stamp>-maestro-test-<pid>`, ending `-failed` when the test failed. Read that bundle before you retry, and name the files you cite in your report.

## Device controls

Settings that aren't taps live in the CLI, on the same claimed device: `node_modules/.bin/agentlane device location <lat>,<lon> | clear`, `device permission grant|revoke|reset <service> [<bundle id>]`, `device appearance light|dark`, `device push <bundle id> <payload.json | ->`, `device clipboard set <text> | get` and `device open <url>`. On an emulator, `location clear`, `push` and `clipboard` have no adb equivalent and refuse with the reason; `permission` takes the package name and grants the Android permissions behind the service that the app declares.

## Other sessions' devices and browsers

Run `simctl`, `adb` and the browser drivers only against your own lane: `$AGENTLANE_DEVICE` and the session `exec` sets. The toolkit's hook denies those commands when they aim at a simulator, emulator or browser session another lane holds, and also `booted`, `all` and an `adb` with no `-s` while other lanes hold devices; the denial names the holder and the command that recovers. `node_modules/.bin/agentlane status` lists every lane on the machine with its owner, folder and last action.
