import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import type { EnvDeps } from '../../src/up/deps.ts';
import { Unmet } from '../../src/up/preflight.ts';
import { up } from '../../src/up/up.ts';
import { HOOK_LOCALE } from '../../src/hooks/env.ts';
import { escapeRegex } from '../../src/driver/selector.ts';
import { diagnose } from '../../src/up/doctor.ts';
import { loadProjectConfig } from '../../src/project/config.ts';
import {
  alive,
  ANDROID_TOOLCHAIN,
  API,
  BUNDLE,
  CONFIG,
  failures,
  listener,
  METRO,
  OPTIONS,
  sleeper,
  toolchain,
  until,
  world,
  type World,
} from '../support/up-world.ts';

test("up takes a bare worktree to a ready app: hooks in order with the lane's environment, services ours, the app launched to dial them", async t => {
  const w = world(t);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
  const udid = result.lane.device?.id ?? '';

  assert.deepEqual(w.read('trace.log').trim().split('\n'), [`setup ${udid}`, 'build']);
  const signin = w.read('signin.env');
  for (const line of [
    `AGENTLANE_DEVICE=${udid}`,
    `AGENTLANE_METRO_PORT=${String(METRO)}`,
    `AGENTLANE_API_PORT=${String(API)}`,
    `AGENTLANE_LANE=${result.lane.id}`,
    `AGENTLANE_WORKTREE=${w.project}`,
    'AGENTLANE_PLATFORM=ios',
    'AGENTLANE_VARIANT=Debug',
    `LANG=${HOOK_LOCALE}`,
    `LC_ALL=${HOOK_LOCALE}`,
  ])
    assert.ok(signin.split('\n').includes(line), `signin hook env lacks ${line}:\n${signin}`);

  const approval = w.sim.calls.findIndex(c => c.startsWith('writePlistString') && c.includes('fakeapp'));
  const boot = w.sim.calls.findIndex(c => c.startsWith('boot'));
  assert.ok(approval >= 0 && approval < boot, 'the scheme approval was not written before the first boot');
  const app = w.sim.get(udid).apps.get(BUNDLE);
  assert.deepEqual(app?.launchArgs, [
    '--initialUrl',
    `http://localhost:${String(METRO)}`,
    '-apiBaseUrl',
    `http://localhost:${String(API)}`,
  ]);

  const procs = w.processes();
  assert.deepEqual(
    procs.map(p => p.service),
    ['api', 'metro'],
  );
  for (const p of procs) {
    assert.equal(alive(p.pid), true);
    assert.equal(p.cwd, w.project);
  }
  const items = (await (await fetch(`http://127.0.0.1:${String(API)}/items`)).json()) as { port: number };
  assert.equal(items.port, API);
  assert.equal(result.build?.source, 'build');
  assert.equal('stored' in result.build && result.build.stored, true);
  assert.deepEqual(
    result.steps.map(s => s.step),
    [
      'preflight',
      'claim',
      'setup',
      'build preconditions',
      'boot',
      'build',
      'service metro',
      'service api',
      'hygiene',
      'launch',
      'signin',
      'doctor',
    ],
  );
});

test('a second up reuses the lane, the running services and the cached build', async t => {
  const w = world(t);
  const first = await up(w.deps(), OPTIONS);
  const pids = w.processes().map(p => p.pid);
  const second = await up(w.deps(), OPTIONS);
  assert.equal(second.doctor.ok, true, failures(second));
  assert.equal(second.lane.id, first.lane.id);
  assert.equal(second.created, false);
  assert.deepEqual(
    w.processes().map(p => p.pid),
    pids,
  );
  assert.equal(second.build?.source, 'cache');
  assert.equal(
    w
      .read('trace.log')
      .trim()
      .split('\n')
      .filter(l => l === 'build').length,
    1,
  );
  assert.ok(w.lines.some(l => l.includes('service metro: already running')));
});

test('a second up replaces a running service whose health check fails, and says which pid it replaced and why', async t => {
  const w = world(t);
  await up(w.deps(), OPTIONS);
  const oldApi = pidOf(w, 'api') ?? 0;
  const metro = pidOf(w, 'metro');
  fs.writeFileSync(path.join(w.project, 'sick.pid'), String(oldApi));
  await up(w.deps(), OPTIONS);
  const newApi = pidOf(w, 'api') ?? 0;
  assert.notEqual(newApi, oldApi);
  assert.equal(pidOf(w, 'metro'), metro);
  assert.match(
    w.lines.filter(l => l.includes('service api:')).at(-1) ?? '',
    new RegExp(
      `service api: started on ${String(API)} \\(pid ${String(newApi)}, .*\\), replacing pid ${String(oldApi)}, which failed its check \\(.*/health returned 503, not 200\\): stopped api \\(pid ${String(oldApi)}`,
    ),
    w.lines.join('\n'),
  );
});

