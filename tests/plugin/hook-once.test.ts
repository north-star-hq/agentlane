import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { claimOnce, ONCE_WINDOW_MS } from '../../src/plugin/hook-once.ts';
import { tempDir } from '../support/fakes.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function claimFiles(dir: string): string[] {
  return fs.readdirSync(path.join(dir, 'hook-once')).map(name => path.join(dir, 'hook-once', name));
}

test('a claim is won once within its window, again after it, and other work claims apart', () => {
  const dir = tempDir('hook-once');
  try {
    const at = Date.UTC(2026, 10, 10, 9, 0, 0);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at), true);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at + 1000), false);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:2:b'], at + 1000), true);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at + ONCE_WINDOW_MS + 1), true);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at + ONCE_WINDOW_MS + 2), false);
    assert.equal(claimFiles(dir).length, 2, 'a later claim on the same work replaces the earlier one');
    assert.equal(claimOnce(dir, ['session-end', 't', 'claude:3:c'], at + DAY_MS + 3 * ONCE_WINDOW_MS), true);
    assert.equal(claimFiles(dir).length, 1, 'claims a day old are swept');
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

test('an empty claim file, as a copy killed while claiming leaves, blocks the work only until its window passes', () => {
  const dir = tempDir('hook-once-empty');
  try {
    const at = Date.UTC(2026, 10, 10, 9, 0, 0);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at), true);
    const [file] = claimFiles(dir);
    assert.ok(file);
    fs.writeFileSync(file, '');
    fs.utimesSync(file, at / 1000, at / 1000);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at + 1000), false);
    assert.equal(claimOnce(dir, ['session-end', 's', 'claude:1:a'], at + ONCE_WINDOW_MS + 1), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type Patchable = Record<'statSync' | 'readdirSync' | 'writeFileSync' | 'utimesSync' | 'rmSync' | 'readFileSync', unknown>;
const PATCHED = ['statSync', 'readdirSync', 'writeFileSync', 'utimesSync', 'rmSync', 'readFileSync'] as const;

/** Runs `a`, and runs `b` once, right after a's `at`-th call into `fs`; returns how many file calls `a` made. */
function interleave(at: number, a: () => void, b: () => void): number {
  const target = fs as unknown as Patchable;
  const originals = PATCHED.map(name => target[name] as (...args: unknown[]) => unknown);
  let calls = 0;
  let inB = false;
  PATCHED.forEach((name, i) => {
    target[name] = (...args: unknown[]) => {
      const result = originals[i]?.(...args);
      if (!inB && calls++ === at) {
        inB = true;
        b();
      }
      return result;
    };
  });
  try {
    a();
  } finally {
    PATCHED.forEach((name, i) => (target[name] = originals[i]));
  }
  return calls;
}

test('two callers over a stale claim leave one winner however their file calls interleave', () => {
  const parts = ['session-end', 's', 'claude:1:a'];
  const now = Date.now();
  const race = (at: number): { won: boolean[]; calls: number } => {
    const dir = tempDir('hook-once-race');
    try {
      assert.equal(claimOnce(dir, parts, now - 3 * ONCE_WINDOW_MS), true);
      const won: boolean[] = [];
      const calls = interleave(
        at,
        () => won.unshift(claimOnce(dir, parts, now)),
        () => won.push(claimOnce(dir, parts, now)),
      );
      assert.equal(claimOnce(dir, parts, now + 1000), false, 'the winner’s claim holds');
      return { won, calls };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const alone = race(Number.POSITIVE_INFINITY);
  assert.deepEqual(alone.won, [true]);
  assert.ok(alone.calls > 3, `the first caller made ${String(alone.calls)} file calls`);
  for (let at = 0; at < alone.calls; at++) {
    const { won } = race(at);
    assert.equal(won.length, 2);
    assert.equal(won.filter(Boolean).length, 1, `with the second caller after the first's call ${String(at)}: ${won.join(',')}`);
  }
});
