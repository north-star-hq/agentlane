import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { BrowserDriverName } from '../../src/browser/kinds.ts';
import { browserPaths } from '../../src/browser/paths.ts';
import { lookAtBrowser } from '../../src/browser/screen.ts';
import { onProfile, realBrowserProcesses } from '../../src/browser/stop.ts';
import { realBrowserTools } from '../../src/browser/tools.ts';
import { systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import type { ClaimedBrowser, LaneInfo } from '../../src/registry/types.ts';
import { runRegistryCommand, type CliDeps } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import { up, type UpResult } from '../../src/up/up.ts';
import { failures, OPTIONS, sleeper, world, type World } from '../support/up-world.ts';

const LIVE = process.env.AGENTLANE_LIVE_BROWSER === '1';
const SKIP = { skip: !LIVE && 'set AGENTLANE_LIVE_BROWSER=1 to run the pinned browsers (agentlane browser install first)' };
const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'signin-site');

function git(cwd: string, ...args: string[]): void {
  const ran = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
}

function twoWorktrees(w: World, driver: BrowserDriverName): [string, string] {
  for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(FIXTURE, file), path.join(w.project, file));
  w.write({
    web: { service: 'site', browser: { driver } },
    services: { site: { type: 'web', start: 'exec node site.ts', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 20 } },
    hooks: { signin: 'node signin.ts' },
  });
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

function withBrowser(lane: LaneInfo): LaneInfo & { browser: ClaimedBrowser } {
  assert.ok(lane.browser);
  return lane as LaneInfo & { browser: ClaimedBrowser };
}

/** What the process table shows of a lane's browser: its Chrome, its driver daemon, and what listens on its ports. */
function leftOf(w: World, lane: LaneInfo & { browser: ClaimedBrowser }): string[] {
  const paths = browserPaths(w.state, lane.id, lane.browser.session);
  const table = realBrowserProcesses.list() ?? [];
  const left = table
    .filter(
      e =>
        onProfile(e.args, paths.profile) ||
        e.args.includes(`cliDaemon.js ${lane.browser.session}`) ||
        (e.args.includes('agent-browser') &&
          (realBrowserProcesses.environment(e.pid) ?? '').includes(`AGENT_BROWSER_SESSION=${lane.browser.session}`)),
    )
    .map(e => `pid ${String(e.pid)}: ${e.args.slice(0, 120)}`);
  for (const port of [lane.browser.debugPort, lane.browser.streamPort]) {
    if (port === null) continue;
    const lsof = spawnSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (lsof.stdout.trim() !== '') left.push(`port ${String(port)} listened on by ${lsof.stdout.trim()}`);
  }
  return left;
}

async function waitEmpty(w: World, lane: LaneInfo & { browser: ClaimedBrowser }): Promise<string[]> {
  const until = Date.now() + 10_000;
  let left = leftOf(w, lane);
  while (left.length > 0 && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 250));
    left = leftOf(w, lane);
  }
  return left;
}

function cli(w: World, owner: number, cwd: string, out: string[]): CliDeps {
  return {
    env: w.deps({ owner }).env,
    cwd,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: w.deps().devices,
    system: realServiceSystem,
    browser: realBrowserTools,
  };
}

