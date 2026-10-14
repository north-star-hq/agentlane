import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runUpCommand } from '../../src/up-cli.ts';
import { world, type World } from '../support/up-world.ts';

const SETUP = [
  /the setup skill/,
  /\/agentlane:setup in Claude Code/,
  /run 'node_modules\/\.bin\/agentlane skills get setup' at the project root and follow what it prints/,
];

const SITE_SERVER = `import { createServer } from 'node:http';
createServer((req, res) => res.end('ok')).listen(Number(process.env.AGENTLANE_SITE_PORT), '127.0.0.1');
`;

const WEB_ONLY = {
  web: { path: '/' },
  services: { site: { type: 'web', start: 'exec node site.mjs', ready: { kind: 'http', path: '/' }, timeoutSeconds: 10 } },
};

async function run(w: World, command: string, args: string[] = []): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const deps = { ...w.deps(), log: (line: string) => out.push(`${line}\n`) };
  const code = await runUpCommand(command, args, deps, text => out.push(text));
  return { code, text: out.join('') };
}

function namesSetup(text: string, what: string): void {
  for (const pattern of SETUP) assert.match(text, pattern, `${what}:\n${text}`);
}

test('up and doctor in a project with no agentlane.json name the setup skill and how to start it in each agent', async t => {
  const w = world(t);
  fs.rmSync(path.join(w.project, 'agentlane.json'));
  const up = await run(w, 'up');
  assert.equal(up.code, 2, up.text);
  assert.match(up.text, /no agentlane\.json in .* or the folders above it/);
  namesSetup(up.text, 'up');
  const doctor = await run(w, 'doctor');
  assert.equal(doctor.code, 1, doctor.text);
  assert.match(doctor.text, /FAIL {2}config: no agentlane\.json/);
  namesSetup(doctor.text, 'doctor');
});

test('up and doctor with a config that fails validation name the field and the setup skill', async t => {
  const w = world(t);
  w.write({ web: { path: 'no-slash' }, services: WEB_ONLY.services });
  const up = await run(w, 'up');
  assert.equal(up.code, 2, up.text);
  assert.match(up.text, /is not a valid agentlane\.json:\n {2}\/web\/path/);
  namesSetup(up.text, 'up');
  const doctor = await run(w, 'doctor');
  assert.equal(doctor.code, 1, doctor.text);
  assert.match(doctor.text, /FAIL {2}config: .* is not a valid agentlane\.json/);
  namesSetup(doctor.text, 'doctor');
});

test('up and doctor in a project no agent is wired to warn with the setup skill, and stay ready', async t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.project, 'site.mjs'), SITE_SERVER);
  w.write(WEB_ONLY);
  const up = await run(w, 'up');
  assert.equal(up.code, 0, up.text);
  assert.match(
    up.text,
    /warn {2}wiring: no agent's skills, MCP server or hooks are set up in this project\n {8}fix: run node_modules\/\.bin\/agentlane init --agents/,
  );
  namesSetup(up.text, 'up');
  const doctor = await run(w, 'doctor');
  assert.equal(doctor.code, 0, doctor.text);
  assert.match(doctor.text, /warn {2}wiring: no agent's/);
  namesSetup(doctor.text, 'doctor');
  assert.match(doctor.text, /\nready\n$/);

  fs.mkdirSync(path.join(w.project, '.claude'));
  fs.writeFileSync(
    path.join(w.project, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'agentlane@agentlane': true } }),
  );
  const withPlugin = await run(w, 'doctor');
  assert.equal(withPlugin.code, 0, withPlugin.text);
  assert.doesNotMatch(withPlugin.text, /no agent's|setup skill/, 'a project that enables the plugin is wired for Claude Code');
  assert.match(withPlugin.text, /wiring claude: /);
});