test('release stops exactly the processes up started, runs teardown, and leaves a listener it did not start alone; status and release give their start times in UTC', async t => {
  const w = world(t);
  const result = await up(w.deps(), OPTIONS);
  const procs = w.processes();
  const stranger = await listener(METRO + 2);
  t.after(() => stranger.kill('SIGKILL'));
  const out: string[] = [];
  const deps = w.deps();
  const cli = {
    env: deps.env,
    cwd: w.project,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: deps.devices,
    sim: w.sim,
    system: realServiceSystem,
  };
  assert.equal(await runRegistryCommand('status', [], cli), 0);
  for (const p of procs)
    assert.match(out.join(''), new RegExp(`process +${p.service} pid ${String(p.pid)} \\(started ${p.start} UTC\\)`));
  out.length = 0;
  const code = await runRegistryCommand('release', ['--worktree', w.project], cli);
  assert.equal(code, 0, out.join(''));
  for (const p of procs) {
    await until(() => !alive(p.pid));
    assert.match(out.join(''), new RegExp(`stopped ${p.service} \\(pid ${String(p.pid)}, started ${p.start} UTC\\)`));
  }
  assert.equal(alive(stranger.pid ?? 0), true, 'release killed a listener the toolkit did not start');
  assert.match(w.read('trace.log'), new RegExp(`teardown ${result.lane.id}`));
  assert.deepEqual(readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes, []);
});

test("exec runs one command with the lane's variables", async t => {
  const w = world(t);
  const result = await up(w.deps(), OPTIONS);
  const code = await runUpCommand(
    'exec',
    ['--', 'sh', '-c', 'env | grep ^AGENTLANE_ | sort > exec.env'],
    w.deps(),
    () => undefined,
  );
  assert.equal(code, 0, w.lines.join('\n'));
  const env = w.read('exec.env');
  assert.ok(env.includes(`AGENTLANE_DEVICE=${result.lane.device?.id ?? ''}\n`), env);
  assert.ok(env.includes(`AGENTLANE_API_PORT=${String(API)}\n`), env);
  assert.equal(await runUpCommand('exec', ['--', 'sh', '-c', 'exit 5'], w.deps(), () => undefined), 5);
});

test('preconditions refuse before any build, naming the fix', async t => {
  const w = world(t);
  const claimed = () => readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes.length;

  w.write({
    ...CONFIG,
    preconditions: [{ name: 'the native project is committed', run: 'test -f committed.flag', fix: 'commit ios/ first' }],
  });
  await assert.rejects(
    up(w.deps(), OPTIONS),
    (error: unknown) =>
      error instanceof Unmet && /native project is committed[\s\S]*to fix: commit ios\/ first/.test(error.message),
  );
  assert.equal(claimed(), 0, 'a lane-stage refusal claimed something');

  w.write({ ...CONFIG, driver: { flows: '.maestro' } });
  await assert.rejects(
    up(w.deps({ toolchain: toolchain(false) }), OPTIONS),
    (error: unknown) => error instanceof Unmet && /Java 17[\s\S]*AGENTLANE_JAVA_HOME/.test(error.message),
  );
  assert.equal(claimed(), 0, 'a missing JDK was found only after claiming');

  w.write(CONFIG);
  await assert.rejects(
    up(w.deps(), { ...OPTIONS, setup: false }),
    (error: unknown) =>
      error instanceof Unmet && /node_modules is installed[\s\S]*to fix: run the setup hook/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(w.project, 'trace.log')), false, 'the build ran');
  assert.equal(w.sim.calls.filter(c => c.startsWith('boot')).length, 0, 'the simulator booted before a build-stage refusal');
  assert.equal(claimed(), 0, 'the refused run left its new lane behind');
  assert.ok(w.lines.some(l => l.includes('which this run made, so the refusal leaves nothing behind')));
});

test('the services of a lane whose owner died are stopped by the next claim that frees it', async t => {
  const w = world(t);
  const owner = sleeper();
  t.after(() => owner.kill('SIGKILL'));
  await up(w.deps({ owner: owner.pid ?? 0 }), OPTIONS);
  const procs = w.processes();
  assert.equal(procs.length, 2);
  const reaped = new Promise(resolve => owner.once('exit', resolve));
  owner.kill('SIGKILL');
  await reaped;

  const other = fs.mkdtempSync(path.join(w.root, 'other-'));
  const out: string[] = [];
  const deps = w.deps();
  const code = await runRegistryCommand('claim', ['--worktree', other, '--services', 'none', '--no-device'], {
    env: deps.env,
    cwd: other,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: deps.devices,
    system: realServiceSystem,
  });
  assert.equal(code, 0, out.join(''));
  assert.match(out.join(''), /freed lane [0-9a-f]{8} of process \d+ in /);
  for (const p of procs) await until(() => !alive(p.pid));
  assert.match(out.join(''), /stopped metro/);
});

