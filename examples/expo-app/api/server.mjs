import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { openDatabase, passwordMatches } from './database.mjs';

const port = Number.parseInt(process.env.PORT ?? '', 10);
if (!Number.isInteger(port) || port < 0) {
  console.error('PORT must be set to the port this API listens on (0 picks a free one)');
  process.exit(2);
}
const databasePath = process.env.DATABASE_PATH;
if (!databasePath) {
  console.error('DATABASE_PATH must be set to the SQLite file this API uses (node api/database.mjs create makes one)');
  process.exit(2);
}

const db = openDatabase(databasePath);
const SESSION_COOKIE = 'session';
const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sessionToken(req) {
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  if (bearer) return bearer[1];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=');
  }
  return null;
}

function requireUser(req) {
  const token = sessionToken(req);
  const user = token
    ? db
        .prepare(
          'SELECT users.id, users.email, users.name FROM sessions JOIN users ON users.id = sessions.user_id WHERE token = ?',
        )
        .get(token)
    : undefined;
  if (!user) throw new HttpError(401, 'sign in first');
  return user;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'the request body is too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'the request body must be a JSON object');
  }
}

const routes = {
  'GET /health': () => ({ body: { status: 'ok' } }),
  'GET /items': ({ listening }) => ({
    body: { items: db.prepare('SELECT id, name, minutes FROM items ORDER BY rowid').all(), port: listening },
  }),
  'POST /items': async ({ req }) => {
    const user = requireUser(req);
    const { name, minutes } = await readJson(req);
    if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 80) {
      throw new HttpError(400, 'name must be 1 to 80 characters');
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
      throw new HttpError(400, 'minutes must be a whole number from 1 to 600');
    }
    const item = { id: randomUUID().slice(0, 8), name: name.trim(), minutes };
    db.prepare('INSERT INTO items (id, name, minutes, added_by) VALUES (?, ?, ?, ?)').run(
      item.id,
      item.name,
      item.minutes,
      user.id,
    );
    return { status: 201, body: { item } };
  },
  'GET /session': ({ req }) => ({ body: { user: requireUser(req) } }),
  'POST /session': async ({ req }) => {
    const { email, password } = await readJson(req);
    const row =
      typeof email === 'string' ? db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) : undefined;
    if (!row || typeof password !== 'string' || !passwordMatches(password, row.password_hash)) {
      throw new HttpError(401, 'wrong email or password');
    }
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, row.id);
    return {
      body: { user: { id: row.id, email: row.email, name: row.name }, token },
      headers: { 'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` },
    };
  },
  'DELETE /session': ({ req }) => {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return { status: 204, headers: { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } };
  },
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const route = routes[`${req.method} ${path}`];
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${req.headers['user-agent'] ?? '-'}`);
  });
  let reply;
  try {
    if (!route) throw new HttpError(404, 'not found');
    reply = await route({ req, listening: server.address().port });
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    reply = {
      status: error instanceof HttpError ? error.status : 500,
      body: { error: error instanceof HttpError ? error.message : 'internal error' },
    };
  }
  res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
  res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${server.address().port} with the database at ${databasePath}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
