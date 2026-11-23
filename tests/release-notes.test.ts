import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const script = path.join(root, '.github/scripts/release-notes.sh');
const latestScript = path.join(root, '.github/scripts/release-latest.sh');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

function notes(version: string, file?: string) {
  return spawnSync(script, file ? [version, file] : [version], { encoding: 'utf8' });
}

function changelogFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlane-release-notes-'));
  const file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(file, text);
  return file;
}

function between(start: string, end: string): string {
  const from = changelog.indexOf(start) + start.length;
  return changelog.slice(from, changelog.indexOf(end, from)).trim() + '\n';
}

function latest(version: string, tags: string[]): string {
  const run = spawnSync(latestScript, [version], { encoding: 'utf8', input: tags.join('\n') + '\n' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
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

test('a release candidate takes the Unreleased section when its version has none', () => {
  const file = changelogFile('# Changelog\n\n## Unreleased\n\n- Coming.\n\n## 0.4.0\n\n- Shipped.\n');
  const run = notes('0.4.1-rc.1', file);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '- Coming.\n');
});

test('a release candidate prefers its version section over Unreleased', () => {
  const file = changelogFile('## Unreleased\n\n- Later.\n\n## 0.4.1\n\n- This one.\n');
  const run = notes('0.4.1-rc.1', file);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '- This one.\n');
});

test('a stable version does not take the Unreleased section', () => {
  const file = changelogFile('## Unreleased\n\n- Coming.\n\n## 0.4.0\n\n- Shipped.\n');
  const run = notes('0.4.1', file);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /has no section for 0\.4\.1\n$/);
});

test('a release candidate with neither section fails naming both', () => {
  const file = changelogFile('## 0.4.0\n\n- Shipped.\n');
  const run = notes('0.4.1-rc.1', file);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /has no section for 0\.4\.1 or Unreleased/);
});

const rcTag = 'v0.4.1-rc.1';
const rcTagMissing = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${rcTag}^{}`]).status !== 0;

test(`${rcTag} gets notes from the changelog it was tagged with`, { skip: rcTagMissing && `${rcTag} isn't fetched` }, () => {
  const tagged = spawnSync('git', ['-C', root, 'show', `${rcTag}:CHANGELOG.md`], { encoding: 'utf8' }).stdout;
  const run = notes('0.4.1-rc.1', changelogFile(tagged));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^### Changed\n\n- \*\*`init` in a terminal is a proper TUI\.\*\*/);
  assert.doesNotMatch(run.stdout, /## 0\.4\.0/);
});

test('a heading inside a fenced block does not end the section', () => {
  for (const fence of ['```', '~~~']) {
    const body = `- Run this:\n\n${fence}sh\n## not a heading\n${fence}\n\n- After the fence.\n`;
    const file = changelogFile(`## 0.6.1\n\n${body}\n## 0.6.0\n\n- Older.\n`);
    const run = notes('0.6.1', file);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, body);
  }
});

test('a fence closes only with its own character, at least as long, with nothing after it', () => {
  const body = [
    '````md\n```\n## inside\n```\n````\n',
    '~~~~\n~~~ not a close\n## inside\n~~~~\n',
    '  ```sh\n## inside\n   ```  \n',
  ].join('\n');
  const file = changelogFile(`## 0.6.1\n\n${body}\n- After the fences.\n\n## 0.6.0\n\n- Older.\n`);
  const run = notes('0.6.1', file);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `${body}\n- After the fences.\n`);
});

test('a code fence never closed fails the release, whichever section it is in', () => {
  const older = '## 0.6.0\n\n- Older.\n';
  for (const [version, text] of [
    ['0.6.1', `## 0.6.1\n\n\`\`\`sh\n## x\n\n${older}`],
    ['0.6.1', `## 0.6.1\n\n- Fine.\n\n${older}\n\`\`\`\nopen\n`],
    ['0.6.1', `## Unreleased\n\n\`\`\`\nopen\n\n## 0.6.1\n\n- Wanted.\n`],
    ['0.6.1', `## 0.6.1\n\n\`\`\`\`\n\`\`\`\n\n${older}`],
  ] as const) {
    const file = changelogFile(text);
    const run = notes(version, file);
    assert.equal(run.status, 1, text);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, `${file} has a code fence that is never closed\n`);
  }
});

test('a stable version with no section fails naming the version', () => {
  const run = notes('9.9.9');
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /has no section for 9\.9\.9\n$/);
});

test('a stable version is Latest only when it is the highest stable tag', () => {
  const tags = ['v0.4.0-rc.1', 'v0.5.1', 'v0.6.0', 'v0.6.1', 'v0.6.1-rc.1', 'maestro-1.0.0'];
  assert.equal(latest('0.6.1', tags), 'true\n');
  assert.equal(latest('0.5.2', [...tags, 'v0.5.2']), 'false\n');
  assert.equal(latest('0.6.10', [...tags, 'v0.6.10']), 'true\n');
  assert.equal(latest('0.7.0', ['v0.7.0-rc.1', ...tags]), 'true\n');
  assert.equal(latest('0.6.1', [...tags, 'v0.10.0']), 'false\n');
  assert.equal(latest('0.6.1', []), 'true\n');
});

test('a pre-release is never Latest', () => {
  assert.equal(latest('0.7.0-rc.1', ['v0.6.1', 'v0.7.0-rc.1']), 'false\n');
  assert.equal(latest('0.7.0-rc.1', []), 'false\n');
});

test('Latest reads the lines git ls-remote prints for the tags', () => {
  const lines = (...tags: string[]) => tags.map((tag, i) => `${String(i).padStart(40, '0')}\trefs/tags/${tag}`);
  assert.equal(latest('0.6.1', lines('v0.5.1', 'v0.6.1')), 'true\n');
  assert.equal(latest('0.5.9', lines('v0.5.9', 'v0.6.1')), 'false\n');
});
