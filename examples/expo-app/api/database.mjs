import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const TEST_ACCOUNT = { email: 'tester@example.com', password: 'example-password', name: 'Test User' };

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function passwordMatches(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

const migrations = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     password_hash TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE
   );
   CREATE TABLE items (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     minutes INTEGER NOT NULL,
     added_by INTEGER REFERENCES users (id) ON DELETE SET NULL
   );`,
  db => {
    db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(
      TEST_ACCOUNT.email,
      TEST_ACCOUNT.name,
      hashPassword(TEST_ACCOUNT.password),
    );
    const item = db.prepare('INSERT INTO items (id, name, minutes) VALUES (?, ?, ?)');
    item.run('harbor', 'Harbor walk', 25);
    item.run('market', 'Covered market', 40);
    item.run('gallery', 'Small gallery', 55);
  },
];

export function migrate(db) {
  const { user_version: applied } = db.prepare('PRAGMA user_version').get();
  if (applied > migrations.length) {
    throw new Error(`the database is at schema version ${applied}, newer than this API's ${migrations.length}`);
  }
  for (let version = applied; version < migrations.length; version += 1) {
    const step = migrations[version];
    db.exec('BEGIN');
    try {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function laneDatabasePath() {
  const lane = process.env.AGENTLANE_LANE;
  if (!lane) return null;
  return join(tmpdir(), 'expo-example-databases', `${lane}.sqlite`);
}

function create(argument) {
  const path = argument ? resolve(argument) : laneDatabasePath();
  if (!path) {
    console.error('usage: node api/database.mjs create [path]  (the path defaults to one per AGENTLANE_LANE)');
    process.exit(2);
  }
  openDatabase(path).close();
  console.log(`database ready at ${path}`);
  if (process.env.AGENTLANE_EXPORTS) appendFileSync(process.env.AGENTLANE_EXPORTS, `DATABASE_PATH=${path}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'create') create(argument);
  else {
    console.error('usage: node api/database.mjs create [path]');
    process.exit(2);
  }
}