test('a bundler-pin app is pinned to its own Metro and read back, keeps its dial across a relaunch without arguments, and release clears both', async t => {
  const w = world(t);
  w.write({ ...CONFIG, app: { ...CONFIG.app, launch: 'bundler-pin' } });
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const udid = result.lane.device?.id ?? '';
  const app = w.sim.get(udid).apps.get(BUNDLE);
  assert.equal(app?.defaults.get('RCT_jsLocation'), `localhost:${String(METRO)}`);
  assert.deepEqual(app.launchArgs, ['-apiBaseUrl', `http://localhost:${String(API)}`]);
  assert.equal(app.defaults.get('apiBaseUrl'), `http://localhost:${String(API)}`);
  assert.ok(result.doctor.checks.some(c => c.name === 'bundler pin' && c.ok));

  await w.sim.terminate(udid, BUNDLE);
  await w.sim.launch(udid, BUNDLE, []);
  const relaunched = await diagnose(w.deps(), {
    config: loadProjectConfig(path.join(w.project, 'agentlane.json')),
    configProblem: null,
    lane: result.lane,
    ownerState: 'alive',
    folder: w.project,
  });
  const dial = relaunched.checks.find(c => c.name === 'dials apiBaseUrl');
  assert.equal(dial?.ok, true, dial?.detail);
  assert.match(dial.detail, /relaunched without arguments, and its defaults hold apiBaseUrl/);
  app.defaults.set('apiBaseUrl', 'http://localhost:1');
  const stale = await diagnose(w.deps(), {
    config: loadProjectConfig(path.join(w.project, 'agentlane.json')),
    configProblem: null,
    lane: result.lane,
    ownerState: 'alive',
    folder: w.project,
  });
  assert.equal(stale.checks.find(c => c.name === 'dials apiBaseUrl')?.ok, false);
  app.defaults.set('apiBaseUrl', `http://localhost:${String(API)}`);

  const out: string[] = [];
  const deps = w.deps();
  const code = await runRegistryCommand('release', ['--worktree', w.project], {
    env: deps.env,
    cwd: w.project,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: deps.devices,
    sim: w.sim,
    system: realServiceSystem,
  });
  assert.equal(code, 0, out.join(''));
  assert.match(out.join(''), /cleared the bundler pin of com\.example\.fake/);
  assert.match(out.join(''), /cleared apiBaseUrl from the defaults of com\.example\.fake/);
  assert.equal(app.defaults.has('RCT_jsLocation'), false);
  assert.equal(app.defaults.has('apiBaseUrl'), false);
});

const FAKE_MAESTRO = `#!/bin/sh
printf '%s\\n' "$*" >> "$MAESTRO_LOG"
printf 'token=%s java=%s\\n' "$MAESTRO_RUNNER_TOKEN" "$JAVA_HOME" >> "$MAESTRO_LOG"
`;

test('with a driver block, the signin hook and exec run our Maestro on the claimed device with the lane token', async t => {
  const w = world(t);
  const fake = path.join(w.root, 'fake-maestro');
  fs.writeFileSync(fake, FAKE_MAESTRO, { mode: 0o755 });
  const log = path.join(w.root, 'maestro.log');
  w.write({
    ...CONFIG,
    hooks: { ...CONFIG.hooks, signin: 'maestro test .maestro/seed.yaml && command -v adb > adb.path' },
    driver: { flows: '.maestro' },
  });
  const env = { ...w.deps().env, AGENTLANE_MAESTRO: fake, MAESTRO_LOG: log };
  const result = await up(w.deps({ env }), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const udid = result.lane.device?.id ?? '';
  const bin = path.join(w.state, 'lanes', result.lane.id, 'bin');
  assert.equal(w.read('adb.path').trim(), path.join(bin, 'adb'));
  const evidence = path.join(w.state, 'lanes', result.lane.id, 'evidence');
  const kept = (cmd: string) =>
    new RegExp(`^--udid ${udid} test --debug-output ${escapeRegex(evidence)}/\\d{8}T\\d{6}Z-maestro-test-\\d+-failed ${cmd}$`);
  const [signin, token] = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.match(signin ?? '', kept('\\.maestro/seed\\.yaml'));
  assert.equal(token, `token=${result.lane.token} java=/jdk17`);
  assert.deepEqual(fs.readdirSync(evidence), [], 'a maestro test that wrote nothing leaves no folder');

  fs.rmSync(log);
  const code = await runUpCommand('exec', ['--', 'maestro', '--udid', udid, 'test', 'a.yaml'], w.deps({ env }), () => undefined);
  assert.equal(code, 0, w.lines.join('\n'));
  assert.match(fs.readFileSync(log, 'utf8').split('\n')[0] ?? '', kept('a\\.yaml'));

  const other = 'A0A0A0A0-0000-4000-8000-000000000000';
  const refused = spawnSync(path.join(bin, 'maestro'), ['test', '--device', other, 'a.yaml'], { encoding: 'utf8', env });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`drives lane ${result.lane.id}'s device ${udid}, not ${other}`));
});

test('a launch hook gets the dial arguments, and doctor names what the hook left undone', async t => {
  const w = world(t);
  w.write({
    ...CONFIG,
    app: { ...CONFIG.app, launch: 'hook' },
    hooks: { ...CONFIG.hooks, launch: 'printf "%s" "$AGENTLANE_LAUNCH_ARGS" > launch-args.txt' },
  });
  const result = await up(w.deps(), OPTIONS);
  assert.equal(w.read('launch-args.txt'), `-apiBaseUrl http://localhost:${String(API)}`);
  assert.equal(result.doctor.ok, false);
  const running = result.doctor.checks.find(c => c.name === 'app running');
  assert.equal(running?.ok, false);
  assert.equal(running.fix, 'node_modules/.bin/agentlane up');
});

