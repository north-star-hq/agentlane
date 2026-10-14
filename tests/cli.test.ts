import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_COMMANDS } from '../src/agents/cli.ts';
import { BENCH_COMMANDS } from '../src/bench-cli.ts';
import { DRIVER_COMMANDS } from '../src/driver-cli.ts';
import { HOOK_COMMANDS } from '../src/plugin/hook-cli.ts';
import { REGISTRY_COMMANDS } from '../src/registry-cli.ts';
import { UP_COMMANDS } from '../src/up-cli.ts';
import { tempDir } from './support/fakes.ts';
import { portBlock } from './support/ports.ts';

const PORTS = await portBlock();

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };

function cli(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...(cwd ? { cwd } : {}),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AGENTLANE_STATE_DIR: path.join(tempDir('cli-default'), 'state'),
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

function registryEnv() {
  const stateDir = path.join(tempDir('cli'), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ ports: { metro: [PORTS, PORTS + 3], api: [PORTS + 10, PORTS + 13], web: [PORTS + 20, PORTS + 23] } }),
  );
  return { AGENTLANE_STATE_DIR: stateDir };
}

test('--version prints the package version and exits 0', () => {
  const result = cli(['--version']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${manifest.version}\n`);
});

test('--help prints usage, including the lanes commands, and exits 0', () => {
  const result = cli(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Usage: agentlane <command>$/m);
  for (const command of ['claim', 'release', 'status', 'lanes', 'touch', 'prune'])
    assert.match(result.stdout, new RegExp(`^  ${command} `, 'm'));
});

test('no command prints usage to stderr and exits 2', () => {
  const result = cli([]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage: agentlane <command>$/m);
});

test('an unknown command says it is not built yet and exits 2', () => {
  const result = cli(['frobnicate']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "agentlane: 'frobnicate' isn't built yet.\n");
});

test('--help lists the environment commands', () => {
  const result = cli(['--help']);
  for (const command of ['up', 'exec', 'doctor', 'schema']) assert.match(result.stdout, new RegExp(`^  ${command} `, 'm'));
});

function listedCommands(): string[] {
  const help = cli(['--help']).stdout;
  return [...new Set([...help.matchAll(/^ {2}([a-z][a-z-]*) /gm)].map(m => m[1] ?? ''))];
}

test('the top-level help lists exactly the commands the CLI dispatches', () => {
  const dispatched = [
    ...REGISTRY_COMMANDS,
    ...UP_COMMANDS,
    ...DRIVER_COMMANDS,
    ...HOOK_COMMANDS,
    ...AGENT_COMMANDS,
    ...BENCH_COMMANDS,
  ];
  assert.deepEqual(listedCommands().sort(), [...dispatched].sort());
});

test("<command> --help prints that command's own usage and exits 0, for every command in the top-level help", () => {
  const commands = listedCommands();
  assert.ok(commands.length >= 19, commands.join(' '));
  for (const command of commands) {
    for (const flag of ['--help', '-h']) {
      const result = cli([command, flag]);
      assert.equal(result.code, 0, `${command} ${flag}: ${result.stderr}`);
      assert.ok(
        result.stdout.startsWith(`Usage: agentlane ${command}\n\n  ${command} `),
        `${command} ${flag}:\n${result.stdout}`,
      );
      assert.doesNotMatch(result.stdout, /^Usage: agentlane <command>$/m, `${command} ${flag} printed the whole help`);
      assert.equal(result.stderr, '');
    }
  }
});

test("--help after other options still prints the command's usage", () => {
  const result = cli(['up', '--platform', 'android', '--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Usage: agentlane up\n/);
});

test("an unknown option still exits 2 with that command's usage, for every command but exec", () => {
  for (const command of listedCommands().filter(c => c !== 'exec')) {
    const result = cli([command, '--no-such-option']);
    assert.equal(result.code, 2, `${command}: ${result.stderr}`);
    assert.equal(result.stdout, '', command);
  }
  const up = cli(['up', '--no-such-option']);
  assert.match(up.stderr, /Unknown option '--no-such-option'/);
  assert.match(up.stderr, /^ {2}up {9}Take this worktree/m);
  assert.doesNotMatch(up.stderr, /^ {2}schema /m);
});

test('exec hands --help after its command to that command, not to exec', () => {
  const result = cli(['exec', 'ls', '--help']);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /holds no lane/);
});

test('schema prints the JSON Schema the package ships', () => {
  const result = cli(['schema']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, fs.readFileSync(path.join(ROOT, 'schema', 'agentlane.schema.json'), 'utf8'));
});

test('up with an invalid config exits 2 naming the field and the schema rule, before claiming anything', () => {
  const dir = tempDir('cli-bad-config');
  fs.writeFileSync(
    path.join(dir, 'agentlane.json'),
    JSON.stringify({
      app: { platform: 'ios', bundleId: 'com.example.app', launch: 'dev-client' },
      services: { metro: { type: 'metro', start: 'x', ready: { kind: 'http', path: 'status' } } },
    }),
  );
  const env = registryEnv();
  const result = cli(['up'], { ...env, AGENTLANE_OWNER_PID: String(process.pid) }, dir);
  assert.equal(result.code, 2, result.stderr);
  assert.match(
    result.stderr,
    /is not a valid agentlane\.json:\n {2}\/services\/metro\/ready\/path "status" must match \^\/\n {4}\(schema: #\/\$defs\/httpReady\/properties\/path\/pattern\)/,
  );
  assert.equal(fs.existsSync(path.join(env.AGENTLANE_STATE_DIR, 'registry.sqlite')), false);
});

test('up with no config anywhere above exits 2 and says how to get the schema', () => {
  const dir = tempDir('cli-no-config');
  const result = cli(['up'], { AGENTLANE_OWNER_PID: String(process.pid) }, dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no agentlane\.json in .* or the folders above it[\s\S]*node_modules\/\.bin\/agentlane schema/);
});

test('exec without a lane refuses with exit 3 and names the command that claims', () => {
  const dir = tempDir('cli-exec');
  const result = cli(['exec', '--', 'env'], { ...registryEnv(), AGENTLANE_OWNER_PID: String(process.pid) }, dir);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /holds no lane in .*\nto recover: node_modules\/\.bin\/agentlane up/);
});

test('status works on a Mac with no registry yet and creates nothing', () => {
  const env = { AGENTLANE_STATE_DIR: path.join(tempDir('cli-empty'), 'state') };
  const result = cli(['status'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^no lanes$/m);
  assert.equal(fs.existsSync(env.AGENTLANE_STATE_DIR), false);
  const json = cli(['lanes', '--json'], env);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual((JSON.parse(json.stdout) as { lanes: unknown[] }).lanes, []);
});

test('claim prints shell exports, lanes --json lists it without its token, and release frees it', () => {
  const owner = sleeper();
  try {
    const env = { ...registryEnv(), AGENTLANE_OWNER_PID: String(owner.pid) };
    const folder = tempDir('cli-folder');
    const claimed = cli(['claim', '--no-device', '--worktree', folder], env);
    assert.equal(claimed.code, 0, claimed.stderr);
    const exports: Record<string, string | undefined> = Object.fromEntries(
      [...claimed.stdout.matchAll(/^export (\w+)=(.*)$/gm)].map(m => [m[1] ?? '', m[2] ?? '']),
    );
    assert.equal(exports.AGENTLANE_METRO_PORT, String(PORTS));
    assert.equal(exports.AGENTLANE_API_PORT, String(PORTS + 10));
    assert.equal(exports.AGENTLANE_WEB_PORT, String(PORTS + 20));
    assert.equal(exports.AGENTLANE_WORKTREE, fs.realpathSync(folder));
    const token = exports.AGENTLANE_LANE_TOKEN ?? '';
    assert.ok(token.length > 20);

    const listed = cli(['lanes', '--json'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout.includes(token), false);
    const report = JSON.parse(listed.stdout) as { lanes: { id: string; ownerState: string; worktree: string }[] };
    assert.deepEqual(
      report.lanes.map(c => [c.id, c.ownerState, c.worktree]),
      [[exports.AGENTLANE_LANE, 'alive', fs.realpathSync(folder)]],
    );

    const status = cli(['status'], env);
    assert.match(status.stdout, new RegExp(`${exports.AGENTLANE_LANE ?? ''}  process ${String(owner.pid)}  \\[alive\\]`));
    assert.match(status.stdout, /last action: claim/);

    const released = cli(['release', '--worktree', folder], env);
    assert.equal(released.code, 0, released.stderr);
    assert.match(released.stderr, /released lane/);
    assert.match(cli(['status'], env).stdout, /^no lanes$/m);
  } finally {
    owner.kill('SIGKILL');
  }
});

test("releasing another live session's lane is refused with exit 3, naming the holder and the recovery command", () => {
  const holder = sleeper();
  const other = sleeper();
  try {
    const env = registryEnv();
    const folder = tempDir('cli-held');
    const claimed = cli(['claim', '--no-device', '--worktree', folder, '--json'], {
      ...env,
      AGENTLANE_OWNER_PID: String(holder.pid),
    });
    assert.equal(claimed.code, 0, claimed.stderr);
    const id = (JSON.parse(claimed.stdout) as { lane: { id: string } }).lane.id;
    const refused = cli(['release', '--lane', id], { ...env, AGENTLANE_OWNER_PID: String(other.pid) });
    assert.equal(refused.code, 3);
    assert.match(
      refused.stderr,
      new RegExp(`held by process ${String(holder.pid)} in ${fs.realpathSync(folder)}, since \\d{4}-`),
    );
    assert.match(refused.stderr, new RegExp(`node_modules/.bin/agentlane release --lane ${id} --force`));
  } finally {
    holder.kill('SIGKILL');
    other.kill('SIGKILL');
  }
});

test('release takes a bare lane id as --lane does, and refuses two different ids', () => {
  const owner = sleeper();
  try {
    const env = { ...registryEnv(), AGENTLANE_OWNER_PID: String(owner.pid) };
    const laneOne = () => {
      const claimed = cli(['claim', '--no-device', '--worktree', tempDir('cli-bare'), '--json'], env);
      assert.equal(claimed.code, 0, claimed.stderr);
      return (JSON.parse(claimed.stdout) as { lane: { id: string } }).lane.id;
    };
    const first = laneOne();
    const second = laneOne();
    const both = cli(['release', first, '--lane', second], env);
    assert.equal(both.code, 2);
    assert.match(both.stderr, new RegExp(`release ${first} and --lane ${second} name two lanes`));

    const bare = cli(['release', first], env);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stderr, new RegExp(`released lane ${first} `));
    const flagged = cli(['release', '--lane', second, second], env);
    assert.equal(flagged.code, 0, flagged.stderr);
    assert.match(flagged.stderr, new RegExp(`released lane ${second} `));
    assert.match(cli(['status'], env).stdout, /^no lanes$/m);
  } finally {
    owner.kill('SIGKILL');
  }
});

test('a lane whose owner process has exited is freed by the next claim from another session', async () => {
  const doomed = sleeper();
  const next = sleeper();
  try {
    const env = registryEnv();
    const folder = tempDir('cli-dead');
    const first = cli(['claim', '--no-device', '--worktree', folder, '--json'], {
      ...env,
      AGENTLANE_OWNER_PID: String(doomed.pid),
    });
    assert.equal(first.code, 0, first.stderr);
    const id = (JSON.parse(first.stdout) as { lane: { id: string } }).lane.id;
    const exited = new Promise(resolve => doomed.once('exit', resolve));
    doomed.kill('SIGKILL');
    await exited;
    const second = cli(['claim', '--no-device', '--worktree', tempDir('cli-next')], {
      ...env,
      AGENTLANE_OWNER_PID: String(next.pid),
    });
    assert.equal(second.code, 0, second.stderr);
    assert.match(
      second.stderr,
      new RegExp(`freed lane ${id} of process ${String(doomed.pid)} in ${fs.realpathSync(folder)}: owner dead`),
    );
    assert.match(second.stdout, new RegExp(`^export AGENTLANE_METRO_PORT=${String(PORTS)}$`, 'm'));
  } finally {
    doomed.kill('SIGKILL');
    next.kill('SIGKILL');
  }
});

test('lanes without --json points people at status', () => {
  const result = cli(['lanes'], registryEnv());
  assert.equal(result.code, 2);
  assert.match(result.stderr, /agentlane status/);
});
