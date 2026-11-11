import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detachedWorker, SESSION_END_LOG_MAX_BYTES } from '../../src/plugin/hook-cli.ts';
import { tempDir } from '../support/fakes.ts';
import { hermeticEnv } from '../support/hermetic.ts';

test('session-end.log past its limit moves to .1 before the next worker starts, and the worker writes a fresh log', async () => {
  const root = tempDir('session-end-log');
  try {
    const env = hermeticEnv(root);
    const log = path.join(env.AGENTLANE_STATE_DIR ?? '', 'session-end.log');
    const worker = path.join(root, 'worker.mjs');
    fs.writeFileSync(worker, "console.log(`released lane abcd1234 of ${process.argv.slice(2).join(' ')}`);\n");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const earlier = `released lane 00000000 of process 1\n${'x'.repeat(SESSION_END_LOG_MAX_BYTES)}\n`;
    fs.writeFileSync(log, earlier);

    detachedWorker(worker)(env, log);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('\n')))
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.readFileSync(log, 'utf8'), 'released lane abcd1234 of hook session-end\n');
    assert.equal(fs.readFileSync(`${log}.1`, 'utf8'), earlier);

    detachedWorker(worker)(env, log);
    const again = Date.now() + 10_000;
    while (Date.now() < again && fs.readFileSync(log, 'utf8').split('\n').length < 3)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(
      fs.readFileSync(log, 'utf8'),
      'released lane abcd1234 of hook session-end\n'.repeat(2),
      'a log under the limit grows',
    );
    assert.equal(fs.readFileSync(`${log}.1`, 'utf8'), earlier);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