async function signedIn(w: World, result: UpResult): Promise<string> {
  return (
    await lookAtBrowser({ tools: realBrowserTools, stateDir: w.state, lane: withBrowser(result.lane), env: w.deps().env }, {})
  ).text;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const driver of ['playwright', 'agent-browser'] as const) {
  test(
    `live ${driver}: two worktrees sign in at once in their own browsers; a failed run keeps its evidence; release and reap leave nothing running`,
    SKIP,
    async t => {
      const w = world(t);
      const [one, two] = twoWorktrees(w, driver);
      const [a, b, c] = owners(t, 3);
      const depsOne = { ...w.deps({ owner: a?.pid ?? 0, browser: realBrowserTools }), cwd: one };
      const depsTwo = { ...w.deps({ owner: b?.pid ?? 0, browser: realBrowserTools }), cwd: two };
      const third = fs.mkdtempSync(path.join(w.root, 'third-'));
      try {
        const [first, second] = (await Promise.allSettled([up(depsOne, OPTIONS), up(depsTwo, OPTIONS)])).map(settled => {
          if (settled.status === 'rejected') throw settled.reason;
          return settled.value;
        }) as [UpResult, UpResult];
        for (const result of [first, second]) assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
        const pageOne = await signedIn(w, first);
        const pageTwo = await signedIn(w, second);
        assert.match(pageOne, new RegExp(`"Signed in as agent-${first.lane.id}"`), pageOne);
        assert.match(pageOne, new RegExp(`Served from ${escaped(one)}`), pageOne);
        assert.match(pageTwo, new RegExp(`"Signed in as agent-${second.lane.id}"`), pageTwo);
        assert.match(pageTwo, new RegExp(`Served from ${escaped(two)}`), pageTwo);
        const laneOne = withBrowser(first.lane);
        const laneTwo = withBrowser(second.lane);
        assert.notEqual(laneOne.browser.debugPort, laneTwo.browser.debugPort);
        const profiles = [laneOne, laneTwo].map(cl => browserPaths(w.state, cl.id, cl.browser.session).profile);
        for (const [i, profile] of profiles.entries()) {
          const chrome = (realBrowserProcesses.list() ?? []).filter(e => onProfile(e.args, profile));
          assert.ok(chrome.length > 0, `no browser runs on ${profile}`);
          const port = [laneOne, laneTwo][i]?.browser.debugPort ?? 0;
          assert.ok(
            chrome.some(e => e.args.includes(`--remote-debugging-port=${String(port)}`)),
            chrome.map(e => e.args).join('\n'),
          );
          t.diagnostic(
            `lane ${[laneOne, laneTwo][i]?.id ?? ''}: ${chrome.map(e => `pid ${String(e.pid)}`).join(', ')} on ${profile}, port ${String(port)}`,
          );
        }

        const failing = driver === 'playwright' ? ['playwright-cli', 'click', 'e999'] : ['agent-browser', 'click', '@e999'];
        const logged: string[] = [];
        const code = await runUpCommand(
          'exec',
          ['--', ...failing],
          { ...depsOne, log: line => logged.push(line) },
          () => undefined,
        );
        assert.notEqual(code, 0);
        const evidence = browserPaths(w.state, laneOne.id, laneOne.browser.session).evidence;
        const [kept] = fs.readdirSync(evidence).filter(name => name.endsWith('-failed'));
        assert.ok(kept, logged.join('\n'));
        const keptDir = path.join(evidence, kept);
        const files = fs.readdirSync(keptDir).sort();
        t.diagnostic(`kept on failure: ${keptDir}: ${files.join(', ')}`);
        assert.ok(files.includes('screenshot.png') && files.includes('page.txt'), files.join(', '));
        if (driver === 'playwright') {
          const trace = fs.readdirSync(path.join(keptDir, 'trace')).sort();
          t.diagnostic(`trace: ${trace.join(', ')}`);
          assert.ok(trace.some(f => f.endsWith('.trace')) && trace.some(f => f.endsWith('.network')), trace.join(', '));
          const traceFile = trace.find(f => f.endsWith('.trace')) ?? '';
          const frames = [
            ...fs.readFileSync(path.join(keptDir, 'trace', traceFile), 'utf8').matchAll(/"file":"(screencast\/[^"]+)"/g),
          ].map(m => m[1] ?? '');
          assert.ok(frames.length > 0, 'the trace names no screencast frame');
          const missing = frames.filter(frame => !fs.existsSync(path.join(keptDir, 'trace', frame)));
          assert.deepEqual(missing, [], 'the kept trace lacks frames it names');
        }

        const out: string[] = [];
        assert.equal(await runRegistryCommand('release', ['--worktree', one], cli(w, a?.pid ?? 0, one, out)), 0, out.join(''));
        assert.deepEqual(await waitEmpty(w, laneOne), [], 'the release left part of the browser running');
        assert.ok(fs.existsSync(path.join(keptDir, 'screenshot.png')), 'the evidence went with the release');
        assert.match(await signedIn(w, second), /Signed in as/, "the release stopped the other worktree's browser");

        const reaped = new Promise(resolve => b?.once('exit', resolve));
        b?.kill('SIGKILL');
        await reaped;
        const claimed: string[] = [];
        assert.equal(
          await runRegistryCommand(
            'claim',
            ['--worktree', third, '--services', 'none', '--no-device'],
            cli(w, c?.pid ?? 0, third, claimed),
          ),
          0,
          claimed.join(''),
        );
        assert.deepEqual(await waitEmpty(w, laneTwo), [], `the reap left part of the browser running:\n${claimed.join('')}`);
        t.diagnostic(claimed.join('').trim());
      } finally {
        const out: string[] = [];
        for (const [owner, cwd] of [
          [a?.pid ?? 0, one],
          [b?.pid ?? 0, two],
          [c?.pid ?? 0, third],
        ] as const) {
          await runRegistryCommand('release', ['--worktree', cwd], cli(w, owner, cwd, out));
        }
      }
    },
  );
}

