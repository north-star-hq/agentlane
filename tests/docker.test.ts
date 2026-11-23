import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
  description: string;
  files: string[];
};
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'docker.yml'), 'utf8');
const DOCS = fs.readFileSync(path.join(ROOT, 'site', 'docs', 'docker.md'), 'utf8');

test('the image is labelled with package.json’s description, and with the version its build is given', () => {
  assert.equal(/org\.opencontainers\.image\.description="([^"]*)"/.exec(DOCKERFILE)?.[1], PACKAGE.description);
  assert.match(DOCKERFILE, /^ARG VERSION$/m, 'a release bumps no version in the Dockerfile');
  assert.match(DOCKERFILE, /org\.opencontainers\.image\.version="\$\{VERSION\}"/);
  assert.match(WORKFLOW, /docker build --build-arg VERSION="\$\(node -p 'require\("\.\/package\.json"\)\.version'\)"/);
  assert.match(WORKFLOW, /build-args: VERSION=\$\{\{ inputs\.version \}\}/);
});

test('the docs page names the base image the Dockerfile pins', () => {
  const base = /^ARG NODE_IMAGE=([^@\s]+)@/m.exec(DOCKERFILE)?.[1];
  assert.ok(base, 'the Dockerfile pins NODE_IMAGE by tag and digest');
  assert.ok(DOCS.includes(`\`${base}\``), `site/docs/docker.md names ${base}`);
});

test('the build context lets in every file the published package holds but dist, which the image builds itself', () => {
  const allowed = fs
    .readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .filter(line => line.startsWith('!'))
    .map(line => line.slice(1).replace(/\/$/, ''));
  assert.ok(!allowed.includes('dist'), '.dockerignore keeps a local dist out of the build');
  for (const entry of PACKAGE.files.filter(f => f !== 'dist'))
    assert.ok(allowed.includes(entry), `.dockerignore lets in ${entry}`);
});

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}

interface Workflow {
  on: { workflow_call?: { inputs: Record<string, { type: string; default?: unknown }> } };
  env?: Record<string, unknown>;
  jobs: Record<string, { outputs?: Record<string, unknown>; with?: Record<string, unknown>; steps?: Step[] }>;
}

type Context = Record<string, unknown>;

interface Runner {
  PATH: string;
  HOME: string;
  GITHUB_REF_NAME: string;
  GITHUB_WORKSPACE: string;
  RUNNER_TEMP: string;
}

function workflow(name: string): Workflow {
  return parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8')) as Workflow;
}

function asNumber(value: unknown): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (value === '') return 0;
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return NaN;
}

// GitHub's `==`: strings compare ignoring case, and mismatched types are both coerced to numbers.
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#operators
function equals(value: unknown, literal: string): boolean {
  if (typeof value === 'string') return value.toLowerCase() === literal.toLowerCase();
  return asNumber(value) === asNumber(literal);
}

function lookup(expression: string, context: Context): unknown {
  const [, reference = '', literal] = /^([\w.-]+)(?: == '([^']*)')?$/.exec(expression) ?? [];
  assert.ok(reference, `the stand-in evaluates \${{ ${expression} }}`);
  let value: unknown = context;
  for (const key of reference.split('.')) value = (value as Record<string, unknown> | undefined)?.[key];
  if (literal !== undefined) return equals(value ?? null, literal);
  return value ?? '';
}

function evaluate(value: unknown, context: Context): unknown {
  if (typeof value !== 'string') return value;
  const whole = /^\$\{\{\s*([^}]*?)\s*\}\}$/.exec(value);
  if (whole) return lookup(whole[1] ?? '', context);
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => String(lookup(expression, context)));
}

function evaluateAll(values: Record<string, unknown> | undefined, context: Context): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, evaluate(value, context)]));
}

