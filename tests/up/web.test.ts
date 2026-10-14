import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { readRegistryStatus } from '../../src/registry/registry.ts';
import { UsageError } from '../../src/registry/refusal.ts';
import { runRegistryCommand } from '../../src/registry-cli.ts';
import { realServiceSystem } from '../../src/services/system.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import { up } from '../../src/up/up.ts';
import { alive, CONFIG, failures, OPTIONS, until, WEB, world, type World } from '../support/up-world.ts';

const SITE_SERVER = `import { createServer } from 'node:http';
createServer((req, res) => res.end(req.url === '/health' ? 'ok' : 'page ' + req.url))
  .listen(Number(process.env.AGENTLANE_SITE_PORT), '127.0.0.1');
`;

const LOGIN = JSON.stringify({
  cookies: [
    { name: 'sid', value: 'x', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
  ],
  origins: [],
});

const SITE = { type: 'web', start: 'exec node site.mjs', ready: { kind: 'http', path: '/health' }, timeoutSeconds: 10 };

const WEB_ONLY = {
  web: { path: '/admin' },
  services: { site: SITE },
  hooks: {
    setup: "env | grep -E '^AGENTLANE_(PLATFORM|WEB_URL|DEVICE)=' | sort > setup.env",
    teardown: 'echo "teardown $AGENTLANE_LANE" >> trace.log',
  },
  preconditions: [
    { name: 'a mobile-only check', run: 'false', fix: 'never runs for web', platforms: ['ios', 'android'] },
    { name: 'a web check', run: 'true', fix: 'none', platforms: ['web'] },
  ],
};

function setUp(w: World, config: unknown = WEB_ONLY): void {
  fs.writeFileSync(path.join(w.project, 'site.mjs'), SITE_SERVER);
  w.write(config);
}

test("up on a web-only project claims ports and no device, runs setup, starts its services, and ends on doctor with the web app's URL", async t => {
  const w = world(t);
  setUp(w);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, `${failures(result)}\n${w.lines.join('\n')}`);
  const url = `http://localhost:${String(WEB)}/admin`;
  assert.equal(result.platform, 'web');
  assert.equal(result.lane.device, null);
  assert.equal(result.build, null);
  assert.equal(result.url, url);
  assert.equal(await (await fetch(url)).text(), 'page /admin');
  assert.deepEqual(w.read('setup.env').trim().split('\n'), ['AGENTLANE_PLATFORM=web', `AGENTLANE_WEB_URL=${url}`]);
  assert.equal(result.env.AGENTLANE_WEB_URL, url);
  assert.deepEqual(w.sim.calls, [], 'a web up touched the simulator');
  assert.deepEqual(
    result.steps.map(s => s.step),
    ['preflight', 'claim', 'setup', 'build preconditions', 'service site', 'browser', 'doctor'],
  );
  const checks = result.doctor.checks.map(c => c.name);
  assert.ok(checks.includes('web app') && checks.includes('service site'), checks.join(', '));
  for (const mobileOnly of ['device', 'app installed', 'hygiene', 'Xcode', 'iOS simulators']) {
    assert.equal(checks.includes(mobileOnly), false, `doctor checked ${mobileOnly} for a web app`);
  }
  assert.equal(result.doctor.checks.find(c => c.name === 'web app')?.detail, url);

  const lines: string[] = [];
  const exports: string[] = [];
  const deps = { ...w.deps(), log: (line: string) => lines.push(line) };
  assert.equal(await runUpCommand('up', ['--platform', 'web'], deps, text => exports.push(text)), 0, lines.join('\n'));
  assert.ok(lines.includes(`agentlane up: the web app is at ${url}`), lines.join('\n'));
  assert.ok(exports.includes(`export AGENTLANE_WEB_URL=${url}\n`), exports.join(''));
  assert.equal(
    await runUpCommand(
      'exec',
      ['--', 'sh', '-c', 'echo "$AGENTLANE_PLATFORM $AGENTLANE_WEB_URL" > exec.out'],
      w.deps(),
      () => undefined,
    ),
    0,
  );
  assert.equal(w.read('exec.out').trim(), `web ${url}`);
  const doctor: string[] = [];
  assert.equal(await runUpCommand('doctor', [], w.deps(), text => doctor.push(text)), 0, doctor.join(''));

  const [site] = w.processes();
  const out: string[] = [];
  const cli = {
    env: w.deps().env,
    cwd: w.project,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => out.push(text),
    processes: systemProcesses,
    ports: tcpProbe,
    devices: w.deps().devices,
    system: realServiceSystem,
    browser: w.browser,
  };
  assert.equal(await runRegistryCommand('release', ['--worktree', w.project], cli), 0, out.join(''));
  await until(() => !alive(site?.pid ?? 0));
  assert.equal(w.read('trace.log').trim(), `teardown ${result.lane.id}`);
});

