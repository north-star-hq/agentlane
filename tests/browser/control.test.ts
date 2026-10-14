import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentBrowserControl, playwrightControl, type DriverRun } from '../../src/browser/control.ts';

function answering(answers: Record<string, string>): DriverRun {
  return args => {
    const stdout = answers[args.join(' ')];
    const ran = { signal: null, error: undefined };
    return Promise.resolve(
      stdout === undefined ? { ...ran, code: 1, stdout: '', stderr: 'unknown command' } : { ...ran, code: 0, stdout, stderr: '' },
    );
  };
}

test("agent-browser's session is open when its JSON session list names it, as agent-browser 0.39.0 prints it", async () => {
  const session = 'agentlane-1a2b3c4d';
  const list = (sessions: string[]) => JSON.stringify({ success: true, data: { sessions } });
  assert.equal(await agentBrowserControl(answering({ '--json session list': list([session]) }), session).isOpen(), true);
  assert.equal(await agentBrowserControl(answering({ '--json session list': list([]) }), session).isOpen(), false);
  assert.equal(
    await agentBrowserControl(answering({ '--json session list': list(['agentlane-ffffffff']) }), session).isOpen(),
    false,
    "another lane's session is not this one",
  );
  assert.equal(await agentBrowserControl(answering({ '--json session list': 'not json' }), session).isOpen(), false);
  assert.equal(await agentBrowserControl(answering({}), session).isOpen(), false);
});

test("a stopped Playwright trace is kept with its network log, its stacks and the screencast frames it names, and no other trace's frames", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlane-trace-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  const traces = path.join(root, 'claim', 'browser', 'output', 'traces');
  fs.mkdirSync(path.join(traces, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(traces, 'screencast'), { recursive: true });
  fs.mkdirSync(project);
  const frame = (name: string) =>
    `{"type":"screencast-frame","pageId":"page@1","file":"screencast/${name}","width":1280,"height":720}`;
  fs.writeFileSync(path.join(traces, 'trace-2.trace'), `{"version":8}\n${frame('page@1-20.jpeg')}\n${frame('page@1-21.jpeg')}\n`);
  fs.writeFileSync(path.join(traces, 'trace-2.network'), '');
  fs.writeFileSync(path.join(traces, 'trace-2.stacks'), '{}');
  fs.writeFileSync(path.join(traces, 'resources', 'abc123.html'), '<html></html>');
  for (const name of ['page@1-10.jpeg', 'page@1-20.jpeg', 'page@1-21.jpeg'])
    fs.writeFileSync(path.join(traces, 'screencast', name), name);
  const relative = path.relative(project, traces);
  const stopped = [
    '### Result',
    'Trace recording stopped.',
    `- [Trace](${relative}/trace-2.trace)`,
    `- [Network log](${relative}/trace-2.network)`,
    `- [Resources](${relative}/resources)`,
  ].join('\n');
  const into = path.join(root, 'claim', 'evidence', 'failed', 'trace');
  const kept = await playwrightControl(answering({ 'tracing-stop': stopped }), project).traceStop(into);
  assert.deepEqual(kept.map(file => path.relative(into, file)).sort(), [
    'resources',
    'screencast/page@1-20.jpeg',
    'screencast/page@1-21.jpeg',
    'trace-2.network',
    'trace-2.stacks',
    'trace-2.trace',
  ]);
  assert.equal(fs.readFileSync(path.join(into, 'resources', 'abc123.html'), 'utf8'), '<html></html>');
  assert.equal(fs.existsSync(path.join(into, 'screencast', 'page@1-10.jpeg')), false, "an earlier trace's frame was kept");
});

test('a trace start on a Playwright session that already traces ends that trace and starts a new one, and any other failure names a way out', async () => {
  let tracing = true;
  const calls: string[] = [];
  const said = (code: number, stdout: string) => ({ code, stdout, stderr: '', signal: null, error: undefined });
  const run: DriverRun = args => {
    const command = args.join(' ');
    calls.push(command);
    if (command === 'tracing-start') {
      if (tracing) return Promise.resolve(said(1, '### Error\nError: Tracing has already been started.\n'));
      tracing = true;
      return Promise.resolve(said(0, '### Result\nTrace recording started.\n'));
    }
    if (command === 'tracing-stop') {
      tracing = false;
      return Promise.resolve(said(0, '### Result\nTrace recording stopped.\n'));
    }
    return Promise.resolve(said(1, '### Error\nError: Target page, context or browser has been closed\n'));
  };
  const control = playwrightControl(run, os.tmpdir());
  await control.traceStart();
  assert.deepEqual(calls, ['tracing-start', 'tracing-stop', 'tracing-start']);
  assert.equal(tracing, true);
  calls.length = 0;
  tracing = false;
  await control.traceStart();
  assert.deepEqual(calls, ['tracing-start'], 'a session that traces nothing starts its trace at once');
  await assert.rejects(control.open('http://localhost:1/'), (error: Error) => {
    assert.match(error.message, /playwright-cli open http:\/\/localhost:1\/ exited 1:\n### Error\nError: Target page/);
    assert.match(
      error.message,
      /to fix: node_modules\/\.bin\/agentlane doctor names what is wrong with the lane's browser or its web app; when it reports ready, close the browser with node_modules\/\.bin\/agentlane exec -- playwright-cli close, and node_modules\/\.bin\/agentlane up opens a new one$/,
    );
    return true;
  });
});
