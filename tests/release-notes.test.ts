import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const script = path.join(root, '.github/scripts/release-notes.sh');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

function notes(version: string) {
  return spawnSync(script, [version], { encoding: 'utf8' });
}

function between(start: string, end: string): string {
  const from = changelog.indexOf(start) + start.length;
  return changelog.slice(from, changelog.indexOf(end, from)).trim() + '\n';
}

test('a version gets its changelog section without the heading', () => {
  for (const [version, expected] of [
    ['0.6.1', between('## 0.6.1\n', '\n## 0.6.0\n')],
    ['0.6.0', between('## 0.6.0\n', '\n## 0.5.1\n')],
  ] as const) {
    const run = notes(version);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, expected);
  }
});

test('a release candidate gets the section of the version it leads to', () => {
  const run = notes('0.6.1-rc.1');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, notes('0.6.1').stdout);
});

test('a stable version with no section fails naming the version', () => {
  const run = notes('9.9.9');
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /has no section for 9\.9\.9\n$/);
});