test('the stand-in for ${{ }} compares as GitHub does', () => {
  const context = { inputs: { push: true, off: false }, needs: { publish: { outputs: { latest: 'true' } } } };
  assert.equal(lookup("inputs.push == 'true'", context), false, 'a boolean is never equal to a word');
  assert.equal(lookup("inputs.push == '1'", context), true);
  assert.equal(lookup("inputs.off == ''", context), true);
  assert.equal(lookup("needs.publish.outputs.latest == 'TRUE'", context), true, 'strings compare ignoring case');
  assert.equal(lookup("needs.publish.outputs.latest == 'false'", context), false);
  assert.equal(lookup("inputs.missing == ''", context), true, 'a missing value is null, which is 0, as is an empty string');
  assert.throws(() => lookup("inputs.push != 'true'", context), /the stand-in evaluates/);
  assert.throws(() => lookup('fromJSON(inputs.push)', context), /the stand-in evaluates/);
});

function findStep(file: Workflow, job: string, step: string): Step {
  const found = file.jobs[job]?.steps?.find(s => s.id === step || s.name === step || s.uses?.split('@')[0] === step);
  assert.ok(found, `${job} has a step ${step}`);
  return found;
}

function runStep(file: Workflow, job: string, step: string, context: Context, runner: Runner): Record<string, string> {
  const found = findStep(file, job, step);
  assert.ok(found.run, `${job}'s ${step} is a run step`);
  const output = path.join(runner.RUNNER_TEMP, 'github-output');
  fs.writeFileSync(output, '');
  const env: Record<string, string> = { ...runner, GITHUB_OUTPUT: output };
  for (const [name, value] of Object.entries(evaluateAll({ ...file.env, ...found.env }, context))) env[name] = String(value);
  const run = spawnSync('bash', ['-e', '-c', String(evaluate(found.run, context))], {
    cwd: runner.GITHUB_WORKSPACE,
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, `${job}'s ${step}: ${run.stdout}${run.stderr}`);
  return Object.fromEntries(
    fs
      .readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): [string, string] => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

function git(dir: string, ...args: string[]) {
  const ran = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args]);
  assert.equal(ran.status, 0, ran.stderr.toString());
}

function tagCheckout(version: string, tags: string[]): { runner: Runner; origin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlane-publish-'));
  const origin = path.join(dir, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'release');
  for (const tag of tags) git(origin, 'tag', tag);
  const workspace = path.join(dir, 'workspace');
  fs.cpSync(path.join(ROOT, '.github', 'scripts'), path.join(workspace, '.github', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ version, description: PACKAGE.description }));
  fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), `## ${version.replace(/-.*/, '')}\n\n- Notes.\n`);
  git(workspace, 'init', '-q');
  git(workspace, 'remote', 'add', 'origin', origin);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/bin/sh\nif [ "$1 $2" = "release view" ]; then exit 1; fi\nprintf \'%s\\n\' "$@" > "$RUNNER_TEMP/gh-args"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "$@" >> "$RUNNER_TEMP/docker-args"\n', { mode: 0o755 });
  const runner = {
    PATH: [bin, path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
    HOME: process.env.HOME ?? dir,
    GITHUB_REF_NAME: `v${version}`,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: dir,
  };
  return { runner, origin };
}

const BUILD = 'docker/build-push-action';
const TAG_LATEST = 'Tag the pushed image latest if it is the highest stable version';

