import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR_MS } from '../src/registry/config.ts';
import { codexHome, isCodexDaemon, ownerKey, resolveOwner } from '../src/registry/owner.ts';
import { FakeProcesses } from './support/fakes.ts';
import { world } from './support/world.ts';

const HOME = '/Users/someone';
const DAEMON_BIN = `${HOME}/.codex/packages/app-server-daemon/current/bin/codex`;
const SELF = 'node /usr/local/lib/node_modules/agentlane/dist/cli.js lane';
const SHELL = '/bin/zsh -lc agentlane claim';
const ENV = { CODEX_THREAD_ID: 'thread-tui', HOME };

test('Codex TUI with the shared daemon: the daemon is skipped, and so is anything above it, so the owner is the thread with no process', () => {
  const procs = new FakeProcesses();
  const viaLaunchd = procs.tree([
    SELF,
    SHELL,
    `${DAEMON_BIN} app-server --listen unix:// --analytics-default-enabled --managed-daemon`,
    `${DAEMON_BIN} app-server daemon pid-update-loop`,
  ]);
  const owner = resolveOwner(ENV, procs, viaLaunchd[0]?.pid);
  assert.deepEqual(owner, { kind: 'codex', process: null, sessionId: null, threadId: 'thread-tui' });
  assert.equal(ownerKey(owner), 'codex:thread:thread-tui');

  const underAnotherTui = procs.tree([
    SELF,
    SHELL,
    `${DAEMON_BIN} app-server --listen unix:// --managed-daemon`,
    'codex',
    '-zsh',
  ]);
  assert.equal(resolveOwner(ENV, procs, underAnotherTui[0]?.pid).process, null);
});

test('a Codex daemon is recognised by its argv when CODEX_HOME is elsewhere, and by its install path whatever its argv', () => {
  const elsewhere = '/opt/codex-home';
  const info = (command: string) => ({ pid: 2, ppid: 1, start: 's', command });
  assert.equal(isCodexDaemon(info('/usr/local/bin/codex app-server --listen unix:// --managed-daemon'), elsewhere), true);
  assert.equal(isCodexDaemon(info('/usr/local/bin/codex app-server --listen unix://'), elsewhere), true);
  assert.equal(isCodexDaemon(info('codex app-server --managed-daemon'), elsewhere), true);
  assert.equal(isCodexDaemon(info(`${DAEMON_BIN} app-server daemon pid-update-loop`), `${HOME}/.codex`), true);
  assert.equal(isCodexDaemon(info(`${DAEMON_BIN} app-server daemon pid-update-loop`), elsewhere), false);
  assert.equal(isCodexDaemon(info('/usr/local/bin/codex app-server --listen ws://127.0.0.1:4500'), elsewhere), false);
  assert.equal(isCodexDaemon(info('/usr/local/bin/codex exec --listen unix://'), elsewhere), false);
  assert.equal(isCodexDaemon(info('/usr/local/bin/not-codex app-server --managed-daemon'), elsewhere), false);
  assert.equal(codexHome({ HOME }), `${HOME}/.codex`);
  assert.equal(codexHome({ HOME, CODEX_HOME: elsewhere }), elsewhere);

  const procs = new FakeProcesses();
  const chain = procs.tree([SELF, SHELL, '/usr/local/bin/codex app-server --listen unix://', 'codex']);
  assert.equal(resolveOwner({ CODEX_THREAD_ID: 't', CODEX_HOME: elsewhere }, procs, chain[0]?.pid).process, null);
});

test('codex exec runs its own app server, so the exec process is the owner, proven dead once it exits', async () => {
  const w = world();
  try {
    const [self, , exec] = w.procs.tree([SELF, SHELL, '/opt/homebrew/bin/codex exec --full-auto "run the flows"', '-zsh']);
    const owner = resolveOwner({ CODEX_THREAD_ID: 'thread-exec', HOME }, w.procs, self?.pid);
    assert.deepEqual(owner.process, exec);
    const lane = await w.registry().claim(w.request(owner, w.folder('exec')));
    assert.equal(w.registry().status().lanes[0]?.ownerState, 'alive');

    w.procs.kill(exec?.pid ?? 0);
    assert.equal(w.registry().status().lanes[0]?.ownerState, 'dead');
    const next = await w.registry().claim(w.request(w.procs.owner(), w.folder('next')));
    assert.deepEqual(
      next.freed.map(f => [f.id, f.reason]),
      [[lane.lane.id, 'dead']],
    );
  } finally {
    w.close();
  }
});

