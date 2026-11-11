import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { databasePath } from '../src/registry/paths.ts';
import { tempDir } from './support/fakes.ts';
import { openRegistryReadOnly, READ_BUSY_WAIT_MS } from './support/registry-read.ts';

const TESTS = import.meta.dirname;
const HELPER = path.join(TESTS, 'support', 'registry-read.ts');
const HOLD_MS = 400;

function holderScript(file: string): string {
  return [
    "import { DatabaseSync } from 'node:sqlite';",
    `const db = new DatabaseSync(${JSON.stringify(file)});`,
    "db.exec('PRAGMA locking_mode = EXCLUSIVE');",
    "db.exec('BEGIN EXCLUSIVE');",
    "db.exec('INSERT INTO t VALUES (1)');",
    "process.stdout.write('held\\n');",
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(HOLD_MS)});`,
    "db.exec('COMMIT');",
    'db.close();',
  ].join('\n');
}

test('a read-only registry open from the test helper waits out a writer that holds the lock, where one with no busy timeout fails', async () => {
  const dir = tempDir('registry-read');
  const setup = new DatabaseSync(databasePath(dir));
  setup.exec('PRAGMA journal_mode = WAL');
  setup.exec('CREATE TABLE t (v)');
  setup.close();

  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript(databasePath(dir))], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<number | null>(resolve => holder.once('exit', resolve));
  await new Promise(resolve => holder.stdout.once('data', resolve));

  const bare = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    assert.throws(() => bare.prepare('SELECT COUNT(*) AS n FROM t').get(), /database is locked/);
  } finally {
    bare.close();
  }

  const started = Date.now();
  const db = openRegistryReadOnly(dir);
  try {
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.n), 1);
  } finally {
    db.close();
  }
  assert.ok(Date.now() - started < READ_BUSY_WAIT_MS, 'the read landed once the writer let go, not at the timeout');
  assert.equal(await exited, 0);
});

test('every read-only registry open under tests/ goes through openRegistryReadOnly, which sets the busy timeout', () => {
  const offenders = fs
    .readdirSync(TESTS, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => path.join(TESTS, file))
    .filter(file => file !== HELPER && file !== import.meta.filename)
    .flatMap(file =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (line.includes('readOnly') ? [`${path.relative(TESTS, file)}:${String(i + 1)}`] : [])),
    );
  assert.deepEqual(
    offenders,
    [],
    'open the registry read-only with openRegistryReadOnly or readRegistry from tests/support/registry-read.ts',
  );
});
