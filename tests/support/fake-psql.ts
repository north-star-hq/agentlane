import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FakeDatabase {
  template: boolean;
  allowConnections: boolean;
  from: string | null;
  applied: string[];
}

export function databaseDir(state: string, name: string): string {
  return path.join(state, 'db', name);
}

export function readDatabase(state: string, name: string): FakeDatabase | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(databaseDir(state, name), 'meta.json'), 'utf8')) as FakeDatabase;
  } catch {
    return null;
  }
}

export function databases(state: string): string[] {
  try {
    return fs.readdirSync(path.join(state, 'db')).sort();
  } catch {
    return [];
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class Failure extends Error {}

const NAMEDATALEN = 63;

function identifier(name: string): string {
  return Buffer.from(name).subarray(0, NAMEDATALEN).toString();
}

function roleSettings(): Map<string, number> {
  const settings = new Map<string, number>();
  for (const pair of (process.env.FAKE_PG_ROLE_SETTINGS ?? '').split(',')) {
    const [name = '', value = ''] = pair.split('=');
    if (name !== '') settings.set(name, Number(value));
  }
  return settings;
}

function serverSettings(): string[] {
  const version = Number(process.env.FAKE_PG_VERSION ?? '17');
  return [
    'statement_timeout',
    'lock_timeout',
    ...(version >= 14 ? ['idle_session_timeout'] : []),
    ...(version >= 17 ? ['transaction_timeout'] : []),
  ];
}

function run(state: string, argv: string[]): void {
  let target: string | null = null;
  let command: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-v') i++;
    else if (arg === '-c') command = argv[++i] ?? '';
    else if (arg === '-f') file = argv[++i] ?? '';
    else if (!arg.startsWith('-')) target = arg;
  }
  if (target === null) throw new Failure('no connection string');
  const db = identifier(new URL(target).pathname.slice(1));
  const log = (line: string): void => {
    fs.appendFileSync(path.join(state, 'calls.log'), `${line}\n`);
  };

  const meta = readDatabase(state, db);
  if (meta === null) throw new Failure(`FATAL: database "${db}" does not exist`);
  if (!meta.allowConnections) throw new Failure(`FATAL: database "${db}" is not currently accepting connections`);
  const connections = path.join(state, 'connections');
  fs.mkdirSync(connections, { recursive: true });
  const connection = path.join(connections, `${db}.${String(process.pid)}`);
  fs.writeFileSync(connection, '');
  const locks: string[] = [];
  const settings = roleSettings();
  const setting = (name: string): number => settings.get(name) ?? 0;
  process.on('exit', () => {
    fs.rmSync(connection, { force: true });
    for (const lock of locks) fs.rmSync(lock, { recursive: true, force: true });
  });
  log(`connect ${db}`);

  const othersOn = (name: string): string[] =>
    fs.readdirSync(connections).filter(c => c.startsWith(`${name}.`) && c !== path.basename(connection));
  const write = (name: string, next: FakeDatabase): void => {
    fs.writeFileSync(path.join(databaseDir(state, name), 'meta.json'), JSON.stringify(next));
  };

  const statement = (raw: string): void => {
    const sql = raw.trim().replace(/;$/, '');
    if (sql === '') return;
    log(`${db}: ${sql}`);
    let m: RegExpExecArray | null;
    if ((m = /^\\! (.+)$/.exec(sql))) {
      const idle = setting('idle_session_timeout');
      const started = Date.now();
      const terminator =
        idle > 0
          ? spawn(
              process.execPath,
              [
                '-e',
                'setTimeout(() => { for (const l of JSON.parse(process.argv[1])) require("fs").rmSync(l, { recursive: true, force: true }); }, Number(process.argv[2]))',
                JSON.stringify(locks),
                String(idle),
              ],
              { stdio: 'ignore' },
            )
          : null;
      spawnSync('sh', ['-c', m[1] ?? ''], { stdio: 'inherit' });
      terminator?.kill();
      if (idle > 0 && Date.now() - started >= idle) {
        throw new Failure('FATAL: terminating connection due to idle-session timeout');
      }
    } else if ((m = /^SELECT set_config\(name, '0', false\) FROM pg_settings WHERE name IN \(([^)]+)\)$/.exec(sql))) {
      const known = serverSettings();
      for (const quoted of (m[1] ?? '').split(',')) {
        const name = quoted.trim().replace(/^'|'$/g, '');
        if (known.includes(name)) settings.set(name, 0);
      }
    } else if ((m = /^SELECT 1 FROM pg_database WHERE datname = '([^']+)'$/.exec(sql))) {
      if (readDatabase(state, m[1] ?? '') !== null) process.stdout.write('1\n');
    } else if ((m = /^SELECT pg_advisory_lock\((-?\d+)\)$/.exec(sql))) {
      const lock = path.join(state, 'locks', m[1] ?? '');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      const limits = [setting('statement_timeout'), setting('lock_timeout')].filter(limit => limit > 0);
      const transaction = serverSettings().includes('transaction_timeout') ? setting('transaction_timeout') : 0;
      const started = Date.now();
      for (;;) {
        try {
          fs.mkdirSync(lock);
          break;
        } catch {
          if (limits.some(limit => Date.now() - started >= limit)) {
            throw new Failure('ERROR: canceling statement due to statement timeout');
          }
          if (transaction > 0 && Date.now() - started >= transaction) {
            throw new Failure('FATAL: terminating connection due to transaction timeout');
          }
          sleep(5);
        }
      }
      locks.push(lock);
    } else if ((m = /^CREATE DATABASE "([^"]+)"(?: TEMPLATE "([^"]+)")?$/.exec(sql))) {
      const name = identifier(m[1] ?? '');
      const source = identifier(m[2] ?? 'template1');
      const from = m[2] === undefined ? null : readDatabase(state, source);
      if (m[2] !== undefined && from === null) throw new Failure(`ERROR: template database "${source}" does not exist`);
      if (othersOn(source).length > 0) {
        throw new Failure(`ERROR: source database "${source}" is being accessed by other users`);
      }
      const staging = fs.mkdtempSync(path.join(state, 'staging-'));
      const created: FakeDatabase = {
        template: false,
        allowConnections: true,
        from: m[2] === undefined ? null : source,
        applied: from?.applied ?? [],
      };
      fs.writeFileSync(path.join(staging, 'meta.json'), JSON.stringify(created));
      fs.mkdirSync(path.join(state, 'db'), { recursive: true });
      try {
        fs.renameSync(staging, databaseDir(state, name));
      } catch {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new Failure(`ERROR: database "${name}" already exists`);
      }
    } else if ((m = /^DROP DATABASE IF EXISTS "([^"]+)"( WITH \(FORCE\))?$/.exec(sql))) {
      const name = identifier(m[1] ?? '');
      const found = readDatabase(state, name);
      if (found === null) return;
      if (found.template) throw new Failure('ERROR: cannot drop a template database');
      const others = othersOn(name);
      if (m[2] === undefined && others.length > 0) {
        throw new Failure(`ERROR: database "${name}" is being accessed by other users`);
      }
      for (const other of others) {
        fs.rmSync(path.join(connections, other), { force: true });
        try {
          process.kill(Number(other.slice(name.length + 1)), 'SIGTERM');
        } catch {
          continue;
        }
      }
      fs.rmSync(databaseDir(state, name), { recursive: true, force: true });
    } else if ((m = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"$/.exec(sql))) {
      const name = identifier(m[1] ?? '');
      const to = identifier(m[2] ?? '');
      if (readDatabase(state, name) === null) throw new Failure(`ERROR: database "${name}" does not exist`);
      if (othersOn(name).length > 0) throw new Failure(`ERROR: database "${name}" is being accessed by other users`);
      try {
        fs.renameSync(databaseDir(state, name), databaseDir(state, to));
      } catch {
        throw new Failure(`ERROR: database "${to}" already exists`);
      }
    } else if ((m = /^ALTER DATABASE "([^"]+)" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false$/.exec(sql))) {
      const name = identifier(m[1] ?? '');
      const found = readDatabase(state, name);
      if (found === null) throw new Failure(`ERROR: database "${name}" does not exist`);
      write(name, { ...found, template: true, allowConnections: false });
    } else if ((m = /^ALTER DATABASE "([^"]+)" IS_TEMPLATE false$/.exec(sql))) {
      const name = identifier(m[1] ?? '');
      const found = readDatabase(state, name);
      if (found === null) throw new Failure(`ERROR: database "${name}" does not exist`);
      write(name, { ...found, template: false });
    } else {
      throw new Failure(`fake psql does not know: ${sql}`);
    }
  };

  if (file !== null) {
    const body = fs.readFileSync(file, 'utf8');
    log(`${db}: migrate ${path.basename(file)}`);
    sleep(Number(process.env.FAKE_PG_MIGRATE_MS ?? '0'));
    if (process.env.FAKE_PG_FAIL_ON === path.basename(file)) throw new Failure(`ERROR: in ${path.basename(file)}`);
    const current = readDatabase(state, db);
    if (current === null) throw new Failure(`FATAL: database "${db}" does not exist`);
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 8);
    write(db, { ...current, applied: [...current.applied, `${path.basename(file)}@${digest}`] });
  } else if (command !== null) {
    statement(command);
  } else {
    for (const line of fs.readFileSync(0, 'utf8').split('\n')) statement(line);
  }
}

export function seed(state: string): void {
  fs.mkdirSync(path.join(state, 'db', 'postgres'), { recursive: true });
  const meta: FakeDatabase = { template: false, allowConnections: true, from: null, applied: [] };
  fs.writeFileSync(path.join(state, 'db', 'postgres', 'meta.json'), JSON.stringify(meta));
}

if (import.meta.main) {
  try {
    run(process.env.FAKE_PG_STATE ?? '', process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`psql: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof Failure ? 3 : 4);
  }
}
