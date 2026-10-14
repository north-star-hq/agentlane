import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.AGENTLANE_SITE_PORT ?? process.env.PORT);
const sessions = new Map<string, string>();

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

createServer((req, res) => {
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const user = new URLSearchParams(body).get('user') ?? '';
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(user)) {
        res.statusCode = 400;
        res.end('bad user');
        return;
      }
      const token = randomBytes(16).toString('hex');
      sessions.set(token, user);
      res.statusCode = 303;
      res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax`);
      res.setHeader('Location', '/');
      res.end();
    });
    return;
  }
  const sid = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
  const user = sid === undefined ? undefined : sessions.get(sid);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    user === undefined
      ? page(
          'Sign in',
          '<h1>Sign in</h1><form method="post" action="/login"><input name="user" aria-label="User"><button>Sign in</button></form>',
        )
      : page('Home', `<h1>Signed in as ${user}</h1><p>Served from ${process.cwd()}</p>`),
  );
}).listen(port, '127.0.0.1');
