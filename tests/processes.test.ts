import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cwdOfProcLink, systemProcesses } from '../src/processes.ts';
import { tempDir } from './support/fakes.ts';

test('a Linux /proc cwd link of a deleted folder names the folder, so its service is still judged to run there', () => {
  assert.equal(cwdOfProcLink('/tmp/lane/repo (deleted)'), '/tmp/lane/repo');
  assert.equal(cwdOfProcLink('/tmp/lane/repo'), '/tmp/lane/repo');
  assert.equal(cwdOfProcLink('/tmp/a (deleted) b'), '/tmp/a (deleted) b');
});

test(
  'a running process whose working folder was deleted is still read as in that folder',
  { skip: process.platform !== 'linux' && process.platform !== 'darwin' },
  async () => {
    const dir = path.join(fs.realpathSync(tempDir('cwd')), 'repo');
    fs.mkdirSync(dir);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { cwd: dir, stdio: 'ignore' });
    try {
      await new Promise(resolve => child.once('spawn', resolve));
      assert.equal(systemProcesses.cwd(child.pid ?? 0), dir);
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(systemProcesses.cwd(child.pid ?? 0), dir);
    } finally {
      child.kill('SIGKILL');
    }
  },
);
