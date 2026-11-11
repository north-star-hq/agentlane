import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { databases, readDatabase, seed } from '../support/fake-psql.ts';
import { tempDir } from '../support/fakes.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'examples', 'expo-app', 'scripts', 'lane-pg.sh');
const FAKE = path.join(ROOT, 'tests', 'support', 'fake-psql.ts');
const SERVER = 'postgres://localhost:5432';

interface World {
  project: string;
  state: string;
  bin: string;
  home: string;
}

function world(): World {
  const root = tempDir('lane-pg');
  const w = { project: path.join(root, 'project'), state: path.join(root, 'pg'), bin: path.join(root, 'bin'), home: path.join(root, 'home') };
  for (const dir of Object.values(w)) fs.mkdirSync(dir, { recursive: true });
  seed(w.state);
  fs.writeFileSync(path.join(w.bin, 'psql'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  for (const tool of ['createdb', 'dropdb', 'pg_dump', 'pg_restore']) {
    fs.writeFileSync(path.join(w.bin, tool), `#!/bin/sh\necho "the recipe must not call ${tool}" >&2\nexit 99\n`, { mode: 0o755 });
  }
  migration(w, '001_tables.sql', 'CREATE TABLE notes (id serial primary key, body text);');
  migration(w, '002_seed.sql', "INSERT INTO notes (body) VALUES ('hello');");
  return w;
}

function migration(w: World, name: string, body: string): void {
  fs.mkdirSync(path.join(w.project, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(w.project, 'migrations', name), body);
}

interface Run {
  code: number | null;
  stderr: string;
  exports: string;
}

function environment(w: World): NodeJS.ProcessEnv {
  return {
    PATH: `${w.bin}:/usr/bin:/bin`,
    HOME: w.home,
    XDG_STATE_HOME: path.join(w.home, 'state'),
    XDG_DATA_HOME: path.join(w.home, 'data'),
    XDG_CONFIG_HOME: path.join(w.home, 'config'),
    AGENTLANE_STATE_DIR: path.join(w.home, 'agentlane'),
    CLAUDE_CONFIG_DIR: path.join(w.home, 'claude'),
    CODEX_HOME: path.join(w.home, 'codex'),
    FAKE_PG_STATE: w.state,
  };
}

function lane(w: World, id: string, action: 'create' | 'drop', extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  const exportsFile = path.join(w.project, `${id}.exports`);
  fs.rmSync(exportsFile, { force: true });
  const child = spawn('sh', [SCRIPT, action], {
    cwd: w.project,
    env: {
      ...environment(w),
      AGENTLANE_LANE: id,
      AGENTLANE_EXPORTS: exportsFile,
      ...extra,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise(resolve => {
    child.on('close', code => {
      const exports = fs.existsSync(exportsFile) ? fs.readFileSync(exportsFile, 'utf8') : '';
      resolve({ code, stderr, exports });
    });
  });
}

async function ok(run: Promise<Run>): Promise<Run> {
  const done = await run;
  assert.equal(done.code, 0, done.stderr);
  return done;
}

function calls(w: World): string[] {
  return fs.readFileSync(path.join(w.state, 'calls.log'), 'utf8').trim().split('\n');
}

function templates(w: World): string[] {
  return databases(w.state).filter(name => /^app_template_[0-9a-f]{12}$/.test(name));
}

function laneDatabases(w: World): string[] {
  return databases(w.state).filter(name => /^app_[0-9a-f]{8}$/.test(name));
}

describe('the lane Postgres recipe', () => {
  test('builds the template once when eight lanes start together, and gives every lane a clone of it', async () => {
    const w = world();
    const ids = ['0000000a', '0000000b', '0000000c', '0000000d', '0000000e', '0000000f', '00000010', '00000011'];
    const runs = await Promise.all(ids.map(id => ok(lane(w, id, 'create', { FAKE_PG_MIGRATE_MS: '100' }))));

    const [template] = templates(w);
    assert.ok(template !== undefined);
    assert.deepEqual(templates(w), [template]);
    assert.equal(calls(w).filter(c => c.startsWith('postgres: CREATE DATABASE "app_template_')).length, 1);
    assert.equal(calls(w).filter(c => c.includes(': migrate ')).length, 2);
    for (const [i, id] of ids.entries()) {
      assert.equal(runs[i]?.exports, `DATABASE_URL=${SERVER}/app_${id}\n`);
      const db = readDatabase(w.state, `app_${id}`);
      assert.equal(db?.from, template);
      assert.deepEqual(
        db.applied.map(a => a.split('@')[0]),
        ['001_tables.sql', '002_seed.sql'],
      );
    }
  });

  test('never lets a session connect to the template, so a clone never finds it in use', async () => {
    const w = world();
    await ok(lane(w, '0000000a', 'create'));
    const [template = ''] = templates(w);
    assert.equal(readDatabase(w.state, template)?.template, true);
    assert.equal(readDatabase(w.state, template)?.allowConnections, false);
    assert.ok(!calls(w).includes(`connect ${template}`));
    const migrated = calls(w).filter(c => c.includes(': migrate '));
    assert.ok(migrated.every(c => c.startsWith(`${template}_build: `)), migrated.join('\n'));
    const order = calls(w).filter(c => c.startsWith('postgres: ALTER DATABASE'));
    assert.deepEqual(order, [
      `postgres: ALTER DATABASE "${template}_build" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
      `postgres: ALTER DATABASE "${template}_build" RENAME TO "${template}"`,
    ]);
    const direct = await new Promise<number | null>(resolve => {
      spawn(path.join(w.bin, 'psql'), [`${SERVER}/${template}`, '-c', 'SELECT 1'], {
        env: environment(w),
        stdio: 'ignore',
      }).on('close', resolve);
    });
    assert.notEqual(direct, 0);
  });

  test('builds a new template when a migration changes, and leaves the lanes cloned from the old one alone', async () => {
    const w = world();
    await ok(lane(w, '0000000a', 'create'));
    const [old = ''] = templates(w);
    migration(w, '003_tags.sql', 'ALTER TABLE notes ADD COLUMN tags text;');
    await ok(lane(w, '0000000b', 'create'));

    const fresh = templates(w).find(t => t !== old);
    assert.ok(fresh !== undefined);
    assert.equal(templates(w).length, 2);
    assert.equal(readDatabase(w.state, 'app_0000000a')?.from, old);
    assert.equal(readDatabase(w.state, 'app_0000000a')?.applied.length, 2);
    assert.equal(readDatabase(w.state, 'app_0000000b')?.from, fresh);
    assert.equal(readDatabase(w.state, 'app_0000000b')?.applied.length, 3);

    fs.writeFileSync(path.join(w.project, 'migrations', '003_tags.sql'), 'ALTER TABLE notes ADD COLUMN labels text;');
    await ok(lane(w, '0000000c', 'create'));
    assert.equal(templates(w).length, 3);
  });

  test('a create run twice and a drop run twice both succeed and leave the state one run leaves', async () => {
    const w = world();
    const first = await ok(lane(w, '0000000a', 'create'));
    const once = databases(w.state);
    const again = await ok(lane(w, '0000000a', 'create'));
    assert.deepEqual(databases(w.state), once);
    assert.equal(again.exports, first.exports);
    assert.equal(calls(w).filter(c => c.includes(': migrate ')).length, 2);

    await ok(lane(w, '0000000a', 'drop'));
    const dropped = databases(w.state);
    await ok(lane(w, '0000000a', 'drop'));
    assert.deepEqual(databases(w.state), dropped);
    assert.deepEqual(laneDatabases(w), []);
    assert.equal(templates(w).length, 1);
  });

  test('a create whose template build failed builds it afresh when it runs again', async () => {
    const w = world();
    const failed = await lane(w, '0000000a', 'create', { FAKE_PG_FAIL_ON: '002_seed.sql' });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /could not build the template/);
    assert.equal(failed.exports, '');
    assert.deepEqual(templates(w), []);

    await ok(lane(w, '0000000a', 'create'));
    const [template = ''] = templates(w);
    assert.deepEqual(laneDatabases(w), ['app_0000000a']);
    assert.ok(!databases(w.state).includes(`${template}_build`));
    assert.equal(readDatabase(w.state, 'app_0000000a')?.applied.length, 2);
  });

  test('runs the project migrate command instead of the SQL files when one is set', async () => {
    const w = world();
    const command = 'for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done';
    await ok(lane(w, '0000000a', 'create', { LANE_PG_MIGRATE: command }));
    const [template = ''] = templates(w);
    assert.equal(readDatabase(w.state, 'app_0000000a')?.from, template);
    assert.equal(readDatabase(w.state, 'app_0000000a')?.applied.length, 2);
    await ok(lane(w, '0000000b', 'create'));
    assert.equal(templates(w).length, 2);
  });
});
