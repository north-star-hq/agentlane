import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { lookAtBrowser } from '../../src/browser/screen.ts';
import type { BrowserDriverName } from '../../src/browser/kinds.ts';
import { browserPaths } from '../../src/browser/paths.ts';
import { systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { runRegistryCommand, type CliDeps } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import type { DoctorReport } from '../../src/up/doctor.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { up, type UpResult } from '../../src/up/up.ts';
import type { LaneInfo, ClaimedBrowser } from '../../src/registry/types.ts';
import { alive, failures, OPTIONS, sleeper, until, world, type World } from '../support/up-world.ts';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'signin-site');

function siteConfig(driver: BrowserDriverName, signin = 'node signin.ts') {
  return {
    web: { service: 'site', browser: { driver } },
    services: {
      site: { type: 'web', start: 'exec node site.ts', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 10 },
    },
    hooks: { signin },
  };
}

function git(cwd: string, ...args: string[]): void {
  const ran = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
}

/** The fixture site in the world's repo, committed, and a second worktree of it. */
function twoWorktrees(w: World, driver: BrowserDriverName): [string, string] {
  for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(FIXTURE, file), path.join(w.project, file));
  w.write(siteConfig(driver));
  git(w.project, 'add', '-A');
  git(w.project, 'commit', '-qm', 'site');
  const second = path.join(w.root, 'second');
  git(w.project, 'worktree', 'add', '-q', second);
  return [w.project, fs.realpathSync(second)];
}

function owners(t: TestContext, n: number): ChildProcess[] {
  const made = Array.from({ length: n }, () => sleeper());
  t.after(() => {
    for (const child of made) child.kill('SIGKILL');
  });
  return made;
}

function cliDeps(w: World, owner: number, cwd: string, out: string[]): CliDeps {
  return {
    env: w.deps({ owner }).env,
    cwd,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: w.deps().devices,
    system: realServiceSystem,
    browser: w.browser,
  };
}

function withBrowser(lane: LaneInfo): LaneInfo & { browser: ClaimedBrowser } {
  assert.ok(lane.browser, `lane ${lane.id} holds no browser`);
  return lane as LaneInfo & { browser: ClaimedBrowser };
}

async function page(w: World, result: UpResult): Promise<string> {
  return (await lookAtBrowser({ tools: w.browser, stateDir: w.state, lane: withBrowser(result.lane), env: w.deps().env }, {}))
    .text;
}

async function doctor(deps: EnvDeps): Promise<DoctorReport> {
  const out: string[] = [];
  await runUpCommand('doctor', ['--json'], deps, text => out.push(text));
  return JSON.parse(out.join('')) as DoctorReport;
}

function onProfile(w: World, profile: string): number[] {
  return w.browser.table.filter(e => e.args.includes(`--user-data-dir=${profile}`)).map(e => e.pid);
}