const PLIST = (exe: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${exe}</string></dict></plist>\n`;

function fakeBundle(dir: string, variant: 'Debug' | 'Release'): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bundle-id'), BUNDLE);
  fs.writeFileSync(path.join(dir, 'Info.plist'), PLIST('Fake'));
  fs.writeFileSync(path.join(dir, 'Fake'), `executable ${variant}\n`);
  fs.writeFileSync(path.join(dir, variant === 'Debug' ? 'Fake.debug.dylib' : 'main.jsbundle'), '');
  return dir;
}

async function doctorChecks(
  w: World,
): Promise<{ code: number; checks: { name: string; ok: boolean; detail: string; fix: string }[] }> {
  const out: string[] = [];
  const code = await runUpCommand('doctor', ['--json'], w.deps(), text => out.push(text));
  return {
    code,
    checks: (JSON.parse(out.join('')) as { checks: { name: string; ok: boolean; detail: string; fix: string }[] }).checks,
  };
}

test('doctor names the installed variant, and fails with the fix once a hand-made Release build replaces the one up installed', async t => {
  const w = world(t);
  w.write({
    ...CONFIG,
    hooks: {
      ...CONFIG.hooks,
      build:
        "mkdir -p build/Fake.app && printf com.example.fake > build/Fake.app/bundle-id && printf '<plist><dict><key>CFBundleExecutable</key><string>Fake</string></dict></plist>' > build/Fake.app/Info.plist && echo debug > build/Fake.app/Fake && touch build/Fake.app/Fake.debug.dylib",
    },
  });
  const first = await up(w.deps(), OPTIONS);
  const variant = first.doctor.checks.find(c => c.name === 'app variant');
  assert.equal(variant?.ok, true, failures(first));
  assert.match(variant.detail, /^Debug: the build up installed \(Fake sha256 [0-9a-f]{12}\)$/);

  const udid = first.lane.device?.id ?? '';
  await w.sim.installApp(udid, fakeBundle(path.join(w.root, 'release', 'Fake.app'), 'Release'));
  const after = await doctorChecks(w);
  assert.notEqual(after.code, 0);
  const replaced = after.checks.find(c => c.name === 'app variant');
  assert.equal(replaced?.ok, false);
  assert.match(
    replaced.detail,
    /^not the Debug build up installed: Fake has sha256 \w{12}, not \w{12}, and it reads as Release \(it embeds main\.jsbundle and has no Fake\.debug\.dylib\)$/,
  );
  assert.equal(replaced.fix, 'node_modules/.bin/agentlane up installs the Debug build again');

  await up(w.deps(), OPTIONS);
  const again = await doctorChecks(w);
  assert.equal(again.checks.find(c => c.name === 'app variant')?.ok, true);
});

const ANDROID_CONFIG = {
  ...CONFIG,
  app: { ...CONFIG.app, android: { output: 'build/app.apk' } },
  hooks: {
    ...CONFIG.hooks,
    build:
      'if [ "$AGENTLANE_PLATFORM" = android ]; then mkdir -p build && printf com.example.fake > build/app.apk; else mkdir -p build/Fake.app && printf com.example.fake > build/Fake.app/bundle-id; fi; echo "build $AGENTLANE_PLATFORM $AGENTLANE_DEVICE" >> trace.log',
  },
};

test('on Android doctor names the variant from the DEBUGGABLE flag, and fails when a Debug config finds a release build', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const result = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  const variant = result.doctor.checks.find(c => c.name === 'app variant');
  assert.equal(variant?.ok, true, failures(result));
  assert.equal(variant.detail, `Debug: ${BUNDLE} is debuggable`);
  w.emulators.get(result.lane.device?.serial ?? '')?.notDebuggable.add(BUNDLE);
  const after = await doctorChecks(w);
  const release = after.checks.find(c => c.name === 'app variant');
  assert.equal(release?.ok, false);
  assert.equal(release.detail, `Release, not the Debug build up makes: ${BUNDLE} is not debuggable`);
});

test('up --platform android installs the APK on the claimed emulator, reverses the bundler and the dialed API to it, and opens the dev client with the dial as intent extras', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const result = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
  const device = result.lane.device;
  assert.equal(device?.platform, 'android');
  const serial = device.serial ?? '';
  assert.match(serial, /^emulator-\d+$/);
  const adb = w.emulators.get(serial);
  assert.ok(adb, `nothing ran adb against ${serial}; ran against ${[...w.emulators.keys()].join(', ')}`);
  assert.deepEqual([...w.emulators.keys()], [serial], 'adb ran against an emulator the lane does not hold');

  assert.deepEqual(w.read('trace.log').trim().split('\n'), [`setup ${serial}`, `build android ${serial}`]);
  assert.ok(w.read('signin.env').split('\n').includes('AGENTLANE_PLATFORM=android'));
  assert.deepEqual(
    [...adb.reverseRules],
    [
      [METRO, METRO],
      [API, API],
    ],
  );
  const link = `fakeapp://expo-development-client/?url=${encodeURIComponent(`http://localhost:${String(METRO)}`)}`;
  assert.deepEqual(adb.starts, [
    ['-a', 'android.intent.action.VIEW', '-d', link, '--es', 'apiBaseUrl', `http://localhost:${String(API)}`, BUNDLE],
  ]);
  assert.equal(adb.running.has(BUNDLE), true);
  assert.equal(adb.night, 'light');
  assert.equal(adb.globals.get('animator_duration_scale'), '0');
  assert.equal(w.sim.calls.length, 0, 'an Android up touched the iOS simulators');
  assert.deepEqual(
    result.steps.map(s => s.step),
    [
      'preflight',
      'claim',
      'setup',
      'build preconditions',
      'boot',
      'build',
      'service metro',
      'service api',
      'device network',
      'hygiene',
      'launch',
      'signin',
      'doctor',
    ],
  );
  const network = result.doctor.checks.find(c => c.name === 'device network');
  assert.equal(network?.ok, true);

  adb.reverseRules.delete(API);
  const again = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  assert.equal(again.build?.source, 'cache');
  assert.equal(adb.reverseRules.get(API), API, 'a second up did not put back the missing reverse rule');
  assert.equal(adb.calls.filter(c => c.startsWith('install ')).length, 2);

  const out: string[] = [];
  const deps = w.deps();
  const stranger = 47999;
  adb.reverseRules.set(stranger, stranger);
  const code = await runRegistryCommand('release', ['--worktree', w.project], {
    env: deps.env,
    cwd: w.project,
    stdout: text => out.push(text),
    stderr: text => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: deps.devices,
    sim: w.sim,
    ...(deps.adb ? { adb: deps.adb } : {}),
    system: realServiceSystem,
  });
  assert.equal(code, 0, out.join(''));
  assert.match(out.join(''), new RegExp(`removed adb reverse for emulator ports ${String(METRO)}, ${String(API)}`));
  assert.deepEqual([...adb.reverseRules], [[stranger, stranger]], 'release removed a reverse rule up did not add');
});

