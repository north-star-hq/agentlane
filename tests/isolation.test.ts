import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tempDir } from './support/fakes.ts';
import { homeFolders } from './support/home-folders.ts';

const ROOT_ENV = 'LANE_TESTS_ROOT';
const HOST_TEMP_ENV = 'LANE_TESTS_HOST_TEMP';
const REDIRECTED = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'AGENTLANE_STATE_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'TMPDIR',
  'AGENTLANE_USER_TEMP',
];
const ISOLATE = pathToFileURL(path.join(import.meta.dirname, 'support', 'isolate.ts')).href;
const HOME_FOLDERS = pathToFileURL(path.join(import.meta.dirname, 'support', 'home-folders.ts')).href;

interface Probed {
  folders: Record<string, string>;
  env: Record<string, string | undefined>;
}

function root(): string {
  const dir = process.env[ROOT_ENV];
  assert.ok(dir, `${ROOT_ENV} is unset: this test process did not start through the test script's preload`);
  return dir;
}

function inside(dir: string, parent: string): boolean {
  const relative = path.relative(parent, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertUnder(parent: string, folders: Record<string, string | undefined>, where: string): void {
  for (const [name, dir] of Object.entries(folders)) {
    assert.ok(dir !== undefined && inside(dir, parent), `${where}: ${name} is ${String(dir)}, outside ${parent}`);
  }
}

function probe(env: NodeJS.ProcessEnv | undefined): Probed {
  const script = [
    `import { homeFolders } from ${JSON.stringify(HOME_FOLDERS)};`,
    `const names = ${JSON.stringify(REDIRECTED)};`,
    'const env = Object.fromEntries(names.map(name => [name, process.env[name]]));',
    'process.stdout.write(JSON.stringify({ folders: homeFolders(), env }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Probed;
}

test('a test process, and every process it starts, keeps each home-derived folder under one temp root', () => {
  const top = root();
  assert.notEqual(os.homedir(), os.userInfo().homedir);
  assert.equal(os.homedir(), path.join(top, 'home'));
  assertUnder(top, Object.fromEntries(REDIRECTED.map(name => [name, process.env[name]])), 'this process');
  assertUnder(top, homeFolders(), 'this process');

  const inherited = probe(undefined);
  assertUnder(top, inherited.env, 'a child that inherits the env');
  assertUnder(top, inherited.folders, 'a child that inherits the env');
  for (const [where, env] of [
    ['a child given a hand-built env', { PATH: process.env.PATH, LANG: 'C' }],
    ['a child given an empty env', {}],
  ] as const) {
    const child = probe(env);
    assertUnder(top, child.folders, where);
    assert.equal(child.folders['os.homedir()'], path.join(top, 'home'), where);
  }
});

test('a child whose env sets HOME to undefined on purpose gets no HOME, and still gets the temp folders', () => {
  const top = root();
  const child = probe({ PATH: process.env.PATH, HOME: undefined });
  assert.equal(child.env.HOME, undefined);
  assert.equal(child.folders['os.homedir()'], os.userInfo().homedir);
  assertUnder(top, { TMPDIR: child.env.TMPDIR, AGENTLANE_USER_TEMP: child.env.AGENTLANE_USER_TEMP }, 'that child');
  assertUnder(top, { 'the per-user temp folder': child.folders['the per-user temp folder'] }, 'that child');
});

test("a fixture that sets only AGENTLANE_STATE_DIR still resolves the home folder's subfolders under the temp root", () => {
  const top = root();
  const state = tempDir('only-state');
  const env = { AGENTLANE_STATE_DIR: state };
  const here = homeFolders(env);
  assert.equal(here['the registry'], state);
  assertUnder(top, here, 'this process, from an env of AGENTLANE_STATE_DIR alone');
  const child = probe(env);
  assert.equal(child.folders['the registry'], state);
  assertUnder(top, child.folders, 'a child given AGENTLANE_STATE_DIR alone');
});

function rootOf(output: string): string {
  const [line] = output.split('\n');
  assert.ok(line, 'the child printed no root');
  return line;
}

test('a test process removes its root as it exits, and the next one removes the root of one that was killed', async () => {
  const host = tempDir('roots');
  const env = { ...process.env, [ROOT_ENV]: undefined, [HOST_TEMP_ENV]: host };
  const print = `process.stdout.write(process.env.${ROOT_ENV} + '\\n' + process.env.HOME + '\\n');`;
  const args = ['--import', ISOLATE, '-e', print];

  const exited = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(exited.status, 0, exited.stderr);
  const first = rootOf(exited.stdout);
  assert.equal(path.dirname(first), host);
  assert.equal(exited.stdout.split('\n')[1], path.join(first, 'home'));
  assert.equal(fs.existsSync(first), false, 'the root outlived its process');

  const killed = spawn(process.execPath, ['--import', ISOLATE, '-e', `${print} setInterval(() => {}, 1000);`], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const second = await new Promise<string>((resolve, reject) => {
    killed.stdout.once('data', (chunk: Buffer) => {
      resolve(rootOf(chunk.toString()));
    });
    killed.once('error', reject);
  });
  const gone = new Promise(resolve => killed.once('exit', resolve));
  killed.kill('SIGKILL');
  await gone;
  assert.equal(fs.existsSync(second), true, 'a killed process cannot remove its own root');

  const live = path.join(host, 'ltlive00');
  const unmarked = path.join(host, 'ltnomark');
  for (const dir of [live, unmarked]) fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  fs.writeFileSync(path.join(live, '.owner'), JSON.stringify({ pid: process.pid }));

  const next = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(fs.existsSync(second), false, "the killed process's root is still there");
  assert.equal(fs.existsSync(rootOf(next.stdout)), false);
  assert.deepEqual(fs.readdirSync(host).sort(), ['ltlive00', 'ltnomark'], 'a live or unmarked root was removed');
});