function publishRun(version: string, tags: string[], meanwhile?: (origin: string) => void) {
  const publish = workflow('publish.yml');
  const docker = workflow('docker.yml');
  const { runner, origin } = tagCheckout(version, tags);

  const outputs = evaluateAll(publish.jobs.publish?.outputs, {
    steps: { version: { outputs: runStep(publish, 'publish', 'version', {}, runner) } },
  });
  const needs = { publish: { outputs } };

  const declared = docker.on.workflow_call?.inputs ?? {};
  const passed = evaluateAll(publish.jobs.docker?.with, { needs });
  for (const [name, value] of Object.entries(passed))
    assert.equal(typeof value, declared[name]?.type, `publish.yml passes docker.yml's ${name} as its declared type`);
  const inputs = { ...Object.fromEntries(Object.entries(declared).map(([name, d]) => [name, d.default])), ...passed };
  const steps = { version: { outputs: runStep(docker, 'publish', 'version', { inputs }, runner) } };
  const build = evaluateAll(findStep(docker, 'publish', BUILD).with, { inputs, steps, env: docker.env });
  const pushed = String(build.tags).split(/[,\n]/).filter(Boolean);
  const order = docker.jobs.publish?.steps ?? [];
  assert.ok(
    order.indexOf(findStep(docker, 'publish', TAG_LATEST)) > order.indexOf(findStep(docker, 'publish', BUILD)),
    'latest is decided after the build has pushed the version',
  );

  meanwhile?.(origin);

  runStep(docker, 'publish', TAG_LATEST, { inputs, steps }, runner);
  const added = fs.existsSync(path.join(runner.RUNNER_TEMP, 'docker-args'))
    ? fs.readFileSync(path.join(runner.RUNNER_TEMP, 'docker-args'), 'utf8').split('\n').filter(Boolean)
    : [];
  for (const line of added) {
    const [, tag = '', source = ''] = /^buildx imagetools create --tag (\S+) (\S+)$/.exec(line) ?? [];
    assert.ok(pushed.includes(source), `${line} tags an image the build pushed`);
    pushed.push(tag);
  }

  runStep(publish, 'release', 'Create the GitHub Release', { needs, github: { token: 't' } }, runner);
  const release = fs
    .readFileSync(path.join(runner.RUNNER_TEMP, 'gh-args'), 'utf8')
    .split('\n')
    .filter(arg => arg.startsWith('--latest') || arg === '--prerelease')
    .sort();

  return { tags: pushed, release };
}

const IMAGE = String(workflow('docker.yml').env?.IMAGE);
const EARLIER = ['maestro-v2.11.0-agentlane.1', 'v0.5.1', 'v0.6.0', 'v0.6.1-rc.1'];

test('a published image is tagged latest, as its GitHub Release is Latest, only when it is the highest stable version', () => {
  assert.deepEqual(
    {
      '0.6.1': publishRun('0.6.1', [...EARLIER, 'v0.6.1']),
      '0.5.9 after v0.6.1': publishRun('0.5.9', [...EARLIER, 'v0.6.1', 'v0.5.9']),
      '0.6.2-rc.1': publishRun('0.6.2-rc.1', [...EARLIER, 'v0.6.1', 'v0.6.2-rc.1']),
    },
    {
      '0.6.1': { tags: [`${IMAGE}:0.6.1`, `${IMAGE}:latest`], release: ['--latest=true'] },
      '0.5.9 after v0.6.1': { tags: [`${IMAGE}:0.5.9`], release: ['--latest=false'] },
      '0.6.2-rc.1': { tags: [`${IMAGE}:0.6.2-rc.1`], release: ['--latest=false', '--prerelease'] },
    },
  );
});

test('latest is decided from the tags as they are when the image is tagged and the Release made, not when the run began', () => {
  const run = publishRun('0.6.1', [...EARLIER, 'v0.6.1'], origin => {
    git(origin, 'tag', 'v0.6.2');
  });
  assert.deepEqual(run, { tags: [`${IMAGE}:0.6.1`], release: ['--latest=false'] });
});

test('a step that cannot read the tags fails rather than deciding latest without them', () => {
  const { runner, origin } = tagCheckout('0.5.9', [...EARLIER, 'v0.6.1', 'v0.5.9']);
  fs.rmSync(origin, { recursive: true });
  const version = { inputs: { version: '0.5.9' }, steps: {} };
  const release = { needs: { publish: { outputs: { version: '0.5.9' } } }, github: { token: 't' } };
  assert.throws(
    () => runStep(workflow('docker.yml'), 'publish', TAG_LATEST, version, runner),
    /does not appear to be a git repository/,
  );
  assert.throws(
    () => runStep(workflow('publish.yml'), 'release', 'Create the GitHub Release', release, runner),
    /does not appear to be a git repository/,
  );
  assert.ok(!fs.existsSync(path.join(runner.RUNNER_TEMP, 'docker-args')), 'no image is tagged');
  assert.ok(!fs.existsSync(path.join(runner.RUNNER_TEMP, 'gh-args')), 'no Release is made');
});
