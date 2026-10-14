import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runDriverCommand, type DriverCliDeps } from '../../src/driver-cli.ts';
import type { Ran } from '../../src/driver/exec.ts';
import { maestroRunsDir } from '../../src/driver/maestro-runs.ts';
import { enginePaths } from '../../src/driver/paths.ts';
import { escapeRegex } from '../../src/driver/selector.ts';
import type { EvidenceSystem } from '../../src/evidence/device.ts';
import { laneEvidence, keepRunFailure } from '../../src/evidence/evidence.ts';
import { createToolHandler } from '../../src/mcp/tools.ts';
import { systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { maestroShim } from '../../src/up/maestro-env.ts';
import { up } from '../../src/up/up.ts';
import { tempDir } from '../support/fakes.ts';
import { failures, OPTIONS, world, type World } from '../support/up-world.ts';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'signin-site');

/** xcrun and adb as device evidence runs them: recorders that write their file on SIGINT, and canned log output. */
class FakeRecorders implements EvidenceSystem {
  readonly runs: string[] = [];
  readonly started: { command: string; args: readonly string[]; pid: number }[] = [];
  private readonly running = new Map<number, { line: string; file: string }>();
  private next = 8_000_000;

  run(command: string, args: readonly string[]): Promise<Ran> {
    this.runs.push([path.basename(command), ...args].join(' '));
    const ok = (stdout: string): Ran => ({ code: 0, signal: null, stdout, stderr: '', error: undefined });
    if (args.includes('appinfo'))
      return Promise.resolve(ok('{\n    CFBundleExecutable = FakeApp;\n    CFBundleIdentifier = "com.example.fake";\n}\n'));
    if (args.includes('log')) return Promise.resolve(ok('2026-10-13 09:00:00.000 Df FakeApp[1:2] hello from the app\n'));
    return Promise.resolve(ok(''));
  }

  start(command: string, args: readonly string[], log: string): number {
    this.next += 1;
    this.started.push({ command, args, pid: this.next });
    fs.writeFileSync(log, 'Recording started\n');
    this.running.set(this.next, { line: [command, ...args].join(' '), file: args.at(-1) ?? '' });
    return this.next;
  }

  commandOf(pid: number): string | undefined {
    return this.running.get(pid)?.line;
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    const recording = this.running.get(pid);
    if (!recording) return;
    if (signal === 'SIGINT') fs.writeFileSync(recording.file, 'mp4');
    this.running.delete(pid);
  }
}

function driverDeps(w: World, over: Partial<DriverCliDeps> = {}): DriverCliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    env: w.deps().env,
    cwd: w.project,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    stdin: new PassThrough(),
    output: new PassThrough(),
    processes: systemProcesses,
    browser: w.browser,
    out,
    err,
    ...over,
  };
}

async function drive(deps: DriverCliDeps & { out: string[]; err: string[] }, command: string, ...args: string[]) {
  deps.out.length = 0;
  deps.err.length = 0;
  const code = await runDriverCommand(command, args, deps);
  return { code, out: deps.out.join(''), err: deps.err.join('') };
}

async function webLane(w: World) {
  for (const file of ['site.ts', 'signin.ts']) fs.copyFileSync(path.join(FIXTURE, file), path.join(w.project, file));
  w.write({
    web: { service: 'site' },
    services: { site: { type: 'web', start: 'exec node site.ts', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 10 } },
    hooks: { signin: 'node signin.ts' },
  });
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  return result;
}