for (const driver of ['playwright', 'agent-browser'] as const) {
  test(`two worktrees of one web app reach a signed-in page in their own ${driver} browser at once, with no shared profile, port or cookie`, async t => {
    const w = world(t);
    const [one, two] = twoWorktrees(w, driver);
    const [a, b] = owners(t, 2);
    const [first, second] = await Promise.all([
      up({ ...w.deps({ owner: a?.pid ?? 0 }), cwd: one }, OPTIONS),
      up({ ...w.deps({ owner: b?.pid ?? 0 }), cwd: two }, OPTIONS),
    ]);
    for (const result of [first, second]) {
      assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
      assert.deepEqual(
        result.steps.map(s => s.step),
        ['preflight', 'claim', 'build preconditions', 'service site', 'browser', 'signin', 'doctor'],
      );
      const checks = result.doctor.checks.map(c => c.name);
      for (const name of ['browser driver', 'browser', 'service site', 'web app'])
        assert.ok(checks.includes(name), checks.join(', '));
    }
    assert.notEqual(first.lane.id, second.lane.id);
    const sessions = [first, second].map(r => w.browser.sessions.get(r.lane.browser?.session ?? ''));
    assert.ok(sessions[0] && sessions[1], `both browsers run: ${[...w.browser.sessions.keys()].join(', ')}`);
    assert.equal(sessions[0].driver, driver);
    assert.notEqual(sessions[0].profile, sessions[1].profile);
    assert.notEqual(sessions[0].port, sessions[1].port);
    assert.notEqual(sessions[0].cookies[0]?.value, sessions[1].cookies[0]?.value);
    assert.equal(sessions[0].port, first.lane.browser?.debugPort);
    assert.equal(sessions[0].profile, browserPaths(w.state, first.lane.id, first.lane.browser?.session ?? '').profile);

    const [pageOne, pageTwo] = [await page(w, first), await page(w, second)];
    assert.match(pageOne, new RegExp(`\\[heading\\] ref=e1 "Signed in as agent-${first.lane.id}"`));
    assert.match(pageOne, new RegExp(`Served from ${one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(pageTwo, new RegExp(`"Signed in as agent-${second.lane.id}"`));
    assert.match(pageTwo, new RegExp(`Served from ${two.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(pageOne.startsWith(`Page: "Home" at ${first.url ?? ''}`), pageOne);
    const login = browserPaths(w.state, first.lane.id, first.lane.browser?.session ?? '').storageState;
    assert.equal(fs.statSync(login).mode & 0o777, 0o600);
    assert.equal(
      w.lines.some(line => line.includes(sessions[0]?.cookies[0]?.value ?? 'none')),
      false,
      "the saved login's cookie reached the log",
    );

    const out: string[] = [];
    assert.equal(await runRegistryCommand('release', ['--worktree', one], cliDeps(w, a?.pid ?? 0, one, out)), 0, out.join(''));
    assert.deepEqual(onProfile(w, sessions[0].profile), [], `the browser of lane ${first.lane.id} still runs`);
    for (const pid of [sessions[0].daemonPid, sessions[0].browserPid, sessions[0].helperPid]) {
      assert.equal(
        w.browser.table.some(e => e.pid === pid),
        false,
        `pid ${String(pid)} of the released browser still runs`,
      );
    }
    assert.equal(fs.existsSync(login), false, 'the saved login outlived the release');
    assert.equal(fs.existsSync(sessions[0].profile), false, 'the profile outlived the release');
    assert.ok(w.browser.sessions.has(second.lane.browser?.session ?? ''), "the release stopped the other worktree's browser");
    assert.match(await page(w, second), /Signed in as/);
  });
}

test('up --platform web runs again on a lane whose browser is open and traced, and a driver command that fails in up is reported with a way out', async t => {
  const w = world(t);
  for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(FIXTURE, file), path.join(w.project, file));
  w.write(siteConfig('playwright'));
  w.browser.playwrightCli = true;
  const first = await up(w.deps(), OPTIONS);
  assert.equal(first.doctor.ok, true, `${failures(first)}\n${w.lines.join('\n')}`);
  const name = first.lane.browser?.session ?? '';
  assert.equal(w.browser.sessions.get(name)?.tracing, true);
  w.browser.calls.length = 0;

  const second = await up(w.deps(), OPTIONS);
  assert.equal(second.doctor.ok, true, `${failures(second)}\n${w.lines.join('\n')}`);
  assert.equal(second.lane.id, first.lane.id);
  assert.equal(w.browser.sessions.get(name)?.tracing, true);
  assert.deepEqual(
    w.browser.calls.filter(c => c.includes('tracing')),
    [`${name} playwright-cli tracing-start`, `${name} playwright-cli tracing-stop`, `${name} playwright-cli tracing-start`],
  );
  assert.match(second.steps.find(s => s.step === 'signin')?.detail ?? '', /the driver's actions are traced from here/);

  w.browser.failing.add('goto');
  const said: string[] = [];
  const code = await runUpCommand('up', [], { ...w.deps(), log: line => said.push(line) }, () => undefined);
  const text = said.join('\n');
  assert.equal(code, 1, text);
  assert.match(text, /playwright-cli goto http:\/\/localhost:\d+\/ exited 1:/);
  assert.match(
    text,
    /close the browser with node_modules\/\.bin\/agentlane exec -- playwright-cli close, and node_modules\/\.bin\/agentlane up opens a new one/,
  );
  assert.match(
    text,
    /the lane stays: fix this and run node_modules\/\.bin\/agentlane up again, or node_modules\/\.bin\/agentlane release/,
  );
});

test('on a machine whose browsers lack system libraries, up stops before opening the browser and doctor names each one, then both pass once they are installed', async t => {
  const w = world(t);
  for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(FIXTURE, file), path.join(w.project, file));
  w.write(siteConfig('playwright'));
  w.browser.libraries = ['libasound.so.2', 'libnss3.so'];
  const said: string[] = [];
  const code = await runUpCommand('up', [], { ...w.deps(), log: line => said.push(line) }, () => undefined);
  const text = said.join('\n');
  assert.equal(code, 1, text);
  assert.match(text, /Chrome for Testing can't start without system libraries this machine lacks: libasound\.so\.2, libnss3\.so/);
  assert.match(text, /to fix: (sudo )?\S+ \S+playwright-core\/cli\.js install-deps chromium/);
  assert.equal(w.browser.sessions.size, 0);

  const lacking = await doctor(w.deps());
  const check = lacking.checks.find(c => c.name === 'browser libraries');
  assert.equal(lacking.ok, false);
  assert.equal(check?.ok, false, JSON.stringify(lacking.checks, null, 2));
  assert.match(check.detail, /lacks: libasound\.so\.2, libnss3\.so$/);
  assert.match(check.fix, /playwright-core\/cli\.js install-deps chromium/);

  w.browser.libraries = [];
  const installed = await up(w.deps(), OPTIONS);
  assert.equal(installed.doctor.ok, true, `${failures(installed)}\n${w.lines.join('\n')}`);
  assert.deepEqual(
    installed.doctor.checks.filter(c => c.name === 'browser libraries').map(c => [c.ok, c.detail]),
    [[true, 'Chrome for Testing finds every system library it links']],
  );
});

test("a reaped lane's browser is stopped by the next claim, from the process table, even when it ignores SIGTERM", async t => {
  const w = world(t);
  const [one, two] = twoWorktrees(w, 'agent-browser');
  const [a, b] = owners(t, 2);
  const first = await up({ ...w.deps({ owner: a?.pid ?? 0 }), cwd: one }, OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  const session = w.browser.sessions.get(first.lane.browser?.session ?? '');
  assert.ok(session);
  w.browser.stubborn.add(session.browserPid);
  const service = readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes[0]?.processes[0];
  const reaped = new Promise(resolve => a?.once('exit', resolve));
  a?.kill('SIGKILL');
  await reaped;
  const second = await up({ ...w.deps({ owner: b?.pid ?? 0 }), cwd: two }, OPTIONS);
  assert.equal(second.doctor.ok, true, failures(second));
  assert.deepEqual(
    onProfile(w, session.profile),
    [],
    `the reaped browser still runs\n${w.browser.calls.join('\n')}\n${w.lines.join('\n')}`,
  );
  assert.ok(w.browser.calls.includes(`signal ${String(session.browserPid)} SIGKILL`), w.browser.calls.join('\n'));
  assert.equal(
    w.browser.table.some(e => e.pid === session.daemonPid),
    false,
    "the reaped lane's agent-browser daemon still runs",
  );
  await until(() => !alive(service?.pid ?? 0));
  const status = readRegistryStatus({ dir: w.state, processes: systemProcesses });
  assert.deepEqual(
    status.lanes.map(c => c.id),
    [second.lane.id],
  );
});

test('doctor fails, naming the cause, when the web service listener runs another folder’s code and when the driver install is missing or mismatched', async t => {
  const w = world(t);
  const [one] = twoWorktrees(w, 'playwright');
  const [a] = owners(t, 1);
  const deps = { ...w.deps({ owner: a?.pid ?? 0 }), cwd: one };
  const result = await up(deps, OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const port = result.lane.ports.find(p => p.service === 'site')?.port ?? 0;
  const [service] = w.processes();
  realServiceSystem.signalGroup(service?.pid ?? 0, 'SIGKILL');
  await until(() => !alive(service?.pid ?? 0));
  const elsewhere = path.join(w.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.copyFileSync(path.join(FIXTURE, 'site.ts'), path.join(elsewhere, 'site.ts'));
  const impostor = spawn(process.execPath, ['site.ts'], {
    cwd: elsewhere,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(() => impostor.kill('SIGKILL'));
  await until(() => spawnSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN']).status === 0, 10_000);
  const report = await doctor(deps);
  const site = report.checks.find(c => c.name === 'service site');
  assert.equal(site?.ok, false, JSON.stringify(report.checks, null, 2));
  assert.match(site.detail, new RegExp(elsewhere.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const kind of ['missing', 'mismatch'] as const) {
    w.browser.installKind.playwright = kind;
    const broken = await doctor(deps);
    const check = broken.checks.find(c => c.name === 'browser driver');
    assert.equal(check?.ok, false);
    assert.match(check.detail, kind === 'missing' ? /is not installed/ : /does not match its pin/);
    assert.equal(check.fix, 'node_modules/.bin/agentlane browser install');
  }
});

for (const driver of ['playwright', 'agent-browser'] as const) {
  test(`exec binds ${driver} to the lane's browser, and a failed command keeps the browser as it was in the evidence folder, which outlives release`, async t => {
    const w = world(t);
    const [one] = twoWorktrees(w, driver);
    const [a] = owners(t, 1);
    const deps = { ...w.deps({ owner: a?.pid ?? 0 }), cwd: one };
    const result = await up(deps, OPTIONS);
    assert.equal(result.doctor.ok, true, failures(result));
    const browser = withBrowser(result.lane).browser;
    const paths = browserPaths(w.state, result.lane.id, browser.session);
    const dump =
      'env | grep -E "^(PLAYWRIGHT_|PWTEST_|AGENT_BROWSER_|AGENTLANE_(BROWSER|STORAGE|EVIDENCE))" | sort > exec.env; command -v playwright-cli >> exec.env; command -v agent-browser >> exec.env; true';
    assert.equal(await runUpCommand('exec', ['--', 'sh', '-c', dump], deps, () => undefined), 0);
    const vars = Object.fromEntries(
      w
        .read('exec.env')
        .trim()
        .split('\n')
        .filter(l => l.includes('='))
        .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    assert.equal(vars.AGENTLANE_BROWSER_SESSION, browser.session);
    assert.equal(vars.AGENTLANE_BROWSER_DRIVER, driver);
    assert.equal(vars.AGENTLANE_BROWSER_CDP, `http://127.0.0.1:${String(browser.debugPort)}`);
    assert.equal(vars.AGENTLANE_STORAGE_STATE, paths.storageState);
    assert.equal(vars.AGENTLANE_EVIDENCE, paths.evidence);
    assert.equal(vars.PLAYWRIGHT_BROWSERS_PATH, w.browser.installed(driver).browsersPath);
    assert.equal(vars.PLAYWRIGHT_TEST_BASE_URL, result.url);
    if (driver === 'playwright') {
      assert.equal(vars.PLAYWRIGHT_CLI_SESSION, browser.session);
      assert.equal(vars.PLAYWRIGHT_MCP_USER_DATA_DIR, paths.profile);
      assert.equal(vars.PWTEST_DAEMON_SESSION_DIR, paths.playwrightSessions);
      assert.equal(vars.AGENT_BROWSER_SESSION, undefined);
    } else {
      assert.equal(vars.AGENT_BROWSER_SESSION, browser.session);
      assert.equal(vars.AGENT_BROWSER_PROFILE, paths.profile);
      assert.equal(vars.AGENT_BROWSER_ARGS, `--remote-debugging-port=${String(browser.debugPort)}`);
      assert.equal(vars.AGENT_BROWSER_SOCKET_DIR, paths.agentBrowserSockets);
      assert.match(vars.AGENT_BROWSER_EXECUTABLE_PATH ?? '', /chrome-headless-shell$/);
      assert.equal(vars.PLAYWRIGHT_CLI_SESSION, undefined);
    }
    const shim = driver === 'playwright' ? 'playwright-cli' : 'agent-browser';
    assert.ok(w.read('exec.env').includes(path.join(paths.bin, shim)), w.read('exec.env'));

    const logged: string[] = [];
    const code = await runUpCommand(
      'exec',
      ['--', 'sh', '-c', 'exit 3'],
      { ...deps, log: line => logged.push(line) },
      () => undefined,
    );
    assert.equal(code, 3);
    const [kept] = fs.readdirSync(paths.evidence).filter(name => name.endsWith('-failed'));
    assert.ok(kept, `no failure evidence in ${paths.evidence}: ${logged.join('\n')}`);
    const dir = path.join(paths.evidence, kept);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(
      files,
      driver === 'playwright'
        ? ['console.txt', 'page.txt', 'screenshot.png', 'trace']
        : ['console.txt', 'page.txt', 'screenshot.png'],
    );
    if (driver === 'playwright') assert.deepEqual(fs.readdirSync(path.join(dir, 'trace')), ['trace-1.trace']);
    assert.match(fs.readFileSync(path.join(dir, 'page.txt'), 'utf8'), /Signed in as/);
    assert.ok(
      logged.some(line => line.includes(dir)),
      logged.join('\n'),
    );
    if (driver === 'playwright')
      assert.equal(w.browser.sessions.get(browser.session)?.tracing, true, 'the failure trace did not start again');

    const out: string[] = [];
    assert.equal(await runRegistryCommand('release', ['--worktree', one], cliDeps(w, a?.pid ?? 0, one, out)), 0, out.join(''));
    assert.ok(fs.existsSync(path.join(dir, 'screenshot.png')), 'the evidence did not outlive the release');
  });
}

test('a signin hook that writes no saved login, or a malformed one, fails up at signin naming the problem and never printing the file', async t => {
  const w = world(t);
  const [one] = twoWorktrees(w, 'playwright');
  const [a] = owners(t, 1);
  const deps = { ...w.deps({ owner: a?.pid ?? 0 }), cwd: one };
  w.write(siteConfig('playwright', 'true'));
  await assert.rejects(up(deps, OPTIONS), /exited 0 without writing it/);
  const login = {
    cookies: [
      {
        name: 'sid',
        value: 's3cret-value',
        domain: 'example.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
  fs.writeFileSync(path.join(one, 'login.json'), JSON.stringify(login));
  w.write(siteConfig('playwright', 'cp login.json "$AGENTLANE_STORAGE_STATE"'));
  await assert.rejects(up(deps, OPTIONS), (error: unknown) => {
    const message = String(error instanceof Error ? error.message : error);
    assert.match(message, /example\.com/);
    assert.match(message, /localhost/);
    assert.equal(message.includes('s3cret-value'), false, message);
    return true;
  });
  assert.equal(
    w.lines.some(line => line.includes('s3cret-value')),
    false,
  );
});