test('an Android build is served from the cache only while the JDK, Gradle and SDK stay the same', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const first = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  assert.equal(first.build?.source, 'build');
  const same = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  assert.equal(same.build?.source, 'cache');
  const newerJdk = ANDROID_TOOLCHAIN.replace('17.0.20', '17.0.21');
  const rebuilt = await up(w.deps({ toolchain: toolchain(true, newerJdk) }), { ...OPTIONS, platform: 'android' });
  assert.equal(rebuilt.build?.source, 'build');
  assert.equal(rebuilt.build.reason, 'miss');
});

test("the Android build hook runs with the JDK its cache key names: the one found when JAVA_HOME is unset, else the caller's", async t => {
  const cases = [
    { caller: {}, built: '/jdk17' },
    { caller: { JAVA_HOME: '/caller-jdk' }, built: '/caller-jdk' },
    { caller: { AGENTLANE_JAVA_HOME: '/pinned-jdk' }, built: '/pinned-jdk' },
    { caller: { AGENTLANE_JAVA_HOME: '/pinned-jdk', JAVA_HOME: '/caller-jdk' }, built: '/pinned-jdk' },
  ];
  for (const { caller, built } of cases) {
    const w = world(t);
    w.write({
      ...ANDROID_CONFIG,
      hooks: { ...ANDROID_CONFIG.hooks, build: `${ANDROID_CONFIG.hooks.build}; printf %s "$JAVA_HOME" > build/java-home` },
    });
    const keyed: string[] = [];
    const deps = w.deps();
    const result = await up(
      {
        ...deps,
        env: { ...deps.env, ...caller },
        toolchain: {
          ...toolchain(),
          androidToolchain: (_root, env) => {
            const named = env.AGENTLANE_JAVA_HOME ?? env.JAVA_HOME ?? '/jdk17';
            keyed.push(named);
            return Promise.resolve(`jdk at ${named}`);
          },
        },
      },
      { ...OPTIONS, platform: 'android' },
    );
    const label = JSON.stringify(caller);
    assert.equal(result.build?.source, 'build', label);
    assert.equal(w.read('build/java-home'), built, label);
    assert.deepEqual([...new Set(keyed)], [built], label);
  }
});

test('doctor on an Android lane names the reverse rule that went missing', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const result = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  const adb = w.emulators.get(result.lane.device?.serial ?? '');
  assert.ok(adb);
  adb.reverseRules.delete(API);
  const out: string[] = [];
  const code = await runUpCommand('doctor', [], w.deps(), text => out.push(text));
  assert.equal(code, 1, out.join(''));
  assert.match(out.join(''), new RegExp(`device network[\\s\\S]*lacks localhost:${String(API)}`));
});

