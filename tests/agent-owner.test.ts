import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { agentOf, describeOwner, ownerKey, resolveOwner } from '../src/registry/owner.ts';
import { databasePath } from '../src/registry/paths.ts';
import { FakeProcesses } from './support/fakes.ts';
import { world } from './support/world.ts';

const HOME = '/Users/someone';
const SELF = 'node /usr/local/lib/node_modules/agentlane/dist/cli.js lane';
const SHELL = '/bin/zsh -c agentlane claim';
const GEMINI = 'node --no-warnings=DEP0040 /opt/homebrew/bin/gemini';
const GEMINI_RELAUNCHED = 'node --no-warnings=DEP0040 --max-old-space-size=8192 /opt/homebrew/bin/gemini';
const CURSOR_AGENT_DIR = `${HOME}/.local/share/cursor-agent/versions/2026.09.30-1a2b3c`;
const CURSOR_MAIN = '/Applications/Cursor.app/Contents/MacOS/Cursor';
const CURSOR_HELPER =
  '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=utility';

test('Gemini CLI: the relaunched CLI process owns the lane, from its shell commands and from processes it starts unmarked', () => {
  const procs = new FakeProcesses();
  const [self, , child] = procs.tree([SELF, SHELL, GEMINI_RELAUNCHED, GEMINI, '-zsh']);
  const owner = resolveOwner({ GEMINI_CLI: '1', HOME }, procs, self?.pid);
  assert.deepEqual(owner, { kind: 'process', process: child, sessionId: 'gemini', threadId: null });
  assert.equal(agentOf(owner), 'gemini');
  assert.equal(ownerKey(owner), `gemini:${String(child?.pid)}:${child?.start ?? ''}`);
  assert.equal(describeOwner(owner), `gemini pid ${String(child?.pid)}`);

  const [mcp] = procs.tree([SELF, GEMINI_RELAUNCHED, GEMINI]);
  assert.equal(agentOf(resolveOwner({ HOME }, procs, mcp?.pid)), 'gemini');

  const [npmSelf, , npmGemini] = procs.tree([
    SELF,
    SHELL,
    'node /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js',
    '-zsh',
  ]);
  assert.deepEqual(resolveOwner({ GEMINI_CLI: '1', HOME }, procs, npmSelf?.pid).process, npmGemini);
});

test('GitHub Copilot CLI: the copilot process owns the lane, with its session id for display', () => {
  const procs = new FakeProcesses();
  const [self, , copilot] = procs.tree([SELF, SHELL, 'node /opt/homebrew/bin/copilot --allow-all-tools', '-zsh']);
  const env = { COPILOT_AGENT_SESSION_ID: '5f0c2a9e-7d1b-4c3a-9e2f-1b2c3d4e5f60', HOME };
  const owner = resolveOwner(env, procs, self?.pid);
  assert.deepEqual(owner.process, copilot);
  assert.equal(agentOf(owner), 'copilot');
  assert.equal(ownerKey(owner), `copilot:${String(copilot?.pid)}:${copilot?.start ?? ''}`);
  assert.equal(describeOwner(owner), `copilot session 5f0c2a9e (pid ${String(copilot?.pid)})`);

  const [nativeSelf, , native] = procs.tree([SELF, SHELL, '/usr/local/bin/copilot', '-zsh']);
  assert.deepEqual(resolveOwner({ COPILOT_CLI: '1', HOME }, procs, nativeSelf?.pid).process, native);
});

test('Cursor CLI: the cursor-agent process owns the lane, found by its install path', () => {
  const procs = new FakeProcesses();
  const [self, , cli] = procs.tree([
    SELF,
    SHELL,
    `${CURSOR_AGENT_DIR}/node --use-system-ca ${CURSOR_AGENT_DIR}/index.js`,
    '-zsh',
  ]);
  const owner = resolveOwner({ CURSOR_AGENT: '1', HOME }, procs, self?.pid);
  assert.deepEqual(owner.process, cli);
  assert.equal(agentOf(owner), 'cursor');
});

test('Cursor IDE: an agent command is owned by the Cursor app process; a person’s own terminal in Cursor is owned by its shell', () => {
  const procs = new FakeProcesses();
  const main = procs.spawn(CURSOR_MAIN);
  const ptyHost = procs.spawn(CURSOR_HELPER, main.pid);
  const extensionHost = procs.spawn(CURSOR_HELPER, main.pid);
  const self = procs.spawn(SELF, procs.spawn('/bin/zsh -l', ptyHost.pid).pid);
  const env = { CURSOR_AGENT: '1', CURSOR_CONVERSATION_ID: 'conv-0123456789', HOME };
  const owner = resolveOwner(env, procs, self.pid);
  assert.deepEqual(owner, { kind: 'process', process: main, sessionId: 'cursor:conv-0123456789', threadId: null });
  assert.equal(describeOwner(owner), `cursor session conv-012 (pid ${String(main.pid)})`);

  const hook = procs.spawn(SELF, procs.spawn('/bin/sh -c agentlane hook', extensionHost.pid).pid);
  assert.equal(ownerKey(resolveOwner(env, procs, hook.pid)), ownerKey(owner));

  const [personSelf, shell] = procs.tree([SELF, '/bin/zsh -l', CURSOR_HELPER, CURSOR_MAIN]);
  const person = resolveOwner({ HOME }, procs, personSelf?.pid);
  assert.deepEqual(person, { kind: 'process', process: shell, sessionId: null, threadId: null });
  assert.equal(agentOf(person), null);
  assert.equal(ownerKey(person), `process:${String(shell?.pid)}:${shell?.start ?? ''}`);
});

