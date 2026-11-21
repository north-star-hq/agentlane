import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runCheck, runHook } from '../../src/hooks/run.ts';
import { tempDir } from '../support/fakes.ts';

type HookOptions = Parameters<typeof runHook>[2];

const RUN = pathToFileURL(path.join(import.meta.dirname, '..', '..', 'src', 'hooks', 'run.ts')).href;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Ctrl-C on the process running a check, such as a precondition under up, ends the check with it', async () => {
  const dir = tempDir('check-sigint');
  const pidFile = path.join(dir, 'check.pid');
  const check = `echo $$ > '${pidFile}'; exec sleep 100`;
  const script = `const { runCheck } = await import(${JSON.stringify(RUN)});
await runCheck(${JSON.stringify(check)}, { cwd: ${JSON.stringify(dir)}, env: process.env, timeoutMs: 30_000 });`;
  const job = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: 'ignore' });
  const exited = new Promise(resolve => {
    job.once('exit', (code, signal) => {
      resolve(signal ?? code);
    });
  });
  let checkPid = 0;
  try {
    assert.ok(job.pid !== undefined);
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    checkPid = Number(fs.readFileSync(pidFile, 'utf8'));
    process.kill(-job.pid, 'SIGINT');
    assert.equal(await exited, 'SIGINT');
    await until(() => !alive(checkPid), 2000).catch(() => undefined);
    assert.equal(alive(checkPid), false, 'the check got the SIGINT of the job it runs in');
  } finally {
    if (checkPid > 0 && alive(checkPid)) process.kill(checkPid, 'SIGKILL');
    if (job.exitCode === null && job.signalCode === null) job.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a check in a process group of its own is ended whole at its timeout, with what it left holding its output', async () => {
  const dir = tempDir('check-group');
  try {
    const run = await runCheck('sleep 30 & echo $!; exit 3', { cwd: dir, env: process.env, timeoutMs: 300, ownGroup: true });
    const left = Number(run.output);
    assert.equal(run.code, 3);
    assert.ok(run.ms < 5000, `it returned at its timeout (${String(run.ms)} ms)`);
    await until(() => !alive(left), 2000).catch(() => undefined);
    assert.equal(alive(left), false, 'the process it left holding its output was ended');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fenced hook has a timeout, so its shell, whose pid it is given before the command runs, leads its process group', async () => {
  const dir = tempDir('fenced');
  const log = path.join(dir, 'log');
  const group = path.join(dir, 'pgid');
  try {
    const given: number[] = [];
    const fenced: HookOptions = { cwd: dir, env: process.env, log, timeoutMs: 5000, beforeRun: pid => given.push(pid) };
    await runHook('fenced', `ps -o pgid= -p $$ > '${group}'`, fenced);
    assert.equal(given.length, 1);
    assert.equal(Number(fs.readFileSync(group, 'utf8').trim()), given[0]);

    const options = (o: HookOptions) => o;
    // @ts-expect-error: beforeRun comes only with timeoutMs
    options({ cwd: dir, env: process.env, log, beforeRun: () => undefined });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