const PLAYWRIGHT_TEST = process.env.AGENTLANE_LIVE_PLAYWRIGHT_TEST;

test(
  "live: a project's own Playwright tests under exec reach the lane's server with its saved login, and a failure's trace lands in the evidence folder",
  {
    skip:
      SKIP.skip ||
      (PLAYWRIGHT_TEST === undefined &&
        'set AGENTLANE_LIVE_PLAYWRIGHT_TEST to a folder whose node_modules holds @playwright/test at the pinned Playwright version'),
  },
  async t => {
    const w = world(t);
    for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(FIXTURE, file), path.join(w.project, file));
    fs.cpSync(path.join(FIXTURE, 'playwright'), path.join(w.project, 'playwright'), { recursive: true });
    fs.symlinkSync(path.join(PLAYWRIGHT_TEST ?? '', 'node_modules'), path.join(w.project, 'node_modules'));
    w.write({
      web: { service: 'site' },
      services: {
        site: { type: 'web', start: 'exec node site.ts', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 20 },
      },
      hooks: { signin: 'node signin.ts' },
    });
    const [owner] = owners(t, 1);
    const deps = { ...w.deps({ owner: owner?.pid ?? 0, browser: realBrowserTools }), cwd: w.project };
    try {
      const result = await up(deps, OPTIONS);
      assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
      const lane = withBrowser(result.lane);
      const evidence = browserPaths(w.state, lane.id, lane.browser.session).evidence;
      const npx = ['--', 'npx', 'playwright', 'test', '-c', 'playwright'];
      const logged: string[] = [];
      const exec = (env: NodeJS.ProcessEnv) =>
        runUpCommand('exec', npx, { ...deps, env: { ...deps.env, ...env }, log: line => logged.push(line) }, () => undefined);
      assert.equal(await exec({}), 0, logged.join('\n'));
      assert.notEqual(await exec({ FIXTURE_FAIL: '1' }), 0, logged.join('\n'));
      const runs = fs.readdirSync(evidence).filter(name => name.endsWith('-playwright-test'));
      const traces = runs.flatMap(run =>
        fs
          .readdirSync(path.join(evidence, run), { recursive: true, encoding: 'utf8' })
          .filter(file => file.endsWith('trace.zip'))
          .map(file => path.join(run, file)),
      );
      t.diagnostic(`evidence: ${fs.readdirSync(evidence).join(', ')}; traces: ${traces.join(', ')}`);
      assert.equal(traces.length, 1, `one failing test, one trace: ${traces.join(', ')}`);
      assert.match(traces[0] ?? '', /a-failing-step-keeps-its-trace/);
      assert.ok(
        fs.readdirSync(evidence).some(name => /-npx-playwright-test.*-failed$/.test(name)),
        "the failed exec kept the lane's own browser too",
      );
      const out: string[] = [];
      assert.equal(await runRegistryCommand('release', [], cli(w, owner?.pid ?? 0, w.project, out)), 0, out.join(''));
      assert.ok(fs.existsSync(path.join(evidence, traces[0] ?? '')), 'the trace went with the release');
    } finally {
      await runRegistryCommand('release', [], cli(w, owner?.pid ?? 0, w.project, []));
    }
  },
);