test('Antigravity: the agy CLI owns its lanes, and an agent command in the IDE is owned by the app', () => {
  const procs = new FakeProcesses();
  const [cliSelf, , agy] = procs.tree([SELF, SHELL, '/usr/local/bin/agy', '-zsh']);
  const cli = resolveOwner({ ANTIGRAVITY_AGENT: '1', HOME }, procs, cliSelf?.pid);
  assert.deepEqual([agentOf(cli), cli.process], ['antigravity', agy]);

  const [ideSelf, , , app] = procs.tree([
    SELF,
    '/bin/zsh -l',
    '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Plugin).app/Contents/MacOS/Antigravity Helper (Plugin)',
    '/Applications/Antigravity.app/Contents/MacOS/Electron',
  ]);
  const ide = resolveOwner({ ANTIGRAVITY_TRAJECTORY_ID: 'traj-42', HOME }, procs, ideSelf?.pid);
  assert.deepEqual([agentOf(ide), ide.process, ide.sessionId], ['antigravity', app, 'antigravity:traj-42']);
});

test('an unrelated process is not taken for an agent: the owner falls back to the shell', () => {
  const procs = new FakeProcesses();
  for (const unrelated of [
    'node /usr/local/bin/eslint .',
    'vim gemini.md',
    '/bin/zsh -c gemini --version',
    'python3 copilot.py',
    'node /srv/not-gemini/index.js',
    '/opt/tools/agent',
  ]) {
    const [self, shell] = procs.tree([SELF, SHELL, unrelated, '-zsh']);
    const owner = resolveOwner({ HOME }, procs, self?.pid);
    assert.equal(agentOf(owner), null, unrelated);
    assert.deepEqual(owner.process, shell, unrelated);
  }
});

test('nested agents: the agent that marked the command and is nearest owns it', () => {
  const procs = new FakeProcesses();
  const [geminiSelf, , gemini, , outerClaude] = procs.tree([SELF, SHELL, GEMINI, '/bin/zsh -c gemini', 'claude']);
  const inClaude = resolveOwner({ CLAUDE_PID: String(outerClaude?.pid), GEMINI_CLI: '1', HOME }, procs, geminiSelf?.pid);
  assert.deepEqual([agentOf(inClaude), inClaude.process], ['gemini', gemini]);

  const [claudeSelf, , innerClaude] = procs.tree([SELF, SHELL, 'claude -p "run the flows"', SHELL, GEMINI]);
  const inGemini = resolveOwner(
    { CLAUDE_PID: String(innerClaude?.pid), GEMINI_CLI: '1', CLAUDE_CODE_SESSION_ID: 'inner', HOME },
    procs,
    claudeSelf?.pid,
  );
  assert.deepEqual([inGemini.kind, inGemini.process], ['claude', innerClaude]);
});

test('a new agent’s lane is stored with a kind toolkit 0.1.3 knows, reads back as that agent, and is released by another owner', async () => {
  const w = world();
  try {
    const [self, , gemini] = w.procs.tree([SELF, SHELL, GEMINI, '-zsh']);
    const owner = resolveOwner({ GEMINI_CLI: '1', HOME }, w.procs, self?.pid);
    const held = await w.registry().claim(w.request(owner, w.folder('gemini')));

    const db = new DatabaseSync(databasePath(w.dir), { readOnly: true });
    try {
      const row = db.prepare('SELECT owner_kind, owner_key, owner_session FROM claims').get();
      assert.deepEqual(
        { ...row },
        {
          owner_kind: 'process',
          owner_key: `gemini:${String(gemini?.pid)}:${gemini?.start ?? ''}`,
          owner_session: 'gemini',
        },
      );
    } finally {
      db.close();
    }
    const status = w.registry().status().lanes[0];
    assert.equal(status ? describeOwner(status.owner) : '', `gemini pid ${String(gemini?.pid)}`);
    assert.equal(status?.ownerState, 'alive');

    const notes: string[] = [];
    const ended = w.registry().releaseById(held.lane.id, w.procs.owner(), true, notes);
    assert.equal(ended.owner, `gemini pid ${String(gemini?.pid)}`);
  } finally {
    w.close();
  }
});