test("look and screenshot read a browser lane through its driver, from the CLI and the MCP tools, and refuse a device's flags", async t => {
  const w = world(t);
  const result = await webLane(w);
  const deps = driverDeps(w);
  const looked = await drive(deps, 'look');
  assert.equal(looked.code, 0, looked.err);
  assert.match(
    looked.out,
    new RegExp(`^Page: "Home" at ${result.url ?? ''}\\n\\[heading\\] ref=e1 "Signed in as agent-${result.lane.id}" level=1\\n`),
  );
  const json = JSON.parse((await drive(deps, 'look', '--json', '--interactive')).out) as {
    ok: boolean;
    driver: string;
    url: string;
    interactive: number;
  };
  assert.deepEqual([json.ok, json.driver, json.url, json.interactive], [true, 'playwright', result.url, 0]);
  const bounds = await drive(deps, 'look', '--bounds');
  assert.equal(bounds.code, 2);
  assert.match(bounds.err, /--bounds reads a device screen; the lane's browser has no bounds or Maestro output/);
  const shot = await drive(deps, 'screenshot');
  assert.equal(shot.code, 0, shot.err);
  const file = /saved to (\S+)\n$/.exec(shot.out)?.[1] ?? '';
  assert.ok(file.endsWith('.png') && fs.existsSync(file), shot.out);
  assert.equal((await drive(deps, 'screenshot', '--crop', '0,0,10,10')).code, 2);
  const device = await drive(deps, 'look', '--device');
  assert.equal(device.code, 3);
  assert.match(device.err, /holds ports but no simulator/);

  const call = createToolHandler({ env: deps.env, cwd: w.project, processes: systemProcesses, browser: w.browser });
  const read = await call('look', {});
  assert.equal(read.isError, undefined);
  assert.match(read.content[0]?.type === 'text' ? read.content[0].text : '', /Signed in as/);
  const image = await call('screenshot', { browser: true });
  assert.equal(image.content[0]?.type === 'image' ? image.content[0].mimeType : '', 'image/png');
  const refused = await call('look', { bounds: true });
  assert.equal(refused.isError, true);
  const run = await call('run', { yaml: '- tapOn: x' });
  assert.equal(run.isError, true);
  assert.match(run.content[0]?.type === 'text' ? run.content[0].text : '', /holds ports but no simulator/);
});

test("evidence on a browser lane: screenshot, video, the driver's trace and the logs, each in the evidence folder", async t => {
  const w = world(t);
  const result = await webLane(w);
  const deps = driverDeps(w);
  const evidence = laneEvidence(w.state, result.lane.id);
  const shot = await drive(deps, 'evidence', 'screenshot');
  assert.equal(shot.code, 0, shot.err);
  assert.match(shot.out, new RegExp(`^Saved ${evidence}/\\d{8}T\\d{6}Z-screenshot-browser\\.png\\n$`));
  assert.equal((await drive(deps, 'evidence', 'video', 'start')).code, 0);
  assert.equal((await drive(deps, 'evidence', 'video', 'start')).code, 2, 'a second recording started');
  const video = await drive(deps, 'evidence', 'video', 'stop');
  assert.equal(video.code, 0, video.err);
  assert.match(video.out, /Kept the browser recording: .*-video-browser\.webm/);
  assert.equal((await drive(deps, 'evidence', 'trace', 'start')).code, 0);
  const trace = await drive(deps, 'evidence', 'trace', 'stop', '--json');
  const kept = JSON.parse(trace.out) as { ok: boolean; path: string; files: string[] };
  assert.equal(kept.ok, true, trace.err);
  assert.match(path.basename(kept.path), /-trace-browser$/);
  assert.equal(kept.files.length, 1);
  assert.equal(
    w.browser.sessions.get(result.lane.browser?.session ?? '')?.tracing,
    true,
    'the failure trace did not start again',
  );
  const logs = JSON.parse((await drive(deps, 'evidence', 'logs', '--json')).out) as { path: string; files: string[] };
  const names = logs.files.map(f => path.relative(logs.path, f)).sort();
  assert.ok(
    names.includes('browser-console.txt') && names.includes('services/site.log') && names.includes('hooks/signin.log'),
    names.join(', '),
  );
  const list = await drive(deps, 'evidence');
  assert.equal(list.code, 0);
  for (const name of ['-screenshot-browser.png', '-video-browser.webm', '-trace-browser', '-logs'])
    assert.ok(list.out.includes(name), list.out);
  assert.equal((await drive(deps, 'evidence', 'trace', 'start', '--device')).code, 3);
});

test('evidence on a device lane records the simulator until stopped or released, keeps its log narrowed to the app, and traces the driver', async t => {
  const w = world(t);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const udid = result.lane.device?.id ?? '';
  const recorders = new FakeRecorders();
  const deps = driverDeps(w, { evidence: recorders });
  const started = await drive(deps, 'evidence', 'video', 'start');
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(recorders.started[0]?.args.slice(0, 5), ['simctl', 'io', udid, 'recordVideo', '--codec=h264']);
  const stopped = await drive(deps, 'evidence', 'video', 'stop');
  assert.equal(stopped.code, 0, stopped.err);
  const file = /recording: (\S+)\n/.exec(stopped.out)?.[1] ?? '';
  assert.equal(fs.readFileSync(file, 'utf8'), 'mp4');

  const engine = enginePaths(w.state, result.lane.id);
  fs.mkdirSync(path.dirname(engine.log), { recursive: true });
  fs.writeFileSync(engine.log, 'before the trace\n');
  assert.equal((await drive(deps, 'evidence', 'trace', 'start')).code, 0);
  fs.appendFileSync(engine.log, 'tapOn General\n');
  const trace = JSON.parse((await drive(deps, 'evidence', 'trace', 'stop', '--json')).out) as { path: string; notes: string[] };
  assert.equal(fs.readFileSync(path.join(trace.path, 'driver.log'), 'utf8'), 'tapOn General\n');
  assert.match(fs.readFileSync(path.join(trace.path, 'device.log'), 'utf8'), /hello from the app/);
  assert.deepEqual(trace.notes, ["device.log holds the app's process FakeApp"]);
  assert.ok(
    recorders.runs.some(r => r.endsWith(`log show --style compact --last 1m --predicate process == "FakeApp"`)),
    recorders.runs.join('\n'),
  );

  const logs = JSON.parse((await drive(deps, 'evidence', 'logs', '--since', '5m', '--json')).out) as {
    path: string;
    files: string[];
  };
  assert.ok(
    logs.files.some(f => f.endsWith('device.log')) && logs.files.some(f => f.endsWith('services/metro.log')),
    logs.files.join(', '),
  );

  assert.equal((await drive(deps, 'evidence', 'video', 'start')).code, 0);
  const recording = recorders.started[1];
  const out: string[] = [];
  const cli = {
    env: deps.env,
    cwd: w.project,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: w.deps().devices,
    system: realServiceSystem,
    sim: w.sim,
    browser: w.browser,
    evidence: recorders,
  };
  assert.equal(await runRegistryCommand('release', [], cli), 0, out.join(''));
  assert.equal(recorders.commandOf(recording?.pid ?? 0), undefined, 'the release left the recording running');
  assert.match(out.join(''), /stopped the device recording into .*-video-device(-\d+)?\.mp4/);
  assert.ok(
    fs.existsSync(path.join(laneEvidence(w.state, result.lane.id), path.basename(file))),
    'the evidence folder went with the release',
  );
});

test('a failed device run keeps its flow, its failure, its screen and the driver log of the run', () => {
  const state = tempDir('run-failed');
  const log = enginePaths(state, 'abcd1234').log;
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'older\nthis run\n');
  const dir = keepRunFailure(state, 'abcd1234', {
    flow: '- tapOn: Go\n',
    failure: 'Run failed (selector-miss)',
    screenshot: Buffer.from('jpg'),
    driverLogFrom: 6,
  });
  assert.match(path.basename(dir), /^\d{8}T\d{6}Z-run-failed$/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['driver.log', 'failure.txt', 'flow.yaml', 'screenshot.jpg']);
  assert.equal(fs.readFileSync(path.join(dir, 'driver.log'), 'utf8'), 'this run\n');
});