test('up for a platform the config declares no app for refuses before claiming, naming the platform it has', async t => {
  const w = world(t);
  setUp(w);
  await assert.rejects(
    up(w.deps(), { ...OPTIONS, platform: 'ios' }),
    (error: unknown) => error instanceof UsageError && /declares no mobile app[\s\S]*up --platform web/.test(error.message),
  );
  w.write(CONFIG);
  await assert.rejects(
    up(w.deps(), { ...OPTIONS, platform: 'web' }),
    (error: unknown) => error instanceof UsageError && error.message.includes('declares no web app'),
  );
  assert.deepEqual(readRegistryStatus({ dir: w.state, processes: systemProcesses }).lanes, []);
});

test('a project with both apps brings up the web app without a device, and the same lane takes a simulator for the mobile app', async t => {
  const w = world(t);
  setUp(w, {
    ...CONFIG,
    web: { service: 'site' },
    services: { ...CONFIG.services, site: SITE },
    hooks: {
      ...CONFIG.hooks,
      signin: `if [ "$AGENTLANE_PLATFORM" = web ]; then printf '%s' '${LOGIN}' > "$AGENTLANE_STORAGE_STATE"; else ${CONFIG.hooks.signin}; fi`,
    },
  });
  const web = await up(w.deps(), { ...OPTIONS, platform: 'web' });
  assert.equal(web.doctor.ok, true, failures(web));
  assert.equal(web.lane.device, null);
  assert.equal(fs.existsSync(path.join(w.project, 'build')), false, 'the web up ran the mobile build hook');
  const mobile = await up(w.deps(), OPTIONS);
  assert.equal(mobile.doctor.ok, true, failures(mobile));
  assert.equal(mobile.lane.id, web.lane.id);
  assert.equal(mobile.lane.device?.platform, 'ios');
  assert.equal(mobile.url, `http://localhost:${String(WEB)}/`);
});

test('a service the config marks for the mobile platforms is neither claimed, started, checked nor restartable for the web app, and the mobile up on the same lane starts it', async t => {
  const w = world(t);
  setUp(w, {
    ...CONFIG,
    web: { service: 'site' },
    services: { ...CONFIG.services, metro: { ...CONFIG.services.metro, platforms: ['ios', 'android'] }, site: SITE },
    hooks: {
      ...CONFIG.hooks,
      signin: `if [ "$AGENTLANE_PLATFORM" = web ]; then printf '%s' '${LOGIN}' > "$AGENTLANE_STORAGE_STATE"; else ${CONFIG.hooks.signin}; fi`,
    },
  });
  const web = await up(w.deps(), { ...OPTIONS, platform: 'web' });
  assert.equal(web.doctor.ok, true, failures(web));
  assert.equal(
    web.lane.ports.some(p => p.service === 'metro'),
    false,
    'the web up claimed a port for metro',
  );
  assert.deepEqual(
    w
      .processes()
      .map(p => p.service)
      .sort(),
    ['api', 'site'],
  );
  assert.equal(
    web.doctor.checks.some(c => c.name === 'service metro'),
    false,
  );
  const lines: string[] = [];
  const restart = await runUpCommand('restart', ['metro'], { ...w.deps(), log: line => lines.push(line) }, () => undefined);
  assert.equal(restart, 2, lines.join('\n'));
  assert.ok(
    lines.some(l => l.includes("'metro' runs only for ios, android, and lane")),
    lines.join('\n'),
  );

  const mobile = await up(w.deps(), OPTIONS);
  assert.equal(mobile.doctor.ok, true, failures(mobile));
  assert.equal(mobile.lane.id, web.lane.id);
  assert.deepEqual(
    w
      .processes()
      .map(p => p.service)
      .sort(),
    ['api', 'metro', 'site'],
  );
  assert.equal(await runUpCommand('restart', ['metro'], w.deps(), () => undefined), 0);
});
