import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProjectConfig } from '../../src/project/config.ts';
import { shellQuote } from '../../src/registry/format.ts';
import type { Lane } from '../../src/registry/types.ts';
import { runUpCommand } from '../../src/up-cli.ts';
import { laneDir } from '../../src/up/lane-files.ts';
import { driverVariables, maestroShim } from '../../src/up/maestro-env.ts';
import { up } from '../../src/up/up.ts';
import { tempDir } from '../support/fakes.ts';
import { CONFIG, OPTIONS, world } from '../support/up-world.ts';

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', status => {
      resolve({ status, stdout, stderr });
    });
  });
}

const lines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []);

function laneMaestro() {
  const dir = tempDir('lane-maestro');
  const log = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'fake-maestro');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf 'maestro %s\\n' "$*" >> ${shellQuote(log)}\n`, { mode: 0o755 });
  const shim = path.join(dir, 'maestro');
  fs.writeFileSync(
    shim,
    maestroShim({
      maestro: fake,
      device: 'emulator-5554',
      laneId: 'abcd1234',
      evidence: path.join(dir, 'evidence'),
      runs: path.join(dir, 'runs'),
    }),
    { mode: 0o755 },
  );
  return async (...args: string[]) => {
    fs.rmSync(log, { force: true });
    return { ...(await run(shim, args, process.env, dir)), calls: lines(log) };
  };
}

test("maestro test's output folder goes after the test subcommand, found past root options and their values", async () => {
  const maestro = laneMaestro();
  const ran = await maestro('-p', 'android', 'test', 'test.yaml');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(
    ran.calls[0] ?? '',
    /^maestro --udid emulator-5554 -p android test --debug-output \S+-maestro-test-\d+-failed test\.yaml$/,
  );
  assert.deepEqual(
    (await maestro('record', '--local', 'test', 'out.mp4')).calls,
    ['maestro --udid emulator-5554 record --local test out.mp4'],
    'a flow file named test is not the test subcommand',
  );
});

test('maestro mcp is refused, because it takes its device from each tool call', async () => {
  const maestro = laneMaestro();
  for (const args of [['mcp'], ['--udid', 'emulator-5554', 'mcp', '--no-viewer']]) {
    const ran = await maestro(...args);
    assert.equal(ran.status, 2);
    assert.deepEqual(ran.calls, [], 'Maestro did not run');
    assert.match(
      ran.stderr,
      /maestro mcp takes its device from each tool call, so it can't be held to lane abcd1234's device emulator-5554\. The lane's own MCP server is node_modules\/\.bin\/agentlane mcp/,
    );
  }
});

test("under exec, a lane whose config can't give it a Maestro gets a maestro that says why, and the maestro on PATH never runs", async t => {
  const w = world(t);
  const result = await up(w.deps(), OPTIONS);
  assert.equal(result.doctor.ok, true, w.lines.join('\n'));
  const other = path.join(w.root, 'other-bin');
  fs.mkdirSync(other);
  const marker = path.join(w.root, 'other-maestro-ran');
  fs.writeFileSync(path.join(other, 'maestro'), `#!/bin/sh\ntouch ${shellQuote(marker)}\n`, { mode: 0o755 });
  const deps = () => {
    const base = w.deps();
    return { ...base, env: { ...base.env, PATH: `${other}${path.delimiter}${base.env.PATH ?? ''}` } };
  };
  const file = path.join(w.project, 'agentlane.json');
  const cases: [string, string, RegExp][] = [
    ['no driver block', JSON.stringify(CONFIG), /has no driver block\nto fix: add "driver": \{\} to \S+agentlane\.json$/],
    [
      'an invalid config',
      JSON.stringify({ ...CONFIG, driver: { flows: 5 } }),
      /agentlane\.json is not a valid agentlane\.json:\n {2}\/driver\/flows must be a string, not an integer\n/,
    ],
    [
      'a config that is not JSON',
      '{ "app": ',
      /agentlane\.json is not a valid agentlane\.json:\n.*\(schema: \(JSON syntax\)\)$/s,
    ],
  ];
  for (const [name, text, reason] of cases) {
    fs.writeFileSync(file, text);
    const direct = await runUpCommand('exec', ['--', 'maestro', '--version'], deps(), () => undefined);
    assert.notEqual(direct, 0, name);
    const viaShell = await runUpCommand('exec', ['--', 'sh', '-c', 'maestro --version 2> maestro.err'], deps(), () => undefined);
    assert.notEqual(viaShell, 0, name);
    const said = w.read('maestro.err').trim();
    assert.match(said, new RegExp(`^agentlane: maestro is off in lane ${result.lane.id}, because `), name);
    assert.match(said, reason, name);
    assert.equal(fs.existsSync(marker), false, `${name}: the maestro on PATH ran`);
  }
  assert.ok(
    w.lines.some(line =>
      /^agentlane exec: only the lane's own variables are set, and maestro refuses to run, because \S+ is not a valid agentlane\.json:/.test(
        line,
      ),
    ),
    w.lines.join('\n'),
  );
});

test('a lane with no device, or an emulator that is not running, gets a maestro that says so', async t => {
  const w = world(t);
  const result = await up(w.deps(), OPTIONS);
  w.write({ ...CONFIG, driver: {} });
  const config = loadProjectConfig(path.join(w.project, 'agentlane.json'));
  const emulator = {
    platform: 'android' as const,
    id: 'agentlane-emu-0a0a0a',
    name: 'agentlane-emu-0a0a0a',
    deviceType: 'pixel_8',
    deviceTypeName: 'Pixel 8',
    runtime: 'system-images;android-36;google_apis;arm64-v8a',
    runtimeName: 'Android API 36',
    serial: null,
  };
  const cases: [Lane, RegExp][] = [
    [
      { ...result.lane, device: null },
      /because the lane holds no simulator or emulator\nto fix: node_modules\/\.bin\/agentlane release, then node_modules\/\.bin\/agentlane up$/,
    ],
    [
      { ...result.lane, device: emulator },
      /because its emulator agentlane-emu-0a0a0a isn't running \(adb has no serial for it\)\n/,
    ],
  ];
  for (const [lane, reason] of cases) {
    const vars = await driverVariables(w.deps(), config, lane, laneDir(w.state, lane.id));
    assert.equal(vars.JAVA_HOME, undefined);
    const ran = await run('maestro', ['test', 'flow.yaml'], { ...process.env, ...vars });
    assert.equal(ran.status, 2);
    assert.match(ran.stderr.trim(), reason);
    assert.equal(fs.existsSync(path.join(laneDir(w.state, lane.id), 'bin', 'adb')), false, 'no adb stub shadows adb');
  }
});