const FAKE_MAESTRO_WRITES = `#!/bin/sh
out=''
prev=''
for a in "$@"; do
  if [ "$prev" = --debug-output ]; then out="$a"; fi
  prev="$a"
done
echo "$@"
if [ "$FAKE_WRITES" = 1 ]; then
  if [ -n "$out" ]; then run="$out/.maestro/tests/$FAKE_RUN"; else run="$XDG_STATE_HOME/maestro/tests/$FAKE_RUN"; fi
  mkdir -p "$run/flow/takeScreenshot"
  echo log > "$run/maestro.log"
  echo png > "$run/flow/takeScreenshot/home.png"
fi
exit "$FAKE_EXIT"
`;

test("the lane's maestro keeps what a test wrote in the evidence folder, passed or failed, linked where Maestro writes its runs", () => {
  const dir = tempDir('maestro-shim');
  const fake = path.join(dir, 'fake-maestro');
  fs.writeFileSync(fake, FAKE_MAESTRO_WRITES, { mode: 0o755 });
  const shim = path.join(dir, 'maestro');
  const evidence = path.join(dir, 'lanes', 'abcd1234', 'evidence');
  const xdg = path.join(dir, 'xdg');
  const runs = maestroRunsDir({ XDG_STATE_HOME: xdg });
  fs.writeFileSync(shim, maestroShim({ maestro: fake, device: 'UDID-1', laneId: 'abcd1234', evidence, runs }), { mode: 0o755 });
  const run = (outcome: { exit?: string; writes?: boolean; name?: string }, ...args: string[]) =>
    spawnSync(shim, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        XDG_STATE_HOME: xdg,
        FAKE_EXIT: outcome.exit ?? '0',
        FAKE_WRITES: outcome.writes === false ? '0' : '1',
        FAKE_RUN: outcome.name ?? 'r',
      },
    });
  const kept = () => (fs.existsSync(evidence) ? fs.readdirSync(evidence).sort() : []);
  const screenshot = (folder: string, name: string) =>
    path.join(evidence, folder, '.maestro', 'tests', name, 'flow', 'takeScreenshot', 'home.png');

  const passed = run({ name: '2026-10-13_120000' }, 'test', 'flow.yaml');
  assert.equal(passed.status, 0);
  assert.match(passed.stdout, /^--udid UDID-1 test --debug-output \S+-maestro-test-\d+-failed flow\.yaml$/m);
  const [pass] = kept();
  assert.match(pass ?? '', /^\d{8}T\d{6}Z-maestro-test-\d+$/, 'a passing run keeps its folder, named without -failed');
  assert.equal(fs.readFileSync(screenshot(pass ?? '', '2026-10-13_120000'), 'utf8'), 'png\n');
  const link = path.join(runs, '2026-10-13_120000');
  assert.equal(fs.readlinkSync(link), path.join(evidence, pass ?? '', '.maestro', 'tests', '2026-10-13_120000'));
  assert.match(
    passed.stderr,
    new RegExp(
      `maestro test passed; its output, takeScreenshot files included, is kept \\(after release too\\) in ${escapeRegex(path.join(evidence, pass ?? ''))}; linked where Maestro writes its runs: ${escapeRegex(link)}$`,
      'm',
    ),
  );
  const found = spawnSync(
    '/bin/sh',
    ['-c', 'for run in $(ls -dt "$1"/*/); do find "$run" -type f -name "*.png" -path "*takeScreenshot*"; done', '_', runs],
    { encoding: 'utf8' },
  );
  assert.equal(
    found.stdout.trim(),
    `${link}/flow/takeScreenshot/home.png`,
    "a reader of Maestro's runs folder finds the screenshot",
  );

  const failed = run({ exit: '1', name: '2026-10-13_120000' }, 'test', 'flow.yaml');
  assert.equal(failed.status, 1);
  const fail = kept().find(name => name.endsWith('-failed')) ?? '';
  assert.match(fail, /^\d{8}T\d{6}Z-maestro-test-\d+-failed$/);
  assert.equal(
    fs.readFileSync(path.join(evidence, fail, '.maestro', 'tests', '2026-10-13_120000', 'maestro.log'), 'utf8'),
    'log\n',
  );
  const second = fs.readdirSync(runs).find(name => name !== '2026-10-13_120000') ?? '';
  assert.match(
    second,
    /^2026-10-13_120000-\d+$/,
    "a run whose name Maestro's folder already holds is linked under the shim's pid",
  );
  assert.equal(fs.readlinkSync(path.join(runs, second)), path.join(evidence, fail, '.maestro', 'tests', '2026-10-13_120000'));
  assert.match(
    failed.stderr,
    /maestro test exited 1; its debug output is kept \(after release too\) in \S+-failed; linked where/,
  );

  const before = kept();
  const silent = run({ exit: '1', writes: false }, 'test', 'flow.yaml');
  assert.equal(silent.status, 1);
  assert.deepEqual(kept(), before, 'a run that wrote nothing leaves no folder');
  assert.match(silent.stderr, /maestro test exited 1 before it wrote any output/);

  assert.match(run({ writes: false }, 'hierarchy').stdout, /^--udid UDID-1 hierarchy$/m);
  const mine = path.join(dir, 'mine');
  assert.match(
    run({ name: 'own' }, 'test', '--debug-output', mine, 'f.yaml').stdout,
    new RegExp(`^--udid UDID-1 test --debug-output ${escapeRegex(mine)} f\\.yaml$`, 'm'),
  );
  assert.match(
    run({ writes: false }, 'test', '--test-output-dir=out', 'f.yaml').stdout,
    /^--udid UDID-1 test --test-output-dir=out f\.yaml$/m,
  );
  assert.deepEqual(kept(), before, "a caller's own output folder is left to Maestro");
  assert.equal(fs.existsSync(path.join(runs, 'own')), false);
  assert.equal(run({}, '--udid', 'OTHER', 'test').status, 2);
});
