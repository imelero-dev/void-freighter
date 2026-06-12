// Void Freighter game server: serves the built client, REST auth API and the
// authoritative WebSocket world on one port.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { hashPassword, newToken, validPassword, validUsername, verifyPassword } from './auth';
import { createDb } from './db';
import { GameServer } from './game';
import { json, readBody } from './http_util';
import { rateLimited } from './ratelimit';

const PORT = Number(process.env.PORT ?? 8788);
const STATIC_DIR = path.join(__dirname, '..', 'dist');

const db = createDb();
const game = new GameServer(db);

async function bearerAccount(req: http.IncomingMessage): Promise<number | null> {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer ([a-f0-9]{64})$/.exec(auth);
  if (!m) return null;
  return db.accountForToken(m[1]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let urlPath = (req.url ?? '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  urlPath = path.posix.normalize(urlPath).replace(/^([.][.][/\\])+/, '');
  const file = path.join(STATIC_DIR, urlPath);
  const stats = file.startsWith(STATIC_DIR) && fs.existsSync(file) ? fs.statSync(file) : null;
  if (!stats?.isFile()) {
    if (path.extname(urlPath) && path.extname(urlPath) !== '.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const index = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      fs.createReadStream(index).pipe(res);
    } else {
      res.writeHead(404);
      res.end('not found (run `npm run build` to serve the client from the game server)');
    }
    return;
  }
  const immutable = urlPath.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? '').split('?')[0];
  try {
    if (req.method === 'POST' && (url === '/api/register' || url === '/api/login') && rateLimited(req)) {
      return json(res, 429, { error: 'too many attempts — wait a minute and try again' });
    }
    if (req.method === 'POST' && url === '/api/register') {
      const body = await readBody(req);
      if (!validUsername(body.username)) return json(res, 400, { error: 'callsign must be 3-24 chars (letters, digits, _)' });
      if (!validPassword(body.password)) return json(res, 400, { error: 'password must be at least 6 chars' });
      const existing = await db.findAccount(body.username);
      if (existing) return json(res, 409, { error: 'callsign already taken' });
      const account = await db.createAccount(body.username, await hashPassword(body.password));
      const token = newToken();
      await db.saveToken(token, account.id);
      return json(res, 200, { token, username: account.username });
    }
    if (req.method === 'POST' && url === '/api/login') {
      const body = await readBody(req);
      const account = typeof body.username === 'string' ? await db.findAccount(body.username) : null;
      if (!account || !(await verifyPassword(String(body.password ?? ''), account.password_hash))) {
        return json(res, 401, { error: 'invalid callsign or password' });
      }
      await db.touchLogin(account.id);
      const token = newToken();
      await db.saveToken(token, account.id);
      return json(res, 200, { token, username: account.username });
    }
    if (req.method === 'GET' && url === '/api/status') {
      return json(res, 200, game.status());
    }
    json(res, 404, { error: 'unknown endpoint' });
  } catch (err: any) {
    console.error('api error:', err);
    json(res, 500, { error: 'internal error' });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function startServer(port = PORT): Promise<http.Server> {
  await db.ready();
  await game.init();
  console.log('database ready');

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/')) void handleApi(req, res);
    else serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void onConnection(ws);
    });
  });

  async function authenticateWebSocket(ws: WebSocket, raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ t: 'error', error: 'bad auth message' }));
      ws.close();
      return;
    }
    if (msg?.t !== 'auth' || typeof msg.token !== 'string') {
      ws.send(JSON.stringify({ t: 'error', error: 'authentication required' }));
      ws.close();
      return;
    }
    const accountId = await db.accountForToken(msg.token);
    if (accountId === null) {
      ws.send(JSON.stringify({ t: 'error', error: 'not authenticated' }));
      ws.close();
      return;
    }
    const account = await db.loadPlayer(accountId);
    // username lookup: derive from token->account row
    const name = await usernameFor(accountId);
    if (!name) {
      ws.send(JSON.stringify({ t: 'error', error: 'account not found' }));
      ws.close();
      return;
    }
    const result = game.join(ws, accountId, name, account);
    if ('error' in result) {
      ws.send(JSON.stringify({ t: 'error', error: result.error }));
      ws.close();
      return;
    }
    const session = result;
    console.log(`+ ${name} joined — ${game.clients.size} online`);
    ws.on('message', (data) => {
      game.handleMessage(session, String(data));
    });
    ws.on('close', () => {
      void game.leave(session, 'disconnected');
      console.log(`- ${name} left — ${game.clients.size} online`);
    });
    ws.on('error', () => {
      void game.leave(session, 'connection error');
    });
  }

  async function onConnection(ws: WebSocket): Promise<void> {
    const authTimer = setTimeout(() => {
      ws.send(JSON.stringify({ t: 'error', error: 'authentication timed out' }));
      ws.close();
    }, 10_000);
    ws.once('message', (data) => {
      clearTimeout(authTimer);
      void authenticateWebSocket(ws, String(data));
    });
  }

  game.start();
  await new Promise<void>((ok) => server.listen(port, ok));
  console.log(`Void Freighter server listening on http://localhost:${port}`);
  console.log(`  REST: /api/register /api/login /api/status`);
  console.log(`  WS:   /ws, first message {t:"auth",token}`);

  const shutdown = async () => {
    console.log('shutting down: saving pilots + market...');
    game.stop();
    await game.saveAll('shutdown');
    await game.saveMarket();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

const nameCache = new Map<number, string>();
async function usernameFor(accountId: number): Promise<string | null> {
  const hit = nameCache.get(accountId);
  if (hit) return hit;
  const row = await db.findAccountById(accountId);
  if (row?.username) {
    nameCache.set(accountId, row.username);
    return row.username;
  }
  return null;
}

// boot when run directly (the test suite imports startServer instead)
if (process.env.VF_NO_AUTOBOOT !== '1') {
  startServer().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
