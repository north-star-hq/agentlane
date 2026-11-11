import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { backupProject, keepNewestBackups, keepNewestLinesAsSoleWriter, rotateLog } from '../src/disk-limits.ts';
import { enginePaths, pruneDriverFiles } from '../src/driver/paths.ts';
import { RECORDED_STEPS_LIMIT } from '../src/driver/session.ts';
import { laneEvidence } from '../src/evidence/evidence.ts';
import { inodeOf, runsSince, sizeOf } from '../src/evidence/files.ts';
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
    assert.equal(keepNewestLinesAsSoleWriter(file, limit), false, 'under the limit nothing is cut');
    for (let n = 100; n < 200; n++) fs.appendFileSync(file, `${JSON.stringify({ n, pad: 'x'.repeat(n % 7) })}\n`);
    assert.ok(sizeOf(file) > limit.maxBytes);
    assert.equal(keepNewestLinesAsSoleWriter(file, limit), true);
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
    keepNewestLinesAsSoleWriter(file, limit);
    assert.deepEqual(jsonLines(file), [{ big: 'y'.repeat(5000) }], 'a newest line longer than the keep stays whole');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runsOf(text: string): { n: number }[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { n: number });
}

test('a device trace stopped after a cut holds only the runs recorded after its start, though the cut kept older ones', () => {
  const root = tempDir('trace-cut');
  try {
    const file = path.join(root, 'steps.jsonl');
    const limit = { maxBytes: 1500, keepBytes: 600 };
    const run = (n: number, at: number) => `${JSON.stringify({ n, at })}\n`;
    for (let n = 0; n < 100; n++) fs.appendFileSync(file, run(n, 1000 + n));
    const startedAt = 5000;
    const mark = { bytes: sizeOf(file), ino: inodeOf(file), startedAt };
    assert.equal(runsSince(file, mark), '');
    fs.appendFileSync(file, run(100, startedAt));
    assert.equal(runsSince(file, mark), run(100, startedAt), 'an unreplaced file reads from the offset');
    for (let n = 101; n < 110; n++) fs.appendFileSync(file, run(n, startedAt + n));
    assert.equal(keepNewestLinesAsSoleWriter(file, limit), true);
    assert.ok(
      runsOf(fs.readFileSync(file, 'utf8')).some(entry => entry.n < 100),
      'the cut keeps runs from before the trace',
    );
    assert.deepEqual(
      runsOf(runsSince(file, mark)).map(entry => entry.n),
      Array.from({ length: 10 }, (_, i) => 100 + i),
    );

    fs.writeFileSync(`${file}.new`, `${JSON.stringify({ n: -1 })}\n${run(200, startedAt + 200)}`);
    fs.renameSync(`${file}.new`, file);
    assert.deepEqual(
      runsOf(runsSince(file, mark)).map(entry => entry.n),
      [200],
      'a replaced file drops a run with no time, which may predate the trace',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a steps file rewritten in place under the same inode never puts half a line in the trace', () => {
  const root = tempDir('trace-inode');
  try {
    const file = path.join(root, 'steps.jsonl');
    for (let n = 0; n < 10; n++) fs.appendFileSync(file, `${JSON.stringify({ n, at: 1000 })}\n`);
    const mark = { bytes: sizeOf(file), ino: inodeOf(file), startedAt: 2000 };
    const rewritten = Array.from(
      { length: 40 },
      (_, n) => `${JSON.stringify({ n: 100 + n, pad: 'xy', at: 1500 + n * 20 })}\n`,
    ).join('');
    fs.writeFileSync(file, rewritten);
    assert.equal(inodeOf(file), mark.ino);
    assert.notEqual(rewritten[mark.bytes - 1], '\n', 'the offset falls mid-line');
    const runs = runsOf(runsSince(file, mark));
    assert.deepEqual(
      runs.map(entry => entry.n),
      Array.from({ length: 15 }, (_, i) => 125 + i),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cut that fails leaves the steps file whole, its temp file gone, and the name a pruned lane file', t => {
  const root = tempDir('cut-fails');
  try {
    const state = hermeticEnv(root).AGENTLANE_STATE_DIR ?? '';
    const laneId = 'abcd1234';
    const steps = enginePaths(state, laneId).steps;
    fs.mkdirSync(path.dirname(steps), { recursive: true });
    const text = `${JSON.stringify({ yaml: '- tapOn: y\n' })}\n`.repeat(200);
    fs.writeFileSync(steps, text);
    const asides: string[] = [];
    t.mock.method(fs, 'renameSync', (from: string) => {
      asides.push(from);
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    assert.equal(keepNewestLinesAsSoleWriter(steps, { maxBytes: 1000, keepBytes: 500 }), false);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(steps, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(path.dirname(steps)), [path.basename(steps)]);

    const [aside] = asides;
    assert.ok(aside !== undefined);
    fs.writeFileSync(aside, 'left by a crash');
    assert.deepEqual(pruneDriverFiles(state, new Set(), Date.now() + 60_000, 0), [laneId]);
    assert.deepEqual(fs.readdirSync(path.dirname(steps)), []);
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

test('init backups go by when they were written, never drop the one just written, and tell same-named projects apart', () => {
  const root = tempDir('backups-written');
  try {
    const dir = path.join(root, 'init-backups');
    const ahead = (day: number) => `2027-01-${String(day).padStart(2, '0')}T09-00-00-000Z-app`;
    for (let day = 1; day <= 6; day++) {
      fs.mkdirSync(path.join(dir, ahead(day)), { recursive: true });
      const at = new Date(Date.UTC(2026, 9, day));
      fs.utimesSync(path.join(dir, ahead(day)), at, at);
    }
    const written = '2026-10-12T09-00-00-000Z-app';
    fs.mkdirSync(path.join(dir, written));
    const removed = keepNewestBackups(dir, 'app', 5, written);
    assert.deepEqual(removed.map(at => path.basename(at)).sort(), [ahead(1), ahead(2)]);
    assert.ok(fs.existsSync(path.join(dir, written)), 'the backup just written stays');
    assert.deepEqual(keepNewestBackups(dir, 'app', 0, written).length, 4);
    assert.deepEqual(fs.readdirSync(dir), [written]);

    const a = path.join(root, 'a', 'app');
    const b = path.join(root, 'b', 'app');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    assert.match(backupProject(a), /^app-[0-9a-f]{8}$/);
    assert.notEqual(backupProject(a), backupProject(b));
    assert.equal(backupProject(path.join(a, '..', 'app')), backupProject(a));
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
    assert.equal(keepNewestLinesAsSoleWriter(steps, RECORDED_STEPS_LIMIT), true);
    const log = path.join(state, 'session-end.log');
    fs.writeFileSync(log, 'w'.repeat(2 * 1024 * 1024));
    assert.equal(rotateLog(log, 1024 * 1024), true);
    keepNewestBackups(path.join(state, 'init-backups'), 'evidence', 0);

    assert.deepEqual(treeOf(evidence), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