test("doctor --platform checks that platform's config, and fails the lane check with up's fix when the lane holds the other platform's device", async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const doctor = async (args: string[]) => {
    const out: string[] = [];
    const code = await runUpCommand('doctor', ['--json', ...args], w.deps(), text => out.push(text));
    return {
      code,
      checks: (JSON.parse(out.join('')) as { checks: { name: string; ok: boolean; detail: string; fix: string }[] }).checks,
    };
  };
  const unclaimed = await doctor(['--platform', 'android']);
  assert.ok(
    unclaimed.checks.some(c => c.name === 'Android SDK'),
    JSON.stringify(unclaimed.checks),
  );
  assert.equal(
    (await doctor([])).checks.some(c => c.name === 'Android SDK'),
    false,
  );

  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.lane.device?.platform, 'ios');
  const ios = await doctor(['--platform', 'ios']);
  assert.equal(ios.code, 0, JSON.stringify(ios.checks));
  const android = await doctor(['--platform', 'android']);
  assert.equal(android.code, 1);
  const lane = android.checks.find(c => c.name === 'lane');
  assert.equal(lane?.ok, false);
  assert.match(lane.detail, new RegExp(`lane ${result.lane.id} holds .*, an iOS simulator, and doctor is checking android`));
  assert.equal(
    lane.fix,
    'node_modules/.bin/agentlane release here, then node_modules/.bin/agentlane up --platform android; or run node_modules/.bin/agentlane doctor --platform ios',
  );
  assert.equal(
    android.checks.some(c => c.name === 'device' || c.name.startsWith('service ')),
    false,
  );

  const out: string[] = [];
  assert.equal(await runUpCommand('doctor', ['--platform', 'windows'], w.deps(), text => out.push(text)), 2);
  assert.match(w.lines.join('\n'), /--platform windows is not a platform[\s\S]*one of ios, android, web/);
  const web = await doctor(['--platform', 'web']);
  assert.equal(web.code, 1);
  assert.match(web.checks.find(c => c.name === 'config')?.detail ?? '', /declares no web app/);
});

test('exec puts back the reverse rules an Android transport reset dropped, waiting for the emulator to come back', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const result = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  const adb = w.emulators.get(result.lane.device?.serial ?? '');
  assert.ok(adb);
  adb.reverseRules.clear();
  adb.booted = false;
  let polls = 0;
  const bootCompleted = adb.bootCompleted.bind(adb);
  adb.bootCompleted = () => {
    polls += 1;
    if (polls === 3) adb.booted = true;
    return bootCompleted();
  };
  const out: string[] = [];
  const code = await runUpCommand('exec', ['--', 'sh', '-c', 'exit 0'], w.deps(), text => out.push(text));
  assert.equal(code, 0, out.join(''));
  assert.deepEqual(
    [...adb.reverseRules],
    [
      [METRO, METRO],
      [API, API],
    ],
  );
  assert.equal(polls, 3);
  assert.match(w.lines.join('\n') + out.join(''), /put back adb reverse/);
});

test('exec still runs its command when the emulator stays offline, and says so', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const result = await up(w.deps(), { ...OPTIONS, platform: 'android' });
  const adb = w.emulators.get(result.lane.device?.serial ?? '');
  assert.ok(adb);
  adb.reverseRules.clear();
  adb.booted = false;
  const code = await runUpCommand('exec', ['--', 'sh', '-c', 'exit 4'], w.deps(), () => undefined);
  assert.equal(code, 4);
  assert.match(w.lines.join('\n'), /could not restore adb reverse .*did not come back online/);
});

function resetTransportDuringSignin(w: World, comesBackAfterPolls: number | null): EnvDeps {
  const deps = w.deps();
  return {
    ...deps,
    log: line => {
      deps.log(line);
      if (!line.startsWith('agentlane up: signin: ')) return;
      for (const adb of w.emulators.values()) {
        adb.reverseRules.clear();
        adb.booted = false;
        let polls = 0;
        adb.bootCompleted = () => {
          polls += 1;
          if (comesBackAfterPolls !== null && polls >= comesBackAfterPolls) adb.booted = true;
          return Promise.resolve(adb.booted);
        };
      }
    },
  };
}

test('up puts back the reverse rules an adb transport reset dropped during signin, says which, and reaches ready', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const result = await up(resetTransportDuringSignin(w, 3), { ...OPTIONS, platform: 'android' });
  assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
  const serial = result.lane.device?.serial ?? '';
  const adb = w.emulators.get(serial);
  assert.ok(adb);
  assert.deepEqual(
    [...adb.reverseRules],
    [
      [METRO, METRO],
      [API, API],
    ],
  );
  const restored = w.lines.filter(line => line.includes('put back adb reverse'));
  assert.deepEqual(restored, [
    `agentlane up: put back adb reverse localhost:${String(METRO)}, localhost:${String(API)} on ${serial} after signin, which an adb transport reset had dropped`,
  ]);
  assert.equal(adb.starts.length, 1, 'up relaunched an app that had already signed in');
});

