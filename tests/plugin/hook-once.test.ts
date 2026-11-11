import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { claimOnce, ONCE_WINDOW_MS } from '../../src/plugin/hook-once.ts';
import { tempDir } from '../support/fakes.ts';

test('a claim is won once within its window, again after it, and other work claims apart', () => {
  const dir = tempDir('hook-once');
  try {
    const at = Date.UTC(2026, 10, 10, 9, 0, 0);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at), true);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at + 1000), false);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:2:b'], at + 1000), true);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at + ONCE_WINDOW_MS + 1), true);
    assert.equal(fs.readdirSync(path.join(dir, 'hook-once')).length, 2);
    assert.equal(claimOnce(dir, ['session-end', 't', 'claude:3:c'], at + 3 * ONCE_WINDOW_MS), true);
    assert.equal(fs.readdirSync(path.join(dir, 'hook-once')).length, 1, 'expired claims are swept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim that cannot be written counts as won, so the work still runs', () => {
  const dir = tempDir('hook-once-unwritable');
  try {
    fs.writeFileSync(path.join(dir, 'hook-once'), 'not a folder');
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], Date.now()), true);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], Date.now()), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
