import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { claudePluginInstall, claudePluginSources } from '../../src/agents/claude-plugin.ts';
import { tempDir } from '../support/fakes.ts';

const PLUGIN = path.resolve(import.meta.dirname, '..', '..', 'plugin');

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test('the plugin counts as loaded where Claude Code loads it: local over project over user settings key by key, and the session', () => {
  const root = fs.realpathSync(tempDir('claude-plugin'));
  try {
    const dir = path.join(root, 'app');
    fs.mkdirSync(dir);
    const user = path.join(root, 'claude-config', 'settings.json');
    const env = { CLAUDE_CONFIG_DIR: path.dirname(user) };
    assert.deepEqual(claudePluginSources(dir, env), []);

    writeJson(user, { enabledPlugins: { 'agentlane@north-star': true, 'dev-loop@north-star': true } });
    assert.deepEqual(claudePluginSources(dir, env), [{ kind: 'user', file: user }]);

    writeJson(path.join(dir, '.claude/settings.json'), { enabledPlugins: { 'agentlane@north-star': false } });
    assert.deepEqual(claudePluginSources(dir, env), [], 'the project turns off what the user turned on');

    writeJson(path.join(dir, '.claude/settings.local.json'), { enabledPlugins: { 'agentlane@north-star': true } });
    assert.deepEqual(claudePluginSources(dir, env), [{ kind: 'local', file: '.claude/settings.local.json' }]);

    fs.rmSync(path.join(dir, '.claude/settings.local.json'));
    writeJson(path.join(dir, '.claude/settings.json'), { enabledPlugins: { 'agentlane@agentlane': true } });
    assert.deepEqual(claudePluginSources(dir, env), [
      { kind: 'project', file: '.claude/settings.json' },
      { kind: 'user', file: user },
    ]);

    fs.rmSync(path.join(dir, '.claude'), { recursive: true });
    fs.rmSync(user);
    const bin = path.join(PLUGIN, 'bin');
    const session = { ...env, CLAUDECODE: '1', PATH: ['/usr/bin', bin, '/bin'].join(path.delimiter) };
    assert.deepEqual(claudePluginSources(dir, session), [{ kind: 'session', dir: PLUGIN }]);
    assert.deepEqual(
      claudePluginSources(dir, { ...env, PATH: session.PATH }),
      [],
      "the plugin's bin on a PATH outside Claude Code is someone's shell, not a session",
    );

    const other = path.join(root, 'other-plugin');
    writeJson(path.join(other, '.claude-plugin', 'plugin.json'), { name: 'dev-loop' });
    fs.mkdirSync(path.join(other, 'bin'));
    assert.deepEqual(claudePluginSources(dir, { ...session, PATH: path.join(other, 'bin') }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a project-scope install covers the git worktrees of the checkout it was installed for, and no other folder', () => {
  const root = fs.realpathSync(tempDir('claude-plugin-worktree'));
  try {
    const main = path.join(root, 'app');
    const worktree = path.join(root, 'app-worktrees', 'feature');
    const other = path.join(root, 'other');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'start');
    git(main, 'worktree', 'add', '-q', worktree);
    fs.mkdirSync(other);
    for (const dir of [main, worktree, other]) {
      writeJson(path.join(dir, '.claude/settings.json'), { enabledPlugins: { 'agentlane@agentlane': true } });
    }
    const config = path.join(root, 'claude-config');
    const env = { CLAUDE_CONFIG_DIR: config, PATH: process.env.PATH ?? '' };
    writeJson(path.join(config, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'agentlane@agentlane': [{ scope: 'project', projectPath: main, installPath: PLUGIN }] },
    });

    assert.deepEqual(claudePluginInstall(main, env), { kind: 'loaded', dir: PLUGIN });
    assert.deepEqual(claudePluginInstall(worktree, env), { kind: 'loaded', dir: PLUGIN });
    assert.deepEqual(claudePluginInstall(other, env), { kind: 'not-installed', keys: ['agentlane@agentlane'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