test('the VS Code extension and the desktop app run a stdio app server, which is kept as the owner', () => {
  const procs = new FakeProcesses();
  const [vsSelf, , vsServer] = procs.tree([
    SELF,
    SHELL,
    `${HOME}/.vscode/extensions/openai.chatgpt-26.5.1-darwin-arm64/bin/macos-aarch64/codex app-server --analytics-default-enabled`,
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  ]);
  assert.deepEqual(resolveOwner({ CODEX_THREAD_ID: 'thread-vscode', HOME }, procs, vsSelf?.pid), {
    kind: 'codex',
    process: vsServer,
    sessionId: null,
    threadId: 'thread-vscode',
  });

  const [appSelf, , appServer] = procs.tree([
    SELF,
    SHELL,
    '/Applications/Codex.app/Contents/Resources/codex app-server',
    '/Applications/Codex.app/Contents/MacOS/Codex',
  ]);
  assert.deepEqual(resolveOwner({ CODEX_THREAD_ID: 'thread-app', HOME }, procs, appSelf?.pid).process, appServer);
});

test("a TUI thread's lane is can't tell: never freed by the sweep, taken over when idle under pressure, with the taker told whose it was", async () => {
  const w = world({ poolSize: 1 });
  try {
    const [self] = w.procs.tree([SELF, SHELL, `${DAEMON_BIN} app-server --listen unix:// --managed-daemon`]);
    const tui = resolveOwner(ENV, w.procs, self?.pid);
    const held = await w.registry().claim(w.request(tui, w.folder('tui')));
    assert.equal(w.registry().status().lanes[0]?.ownerState, 'cant-tell');

    await w.clock.advance(HOUR_MS);
    await assert.rejects(w.registry().claim(w.request(w.procs.owner(), w.folder('early'))), { code: 'pool-busy' });
    assert.equal(w.registry().status().lanes.length, 1);

    await w.clock.advance(HOUR_MS + 60_000);
    const taker = await w.registry().claim(w.request(w.procs.owner(), w.folder('taker')));
    assert.deepEqual(taker.freed, []);
    assert.deepEqual(
      taker.tookOver.map(e => [e.id, e.reason, e.owner]),
      [[held.lane.id, 'taken-over', 'codex thread thread-tui (no process recorded)']],
    );
    assert.equal(taker.lane.device?.id, held.lane.device?.id);
  } finally {
    w.close();
  }
});

test('the nearest session process owns the lane when Claude Code and Codex run inside each other, and a daemon still means the thread', () => {
  const procs = new FakeProcesses();
  const [execSelf, , exec, , outerClaude] = procs.tree([
    SELF,
    SHELL,
    '/opt/homebrew/bin/codex exec "check the flows"',
    '/bin/zsh -c codex exec',
    'claude',
  ]);
  const execOwner = resolveOwner(
    { CLAUDE_PID: String(outerClaude?.pid), CODEX_THREAD_ID: 'thread-in-claude', HOME },
    procs,
    execSelf?.pid,
  );
  assert.deepEqual([execOwner.kind, execOwner.process, execOwner.threadId], ['codex', exec, 'thread-in-claude']);

  const [claudeSelf, , innerClaude] = procs.tree([
    SELF,
    SHELL,
    'claude -p "run the flows"',
    SHELL,
    '/opt/homebrew/bin/codex exec',
  ]);
  const claudeOwner = resolveOwner(
    { CLAUDE_PID: String(innerClaude?.pid), CODEX_THREAD_ID: 'outer-thread', CLAUDE_CODE_SESSION_ID: 'inner', HOME },
    procs,
    claudeSelf?.pid,
  );
  assert.deepEqual([claudeOwner.kind, claudeOwner.process, claudeOwner.sessionId], ['claude', innerClaude, 'inner']);

  const [daemonSelf] = procs.tree([SELF, SHELL, `${DAEMON_BIN} app-server --listen unix:// --managed-daemon`, 'claude']);
  assert.deepEqual(
    resolveOwner({ CLAUDE_PID: String(outerClaude?.pid), CODEX_THREAD_ID: 'thread-tui', HOME }, procs, daemonSelf?.pid),
    { kind: 'codex', process: null, sessionId: null, threadId: 'thread-tui' },
  );
});

test('with only one session variable set, an ancestor of the other kind does not own the lane', () => {
  const procs = new FakeProcesses();
  const [codexSelf] = procs.tree([SELF, SHELL, 'claude']);
  assert.deepEqual(resolveOwner({ CODEX_THREAD_ID: 'thread-alone', HOME }, procs, codexSelf?.pid), {
    kind: 'codex',
    process: null,
    sessionId: null,
    threadId: 'thread-alone',
  });
  const [claudeSelf, , claude] = procs.tree([SELF, SHELL, 'claude', '/opt/homebrew/bin/codex exec']);
  const owner = resolveOwner({ CLAUDE_PID: String(claude?.pid), HOME }, procs, claudeSelf?.pid);
  assert.deepEqual([owner.kind, owner.process], ['claude', claude]);
});