test('a transport reset while the app loads its bundle gets the rules back and one relaunch, so ready means the app loaded', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const deps = w.deps();
  const result = await up(
    {
      ...deps,
      log: line => {
        deps.log(line);
        if (!line.startsWith('agentlane up: hygiene: ')) return;
        for (const adb of w.emulators.values()) {
          const start = adb.start.bind(adb);
          adb.start = async args => {
            await start(args);
            if (adb.starts.length === 1) adb.reverseRules.clear();
          };
        }
      },
    },
    { ...OPTIONS, platform: 'android' },
  );
  assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
  const serial = result.lane.device?.serial ?? '';
  const adb = w.emulators.get(serial);
  assert.ok(adb);
  assert.equal(adb.starts.length, 2);
  assert.deepEqual(result.steps.map(s => s.step).slice(-4), ['launch', 'relaunch', 'signin', 'doctor']);
  assert.deepEqual(
    w.lines.filter(line => line.includes('put back adb reverse')),
    [
      `agentlane up: put back adb reverse localhost:${String(METRO)}, localhost:${String(API)} on ${serial} after launch, which an adb transport reset had dropped`,
    ],
  );
});

test('up fails naming the transport reset, not a missing rule, when the emulator stays offline after signin', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  const out: string[] = [];
  const code = await runUpCommand('up', ['--platform', 'android'], resetTransportDuringSignin(w, null), text => out.push(text));
  const said = `${out.join('')}\n${w.lines.join('\n')}`;
  assert.equal(code, 1, said);
  assert.match(said, /the adb transport to emulator-\d+ reset after signin, and the emulator did not come back online/);
  assert.doesNotMatch(said, /lacks/);
});

test('up for one platform refuses a folder whose lane holds the other platform, naming both ways out', async t => {
  const w = world(t);
  w.write(ANDROID_CONFIG);
  await up(w.deps(), OPTIONS);
  await assert.rejects(
    up(w.deps(), { ...OPTIONS, platform: 'android' }),
    (error: unknown) =>
      error instanceof Error &&
      /holds .*an iOS simulator, and up is running for android/.test(error.message) &&
      ((error as Error & { fix?: string }).fix ?? '').includes(
        'release here, then node_modules/.bin/agentlane up --platform android; or run node_modules/.bin/agentlane up --platform ios',
      ),
  );
});

