import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { keepNewestBackups, keepNewestLines, rotateLog } from '../src/disk-limits.ts';
import { enginePaths } from '../src/driver/paths.ts';
import { RECORDED_STEPS_LIMIT } from '../src/driver/session.ts';
import { laneEvidence } from '../src/evidence/evidence.ts';
import { inodeOf, readFrom, sizeOf } from '../src/evidence/files.ts';
import { tempDir } from './support/fakes.ts';
import { hermeticEnv } from './support/hermetic.ts';

function jsonLines(file: string): unknown[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as unknown);
}

function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const at = path.join(dir, entry);
    if (fs.statSync(at).isFile()) out[entry] = fs.readFileSync(at, 'base64');
  }
  return out;
}

test('a JSONL file past its limit keeps its newest whole lines, and every line left parses', () => {
  const root = tempDir('lines');
  try {
    const file = path.join(root, 'steps.jsonl');
    const limit = { maxBytes: 4000, keepBytes: 1000 };
    for (let n = 0; n < 100; n++) fs.appendFileSync(file, `${JSON.stringify({ n, pad: 'x'.repeat(n % 7) })}\n`);
    assert.equal(keepNewestLines(file, limit), false, 'under the limit nothing is cut');
    for (let n = 100; n < 200; n++) fs.appendFileSync(file, `${JSON.stringify({ n, pad: 'x'.repeat(n % 7) })}\n`);
    assert.ok(sizeOf(file) > limit.maxBytes);
    assert.equal(keepNewestLines(file, limit), true);
    assert.ok(sizeOf(file) <= limit.keepBytes, String(sizeOf(file)));
    const kept = jsonLines(file) as { n: number }[];
    assert.equal(kept.at(-1)?.n, 199, 'the newest entry stays');
    assert.deepEqual(
      kept.map(entry => entry.n),
      Array.from({ length: kept.length }, (_, i) => 200 - kept.length + i),
      'the kept entries are the newest, in order, with none skipped',
    );
    assert.deepEqual(
      fs.readdirSync(root).filter(name => name !== 'steps.jsonl'),
      [],
      'the cut leaves no file beside it',
    );

    fs.writeFileSync(file, `${JSON.stringify({ old: true })}\n${JSON.stringify({ big: 'y'.repeat(5000) })}\n`);
    keepNewestLines(file, limit);
    assert.deepEqual(jsonLines(file), [{ big: 'y'.repeat(5000) }], 'a newest line longer than the keep stays whole');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a device trace stopped after a cut of the recorded steps still reads whole lines, from the cut file's start", () => {
  const root = tempDir('trace-cut');
  try {
    const file = path.join(root, 'steps.jsonl');
    const limit = { maxBytes: 2000, keepBytes: 600 };
    for (let n = 0; n < 10; n++) fs.appendFileSync(file, `${JSON.stringify({ n })}\n`);
    const start = { bytes: sizeOf(file), ino: inodeOf(file) };
    assert.equal(readFrom(file, start.bytes, start.ino), '');
    fs.appendFileSync(file, `${JSON.stringify({ n: 10 })}\n`);
    assert.equal(readFrom(file, start.bytes, start.ino), '{"n":10}\n', 'an unreplaced file reads from the offset');
    for (let n = 11; n < 400; n++) fs.appendFileSync(file, `${JSON.stringify({ n })}\n`);
    assert.equal(keepNewestLines(file, limit), true);
    const read = readFrom(file, start.bytes, start.ino);
    assert.ok(read.startsWith('{"n":'), read.slice(0, 20));
    const lines = read.split('\n').filter(Boolean);
    assert.ok(lines.every(line => typeof (JSON.parse(line) as { n: number }).n === 'number'));
    assert.equal((JSON.parse(lines.at(-1) ?? '') as { n: number }).n, 399);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rotated log keeps its previous generation, and a writer holding the old file keeps writing into it', () => {
  const root = tempDir('rotate');
  try {
    const log = path.join(root, 'session-end.log');
    fs.writeFileSync(log, 'first generation\n');
    assert.equal(rotateLog(log, 100), false, 'under the limit nothing moves');
    const held = fs.openSync(log, 'a');
    fs.appendFileSync(log, `${'a'.repeat(200)}\n`);
    assert.equal(rotateLog(log, 100), true);
    assert.equal(fs.existsSync(log), false);
    fs.writeSync(held, 'written by the worker that opened it before the rotation\n');
    fs.closeSync(held);
    fs.appendFileSync(log, 'second generation\n');
    assert.match(fs.readFileSync(`${log}.1`, 'utf8'), /^first generation\na+\nwritten by the worker that opened it/);
    assert.equal(fs.readFileSync(log, 'utf8'), 'second generation\n');

    fs.appendFileSync(log, `${'b'.repeat(200)}\n`);
    fs.writeFileSync(`${log}.rotating`, '');
    assert.equal(rotateLog(log, 100), false, 'one process rotates at a time');
    assert.match(fs.readFileSync(`${log}.1`, 'utf8'), /^first generation/, 'the generation another rotator owns stays');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${log}.rotating`, old, old);
    assert.equal(rotateLog(log, 100), false, 'a stale rotation lock is broken');
    assert.equal(fs.existsSync(`${log}.rotating`), false);
    assert.equal(rotateLog(log, 100), true);
    assert.match(fs.readFileSync(`${log}.1`, 'utf8'), /^second generation\nb+\n$/);
    assert.equal(fs.existsSync(`${log}.rotating`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("init backups keep a project's newest five and leave other projects' and other folders alone", () => {
  const root = tempDir('backups');
  try {
    const dir = path.join(root, 'init-backups');
    const stamp = (day: number) => `2026-10-${String(day).padStart(2, '0')}T09-00-00-000Z`;
    for (let day = 1; day <= 8; day++) fs.mkdirSync(path.join(dir, `${stamp(day)}-app`, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, `${stamp(1)}-other-app`));
    fs.mkdirSync(path.join(dir, `${stamp(2)}-app-two`));
    fs.mkdirSync(path.join(dir, 'notes'));
    const removed = keepNewestBackups(dir, 'app', 5);
    assert.deepEqual(removed.map(at => path.basename(at)).sort(), [`${stamp(1)}-app`, `${stamp(2)}-app`, `${stamp(3)}-app`]);
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      `${stamp(1)}-other-app`,
      `${stamp(2)}-app-two`,
      `${stamp(4)}-app`,
      `${stamp(5)}-app`,
      `${stamp(6)}-app`,
      `${stamp(7)}-app`,
      `${stamp(8)}-app`,
      'notes',
    ]);
    assert.deepEqual(keepNewestBackups(path.join(root, 'missing'), 'app', 5), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no limit touches a lane evidence folder', () => {
  const root = tempDir('evidence-kept');
  try {
    const state = hermeticEnv(root).AGENTLANE_STATE_DIR ?? '';
    const laneId = 'abcd1234';
    const evidence = laneEvidence(state, laneId);
    const trace = path.join(evidence, '2026-10-13T09-00-00-000Z-trace-device');
    fs.mkdirSync(trace, { recursive: true });
    fs.writeFileSync(path.join(trace, 'flows.jsonl'), `${JSON.stringify({ yaml: '- tapOn: x\n' })}\n`.repeat(40_000));
    fs.writeFileSync(path.join(trace, 'driver.log'), 'z'.repeat(6 * 1024 * 1024));
    fs.writeFileSync(path.join(evidence, '2026-10-13T09-00-00-000Z-screenshot-device.png'), 'png');
    fs.mkdirSync(path.join(state, 'init-backups', '2026-10-13T09-00-00-000Z-evidence'), { recursive: true });
    const before = treeOf(evidence);

    const steps = enginePaths(state, laneId).steps;
    fs.mkdirSync(path.dirname(steps), { recursive: true });
    fs.writeFileSync(steps, `${JSON.stringify({ yaml: '- tapOn: y\n' })}\n`.repeat(70_000));
    assert.equal(keepNewestLines(steps, RECORDED_STEPS_LIMIT), true);
    const log = path.join(state, 'session-end.log');
    fs.writeFileSync(log, 'w'.repeat(2 * 1024 * 1024));
    assert.equal(rotateLog(log, 1024 * 1024), true);
    keepNewestBackups(path.join(state, 'init-backups'), 'evidence', 0);

    assert.deepEqual(treeOf(evidence), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
