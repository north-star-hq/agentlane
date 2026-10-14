import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runAgentCommand } from '../../src/agents/cli.ts';
import { isStubOf, listSkills, parseSkill, setupFix, SKILLS_DIR, stubOf } from '../../src/agents/skills.ts';
import { AGENTS } from '../../src/registry/owner.ts';
import { tempDir } from '../support/fakes.ts';
import { recordingInstaller } from '../support/installer.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const PLUGIN_SKILLS = path.join(ROOT, 'plugin', 'skills');
const NAMES = ['create-verification-skill', 'dev-loop', 'device', 'drive', 'maintain-verification-skill', 'setup'];

test('the toolkit ships its skills in the package, each with a name and a description', () => {
  assert.equal(SKILLS_DIR, `${path.join(ROOT, 'skills')}${path.sep}`);
  assert.deepEqual(
    listSkills().map(s => s.name),
    NAMES,
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
  assert.ok(manifest.files.includes('skills'), 'package.json files must ship skills/');
  for (const skill of listSkills()) assert.ok(skill.description.length > 40, skill.name);
});

test('each adapted skill keeps its licence file, its licence line and its pstack attribution with its content', () => {
  for (const name of ['create-verification-skill', 'dev-loop', 'maintain-verification-skill']) {
    const licence = fs.readFileSync(path.join(SKILLS_DIR, name, 'LICENSE'), 'utf8');
    assert.match(licence, /^MIT License\n\nCopyright \(c\) 2026 Lauren Tan\n/);
    const text = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    assert.match(text, /\nlicense: Parts adapted from cursor\/plugins \(pstack\) under the MIT License/);
    assert.match(parseSkill(text, name).body, /adapted from cursor\/plugins \(pstack\/skills\/[a-z-]+\), MIT License/i);
  }
});

test('the skills name no Claude Code tool, so they read the same in every agent', () => {
  for (const skill of listSkills()) {
    const text = `${skill.frontmatter}\n${skill.body}`;
    assert.doesNotMatch(text, /Skill tool|\bBash\b|explorer subagent|CLAUDE_PLUGIN_ROOT/, skill.name);
  }
});

test('each skill says when it is done', () => {
  for (const skill of listSkills()) assert.match(skill.body, /\bDone when\b|\bis done when\b/, skill.name);
});

function bareCommands(text: string): string[] {
  return [...text.matchAll(/`[^`\n]+`/g)].map(m => m[0]).filter(span => /(?<![\w/.-]|npx )agentlane /.test(span));
}

function toolkitCommands(text: string): string[] {
  return [...text.matchAll(/node_modules\/\.bin\/agentlane ([a-z][a-z-]*)/g)].map(m => m[1] ?? '');
}

test('the skills, their stubs and the setup pointer write every toolkit command in the form a plain shell runs', () => {
  for (const skill of listSkills()) {
    assert.deepEqual(bareCommands(skill.body), [], `${skill.name} tells an agent to run a bare agentlane`);
    assert.deepEqual(bareCommands(parseSkill(stubOf(skill), skill.name).body), [], `${skill.name}'s stub`);
  }
  assert.deepEqual(bareCommands(setupFix('by hand').replace(/'/g, '`')), []);
  const create = listSkills().find(s => s.name === 'create-verification-skill');
  assert.match(
    create?.body ?? '',
    /Write every toolkit command in it as `node_modules\/\.bin\/agentlane …`, run from the project root/,
    'create-verification-skill tells the run skill which form to write',
  );
  const loop = listSkills().find(s => s.name === 'dev-loop');
  assert.match(loop?.body ?? '', /each toolkit command written as `node_modules\/\.bin\/agentlane …` from the project root/);
});

test('from a plain shell in a project init wired, every toolkit command the skills name runs, and a bare agentlane does not', async () => {
  const root = fs.realpathSync(tempDir('skills-plain-shell'));
  try {
    const dir = path.join(root, 'app');
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
    fs.writeFileSync(
      path.join(dir, 'node_modules', '.bin', 'agentlane'),
      `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`,
      { mode: 0o755 },
    );
    const out: string[] = [];
    const code = await runAgentCommand('init', ['--all'], {
      env: { AGENTLANE_STATE_DIR: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') },
      cwd: dir,
      install: recordingInstaller().install,
      stdout: text => out.push(text),
      stderr: text => out.push(text),
    });
    assert.equal(code, 0, out.join(''));
    const plain = (command: string) =>
      spawnSync('/bin/sh', ['-c', command], {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: root, AGENTLANE_STATE_DIR: path.join(root, 'state') },
        encoding: 'utf8',
      });
    assert.notEqual(plain('command -v agentlane').status, 0, 'a plain shell has no agentlane on its PATH');

    const commands = new Set(listSkills().flatMap(skill => toolkitCommands(skill.body)));
    assert.ok(commands.size >= 10, [...commands].join(' '));
    for (const command of commands) {
      const got = plain(`node_modules/.bin/agentlane ${command} --help`);
      assert.equal(got.status, 0, `${command}: ${got.stderr}`);
      assert.match(got.stdout, new RegExp(`^Usage: agentlane ${command}\\b`), command);
    }
    for (const skill of listSkills()) {
      const stub = parseSkill(fs.readFileSync(path.join(dir, '.agents/skills', skill.name, 'SKILL.md'), 'utf8'), skill.name);
      const named = /`(node_modules\/\.bin\/agentlane skills get [a-z-]+)`/.exec(stub.body)?.[1];
      assert.ok(named, skill.name);
      const got = plain(named);
      assert.equal(got.status, 0, `${skill.name}: ${got.stderr}`);
      assert.equal(got.stdout, skill.body, skill.name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setup says where a background build’s output goes, and create-verification-skill names what a hand-built config carries', () => {
  const body = (name: string) => listSkills().find(s => s.name === name)?.body ?? '';
  const setup = body('setup');
  assert.match(setup, /writes each hook's output, the build's included, into the lane's log folder/);
  assert.match(setup, /\(log: <folder>\/hooks\/build\.log\)/);
  assert.match(setup, /Any log you do write goes in that folder too \(`\$AGENTLANE_LOGS` under `exec`/);
  assert.match(setup, /not in the project or a folder beside or above it/);

  const create = body('create-verification-skill');
  assert.match(create, /usage telemetry, switch it off in the start command .*`EXPO_NO_TELEMETRY=1`/);
  assert.match(create, /`buildCache\.inputs` lists what the native build reads/);
  assert.match(
    create,
    /add a `command` input for every other tool whose version changes the native output, such as `pod --version`/,
  );
  assert.match(create, /the project's dependencies are installed \(`test -d node_modules`, `before: build`/);
});

test('create- and maintain-verification-skill treat a wait that never matches in a sign-in or setup flow as a defect', () => {
  const body = (name: string) => listSkills().find(s => s.name === name)?.body ?? '';
  const create = body('create-verification-skill');
  assert.match(create, /pays the full timeout of each wait or tap that never matches/);
  assert.match(create, /Wait on a handle the driver can see in the screen's accessibility tree/);
  assert.match(create, /A wait that guards readiness is required, with a timeout no longer than the step needs/);
  assert.match(create, /A WARNED step in a sign-in or setup flow is a defect to fix/);
  assert.match(create, /a WARNED step there fails this step until it is fixed/);
  const maintain = body('maintain-verification-skill');
  assert.match(maintain, /Read the logs of the flows the hooks run during `up`/);
  assert.match(maintain, /A WARNED step there is a wait or tap that never matches/);
  assert.match(maintain, /the hook scripts it names and the flows they run/);
});

test('setup runs every committed flow and suite in the lane, before and after its code changes, and reports each', () => {
  const setup = listSkills().find(s => s.name === 'setup')?.body ?? '';
  assert.match(setup, /every committed flow and test suite has a result in the lane/);
  assert.match(setup, /An unknown mark is settled in step 6, which runs every flow and suite in the lane/);
  assert.match(setup, /run every committed Maestro flow and every Playwright or other end-to-end suite once in the lane/);
  assert.match(setup, /run them once before those changes and once after/);
  assert.match(
    setup,
    /listed with the command that runs it and the reason\. Every committed flow and suite appears in the results/,
  );
  assert.match(setup, /every committed flow and suite by name: its baseline mark, its result in the lane/);
});

test('create-verification-skill pins the device strictly when committed flows depend on its screen', () => {
  const create = listSkills().find(s => s.name === 'create-verification-skill')?.body ?? '';
  assert.match(
    create,
    /when committed flows tap by point, or the repo says which device they were measured on, pin that model in `app\.device` with `strict: true`/,
  );
  assert.match(create, /a full pool hands the lane another model/);
});

test('create-verification-skill checks each tool a hook calls, and the variable a seam needs where the repo documents a silent failure', () => {
  const create = listSkills().find(s => s.name === 'create-verification-skill')?.body ?? '';
  assert.match(
    create,
    /one per tool a hook or a start command calls that the project doesn't install itself \(`command -v pod`, `command -v uv`\), one tool to a check/,
  );
  assert.match(create, /when the repo documents a failure that stays silent without a particular variable/);
  assert.match(create, /`grep -q '\^SEAM_KEY=\.' \.env\.test`\. The check prints nothing, so the value stays out of every log/);
  assert.match(create, /the project's dependencies are installed \(`test -d node_modules`, `before: build`/);
});

test('create-verification-skill seeds a page for every feature the repo lists, and maintain-verification-skill fills the thin ones', () => {
  const body = (name: string) => listSkills().find(s => s.name === name)?.body ?? '';
  const create = body('create-verification-skill');
  assert.match(create, /When the repo lists its features itself \(a `docs\/INDEX\.md` per app/);
  assert.match(create, /seed a page for every feature it lists, so `maintain-verification-skill` has every page to fill in/);
  assert.match(create, /a first line saying it hasn't been driven yet/);
  assert.match(create, /the pages still thin/);
  assert.match(
    body('maintain-verification-skill'),
    /A thin page, one that says it hasn't been driven yet, gets its full sections from this pass/,
  );
});

test('drive says playwright-cli find reads the page as it is when it runs, and a run skill installs before up in a fresh worktree', () => {
  const body = (name: string) => listSkills().find(s => s.name === name)?.body ?? '';
  assert.match(
    body('drive'),
    /`playwright-cli find <text>` searches the snapshot `snapshot` prints, ignoring case, as the page is when it runs/,
  );
  assert.match(body('drive'), /take a `snapshot` or run `find` again before you call the text absent/);
  assert.match(
    body('dev-loop'),
    /\*\*Launch:\*\* in a fresh worktree, the project's install command first, since `node_modules\/\.bin\/agentlane` exists only after it/,
  );
});

test('the old device skill points to drive, so run skills that name it still work', () => {
  const device = listSkills().find(s => s.name === 'device');
  assert.ok(device);
  assert.match(device.description, /former name of the `drive` skill/);
  assert.match(device.body, /Load the `drive` skill/);
});

test('every agent reaches the setup skill through the stub init writes for it, and through the plugin', async () => {
  const root = fs.realpathSync(tempDir('skills-setup'));
  try {
    const dir = path.join(root, 'app');
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
    fs.writeFileSync(
      path.join(dir, 'node_modules', '.bin', 'agentlane'),
      `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`,
      { mode: 0o755 },
    );
    const out: string[] = [];
    const code = await runAgentCommand('init', ['--all'], {
      env: { AGENTLANE_STATE_DIR: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') },
      cwd: dir,
      install: recordingInstaller().install,
      stdout: text => out.push(text),
      stderr: text => out.push(text),
    });
    assert.equal(code, 0, out.join(''));
    const setup = listSkills().find(s => s.name === 'setup');
    assert.ok(setup);
    const folders: Record<string, string> = Object.fromEntries(
      AGENTS.map(agent => [agent, path.join(dir, agent === 'claude' ? '.claude' : '.agents', 'skills')]),
    );
    folders.plugin = PLUGIN_SKILLS;
    for (const [agent, folder] of Object.entries(folders)) {
      const stub = parseSkill(fs.readFileSync(path.join(folder, 'setup', 'SKILL.md'), 'utf8'), agent);
      assert.equal(stub.name, 'setup', agent);
      const command = /`(node_modules\/\.bin\/agentlane skills get setup)`/.exec(stub.body)?.[1];
      assert.ok(command, `${agent}: the stub names no command that works without agentlane on the PATH`);
      const got = spawnSync('/bin/sh', ['-c', command], {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: root },
        encoding: 'utf8',
      });
      assert.equal(got.status, 0, `${agent}: ${got.stderr}`);
      assert.equal(got.stdout, setup.body, agent);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the plugin’s skill files are the stubs the generator writes, and each fetches its own skill', () => {
  assert.deepEqual(fs.readdirSync(PLUGIN_SKILLS).sort(), NAMES);
  for (const skill of listSkills()) {
    const stub = fs.readFileSync(path.join(PLUGIN_SKILLS, skill.name, 'SKILL.md'), 'utf8');
    assert.equal(stub, stubOf(skill), `${skill.name}: regenerate plugin/skills from stubOf`);
    const parsed = parseSkill(stub, skill.name);
    assert.deepEqual([parsed.name, parsed.description], [skill.name, skill.description]);
    assert.equal(isStubOf(stub, skill.name), true);
    assert.equal(isStubOf(stub, 'device-other'), false);
    assert.ok(parsed.body.length < 400, `${skill.name}: a stub stays short`);
  }
  assert.equal(isStubOf('---\nname: device\ndescription: mine\n---\n\nMy own device notes.\n', 'device'), false);
  assert.equal(isStubOf('not a skill', 'device'), false);
});

test('skills get prints the installed content, and an unknown name lists the real ones', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const skill of listSkills()) {
    const got = spawnSync(process.execPath, [CLI, 'skills', 'get', skill.name], { env, encoding: 'utf8' });
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stdout, skill.body);
  }
  const list = spawnSync(process.execPath, [CLI, 'skills', 'list'], { env, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trim().split('\n').length, NAMES.length);
  const missing = spawnSync(process.execPath, [CLI, 'skills', 'get', 'nope'], { env, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /there is no skill 'nope'\nto fix: pass one of: create-verification-skill, dev-loop/);
});