test('with a driver configured, up starts the driver after the app launches, so the first look is warm', async t => {
  const w = world(t);
  const plain = await up(w.deps(), OPTIONS);
  assert.deepEqual(w.driverStarts, [], 'no driver block, no driver');
  assert.equal(
    plain.steps.some(s => s.step === 'driver'),
    false,
  );

  w.write({ ...CONFIG, driver: { flows: '.maestro' } });
  const result = await up(w.deps({ env: { ...w.deps().env, AGENTLANE_MAESTRO: '/fake/maestro' } }), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  assert.deepEqual(w.driverStarts, [{ lane: result.lane.id, stateDir: w.state, afterLaunch: true }]);
  const steps = result.steps.map(s => s.step);
  assert.ok(
    steps.indexOf('driver') > steps.indexOf('launch') && steps.indexOf('driver') < steps.indexOf('doctor'),
    steps.join(', '),
  );
  assert.ok(w.lines.some(l => l.includes('up: driver: started; the first look is warm')));
});

test('a driver that fails to start leaves up ready, and says the first look will start it', async t => {
  const w = world(t);
  w.write({ ...CONFIG, driver: { flows: '.maestro' } });
  const result = await up(
    w.deps({
      env: { ...w.deps().env, AGENTLANE_MAESTRO: '/fake/maestro' },
      startDriver: () => Promise.reject(new Error('Maestro download failed\nto fix: install gh')),
    }),
    OPTIONS,
  );
  assert.equal(result.doctor.ok, true, failures(result));
  assert.ok(
    w.lines.some(l => l.includes('up: driver: not started (Maestro download failed); the first look starts it')),
    w.lines.join('\n'),
  );
});

async function items(): Promise<{ port: number; flag: string | null }> {
  return (await (await fetch(`http://127.0.0.1:${String(API)}/items`)).json()) as { port: number; flag: string | null };
}

function pidOf(w: World, service: string): number | undefined {
  return w.processes().find(p => p.service === service)?.pid;
}

function withEnv(deps: EnvDeps, extra: Record<string, string>): EnvDeps {
  return { ...deps, env: { ...deps.env, ...extra } };
}

test("restart gives one service a new process on the same port with this call's environment, and leaves the lane, the app and the other services alone", async t => {
  const w = world(t);
  const first = await up(withEnv(w.deps(), { FLAG: 'from-up' }), OPTIONS);
  assert.equal(first.doctor.ok, true, failures(first));
  assert.equal((await items()).flag, 'from-up');
  const metro = pidOf(w, 'metro');
  const oldApi = pidOf(w, 'api') ?? 0;
  const simCalls = w.sim.calls.length;

  const out: string[] = [];
  const code = await runUpCommand('restart', ['api'], withEnv(w.deps(), { FLAG: 'from-restart' }), text => out.push(text));
  assert.equal(code, 0, w.lines.join('\n'));
  assert.deepEqual(out, []);
  const newApi = pidOf(w, 'api') ?? 0;
  assert.notEqual(newApi, oldApi);
  await until(() => !alive(oldApi));
  assert.equal(alive(newApi), true);
  assert.deepEqual(await items(), { port: API, flag: 'from-restart' });
  assert.equal(pidOf(w, 'metro'), metro);
  assert.deepEqual(w.sim.calls.slice(simCalls), [], 'restart touched the simulator or the app');
  assert.ok(
    w.lines.some(l =>
      new RegExp(`restart: api: stopped api \\(pid ${String(oldApi)}, .*started on ${String(API)} \\(pid ${String(newApi)}`).test(
        l,
      ),
    ),
    w.lines.join('\n'),
  );
  const [lane, ...others] = readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes;
  assert.equal(others.length, 0);
  assert.equal(lane?.id, first.lane.id);
  assert.deepEqual(lane.ports, first.lane.ports);
  assert.equal(lane.lastAction, 'restart: api');
  const log = fs.readFileSync(path.join(w.state, 'lanes', first.lane.id, 'api.log'), 'utf8');
  assert.match(log.slice(log.lastIndexOf('--- ')), /GET \/items/);
  assert.equal(await runUpCommand('doctor', [], w.deps(), () => undefined), 0);

  assert.equal(await runUpCommand('restart', ['api'], w.deps(), () => undefined), 0);
  assert.equal((await items()).flag, null, 'a variable passed to up but not to restart outlived the restart');
});

test('restarting the bundler of a bundler-pin app keeps the pin valid', async t => {
  const w = world(t);
  w.write({ ...CONFIG, app: { ...CONFIG.app, launch: 'bundler-pin' } });
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const metro = pidOf(w, 'metro');
  assert.equal(await runUpCommand('restart', ['metro'], w.deps(), () => undefined), 0, w.lines.join('\n'));
  assert.notEqual(pidOf(w, 'metro'), metro);
  const out: string[] = [];
  assert.equal(await runUpCommand('doctor', [], w.deps(), text => out.push(text)), 0, out.join(''));
  assert.match(out.join(''), /bundler pin/);
});

test('restart refuses, naming the fix, without a lane, for an unknown service, and for a service up never started', async t => {
  const w = world(t);
  const lines = () => w.lines.splice(0).join('\n');
  assert.equal(await runUpCommand('restart', ['api'], w.deps(), () => undefined), 3);
  assert.match(lines(), /holds no lane in .*\nto recover: node_modules\/\.bin\/agentlane up/);

  w.write({ ...CONFIG, services: { ...CONFIG.services, api: { ...CONFIG.services.api, start: 'exit 1' } } });
  await assert.rejects(up(w.deps(), OPTIONS), /service api exited/);
  w.lines.splice(0);
  assert.equal(await runUpCommand('restart', ['web'], w.deps(), () => undefined), 2);
  assert.match(
    lines(),
    /'web' is not a service in .*agentlane\.json\nto fix: node_modules\/\.bin\/agentlane restart metro \| api/,
  );
  assert.equal(await runUpCommand('restart', [], w.deps(), () => undefined), 2);
  assert.match(lines(), /restart needs the name of a service/);
  const metro = pidOf(w, 'metro');
  assert.equal(await runUpCommand('restart', ['metro', 'api'], w.deps(), () => undefined), 1);
  assert.match(
    lines(),
    /service api is not running under lane [0-9a-f]{8}: up never started it[\s\S]*to fix: node_modules\/\.bin\/agentlane up/,
  );
  assert.equal(pidOf(w, 'metro'), metro, 'a refused restart stopped a service before checking the others');
});

test('restart fails loudly when the port cannot be rebound, and the lane keeps the port for the next start', async t => {
  const w = world(t);
  const first = await up(w.deps(), OPTIONS);
  const metro = pidOf(w, 'metro');
  const stranger = sleeper();
  t.after(() => stranger.kill('SIGKILL'));
  let stopped = false;
  const system = {
    ...realServiceSystem,
    signalGroup: (pgid: number, signal: NodeJS.Signals) => {
      stopped = true;
      return realServiceSystem.signalGroup(pgid, signal);
    },
    listeners: (port: number) => (stopped && port === API ? [stranger.pid ?? 0] : realServiceSystem.listeners(port)),
  };
  assert.equal(await runUpCommand('restart', ['api'], w.deps({ system }), () => undefined), 1);
  const said = w.lines.join('\n');
  assert.match(said, new RegExp(`${String(API)} is held by a process the toolkit did not start: pid ${String(stranger.pid)}`));
  assert.match(said, new RegExp(`keeps port ${String(API)}.*run node_modules/.bin/agentlane restart api again`));
  const lane = readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes[0];
  assert.deepEqual(lane?.ports, first.lane.ports);
  assert.equal(pidOf(w, 'api'), undefined);
  assert.equal(pidOf(w, 'metro'), metro);

  const again = await up(w.deps(), OPTIONS);
  assert.equal(again.lane.id, first.lane.id);
  assert.equal((await items()).port, API);
});
