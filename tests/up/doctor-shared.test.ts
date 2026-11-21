import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { systemProcesses } from '../../src/processes.ts';
import { tcpProbe } from '../../src/registry/ports.ts';
import { Registry } from '../../src/registry/registry.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import type { DoctorCheck } from '../../src/up/doctor.ts';
import { up } from '../../src/up/up.ts';
import { failures, OPTIONS, world, type World } from '../support/up-world.ts';

const SITE_SERVER = `import { createServer } from 'node:http';
createServer((req, res) => res.end('ok')).listen(Number(process.env.AGENTLANE_SITE_PORT), '127.0.0.1');
`;

function setUp(w: World, db: Record<string, unknown> = {}): string {
  const flag = path.join(w.root, 'db-up');
  fs.writeFileSync(path.join(w.project, 'site.mjs'), SITE_SERVER);
  w.write({
    web: { path: '/' },
    services: {
      site: {
        type: 'web',
        start: 'exec node site.mjs',
        ready: { kind: 'http', path: '/' },
        timeoutSeconds: 10,
        needs: ['db'],
      },
    },
    shared: {
      db: {
        start: `touch '${flag}'`,
        stop: `rm -f '${flag}'`,
        ready: `test -f '${flag}' || { echo connecting to db; echo db is down >&2; exit 1; }`,
        timeoutSeconds: 5,
        ...db,
      },
    },
  });
  return flag;
}

async function doctor(w: World): Promise<{ code: number; checks: DoctorCheck[] }> {
  const out: string[] = [];
  const code = await runUpCommand('doctor', ['--json'], w.deps(), text => out.push(text));
  return { code, checks: (JSON.parse(out.join('')) as { checks: DoctorCheck[] }).checks };
}

function recordNeeds(w: World, lane: { id: string; token: string }, names: string[]): void {
  const registry = Registry.open({ dir: w.state, processes: systemProcesses, ports: tcpProbe, devices: {} });
  try {
    registry.recordNeeds(lane, names);
  } finally {
    registry.close();
  }
}

test('doctor runs the ready of each shared service the lane needs: it fails naming the fix while ready fails, and passes once it does; a lane that needs none shows no shared line', async t => {
  const w = world(t);
  const flag = setUp(w);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  const lane = { id: result.lane.id, token: result.lane.token };

  recordNeeds(w, lane, []);
  const none = await doctor(w);
  assert.equal(none.code, 0, JSON.stringify(none.checks));
  assert.deepEqual(
    none.checks.filter(c => c.name.startsWith('shared')),
    [],
  );

  recordNeeds(w, lane, ['db']);
  fs.rmSync(flag, { force: true });
  const down = await doctor(w);
  assert.equal(down.code, 1);
  assert.deepEqual(
    down.checks.filter(c => c.name.startsWith('shared')),
    [
      {
        name: 'shared db',
        ok: false,
        detail: `its ready exited 1 (test -f '${flag}' || { echo connecting to db; echo db is down >&2; exit 1; }): db is down`,
        fix: 'node_modules/.bin/agentlane up (it starts db)',
      },
    ],
  );

  fs.writeFileSync(flag, '');
  const running = await doctor(w);
  assert.equal(running.code, 0, JSON.stringify(running.checks));
  assert.deepEqual(
    running.checks.filter(c => c.name.startsWith('shared')),
    [
      {
        name: 'shared db',
        ok: true,
        detail: `running: its ready passes (test -f '${flag}' || { echo connecting to db; echo db is down >&2; exit 1; })`,
        fix: '',
      },
    ],
  );
});

test('doctor fails a shared service the lane needs that agentlane.json no longer declares', async t => {
  const w = world(t);
  setUp(w);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  recordNeeds(w, { id: result.lane.id, token: result.lane.token }, ['cache']);
  const { code, checks } = await doctor(w);
  assert.equal(code, 1);
  const check = checks.find(c => c.name === 'shared cache');
  assert.equal(check?.ok, false);
  assert.match(check.detail, /needs it, and .*agentlane\.json declares no shared service cache$/);
});

test("doctor stops a shared service's ready at its timeout and fails it", async t => {
  const w = world(t);
  const flag = setUp(w);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, failures(result));
  recordNeeds(w, { id: result.lane.id, token: result.lane.token }, ['db']);
  setUp(w, { ready: `test -f '${flag}' && sleep 30`, timeoutSeconds: 1 });
  fs.writeFileSync(flag, '');
  const started = Date.now();
  const { code, checks } = await doctor(w);
  assert.ok(Date.now() - started < 10_000, 'doctor did not wait for the whole ready');
  assert.equal(code, 1);
  const check = checks.find(c => c.name === 'shared db');
  assert.equal(check?.ok, false);
  assert.equal(check.detail, `its ready did not answer within 1 s (test -f '${flag}' && sleep 30): (no output)`);
});
