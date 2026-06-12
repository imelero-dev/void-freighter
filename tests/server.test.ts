// Multiplayer/persistence suite: boots the real server (in-memory DB) on an
// ephemeral port and drives it over HTTP + WebSocket like real clients.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Server } from 'node:http';

process.env.VF_NO_AUTOBOOT = '1';
process.env.ALLOW_DEV_COMMANDS = '1';
delete process.env.DATABASE_URL;

const PORT = 18788;
const BASE = `http://localhost:${PORT}`;

let server: Server;

beforeAll(async () => {
  const { startServer } = await import('../server/main');
  server = await startServer(PORT);
});

afterAll(() => {
  server?.close();
});

async function api(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

interface TestClient {
  ws: WebSocket;
  pid: number;
  msgs: any[];
  profile: any;
  lastSnap: any;
  send(obj: unknown): void;
  close(): void;
  waitFor<T>(pred: (m: any) => T | undefined, timeoutMs?: number): Promise<T>;
}

function connect(token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const client: TestClient = {
      ws, pid: -1, msgs: [], profile: null, lastSnap: null,
      send: (obj) => ws.send(JSON.stringify(obj)),
      close: () => ws.close(),
      waitFor: (pred, timeoutMs = 8000) => new Promise((ok, bad) => {
        const check = () => {
          for (const m of client.msgs) {
            const r = pred(m);
            if (r !== undefined) {
              ok(r);
              return true;
            }
          }
          return false;
        };
        if (check()) return;
        const iv = setInterval(() => {
          if (check()) clearInterval(iv);
        }, 30);
        setTimeout(() => {
          clearInterval(iv);
          bad(new Error('waitFor timeout'));
        }, timeoutMs);
      }),
    };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      client.msgs.push(msg);
      if (msg.t === 'hello') {
        client.pid = msg.pid;
        client.profile = msg.profile;
        resolve(client);
      }
      if (msg.t === 'error' && client.pid === -1) reject(new Error(msg.error));
      if (msg.t === 'snap') {
        client.lastSnap = msg;
        if (msg.profile) client.profile = msg.profile;
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe('auth API', () => {
  it('registers, rejects duplicates and bad logins', async () => {
    const r1 = await api('/api/register', { username: 'pilot_one', password: 'secret1' });
    expect(r1.status).toBe(200);
    expect(r1.data.token).toMatch(/^[a-f0-9]{64}$/);
    const dup = await api('/api/register', { username: 'pilot_one', password: 'secret1' });
    expect(dup.status).toBe(409);
    const bad = await api('/api/login', { username: 'pilot_one', password: 'wrong' });
    expect(bad.status).toBe(401);
    const good = await api('/api/login', { username: 'pilot_one', password: 'secret1' });
    expect(good.status).toBe(200);
  });

  it('validates usernames and passwords', async () => {
    expect((await api('/api/register', { username: 'x', password: 'secret1' })).status).toBe(400);
    expect((await api('/api/register', { username: 'valid_name', password: '123' })).status).toBe(400);
  });
});

describe('world over WebSocket', () => {
  it('two clients see each other in space and chat', async () => {
    const a = await api('/api/register', { username: 'alice_haul', password: 'secret1' });
    const b = await api('/api/register', { username: 'bob_mining', password: 'secret1' });
    const ca = await connect(a.data.token);
    const cb = await connect(b.data.token);

    // both undock and teleport near each other in deep space
    ca.send({ t: 'cmd', cmd: 'undock' });
    cb.send({ t: 'cmd', cmd: 'undock' });
    await sleep(300);
    ca.send({ t: 'cmd', cmd: 'dev_teleport', x: 9e6, y: 1e6, z: 9e6 });
    cb.send({ t: 'cmd', cmd: 'dev_teleport', x: 9e6 + 2000, y: 1e6, z: 9e6 });
    await sleep(600);

    // alice should see bob as a player ship in her snapshot
    const sawBob = await ca.waitFor((m) =>
      m.t === 'snap' && m.ents?.some((e: any) => e.k === 's' && e.pl === 1 && e.nm === 'bob_mining') ? true : undefined);
    expect(sawBob).toBe(true);

    // local chat
    ca.send({ t: 'cmd', cmd: 'chat', text: 'hello the void' });
    const heard = await cb.waitFor((m) =>
      m.t === 'events' && m.list?.some((ev: any) => ev.type === 'chat' && ev.text === 'hello the void') ? true : undefined);
    expect(heard).toBe(true);

    ca.close();
    cb.close();
    await sleep(200);
  });

  it('rejects double login on the same account', async () => {
    const r = await api('/api/register', { username: 'dupe_pilot', password: 'secret1' });
    const c1 = await connect(r.data.token);
    await expect(connect(r.data.token)).rejects.toThrow(/already flying/);
    c1.close();
    await sleep(200);
  });

  it('market transactions are authoritative and persist across reconnect', async () => {
    const r = await api('/api/register', { username: 'trader_x', password: 'secret1' });
    const c = await connect(r.data.token);
    expect(c.profile.credits).toBe(2000);
    expect(c.profile.dockedAt).toBe('morrow_granary');

    // buy 10 food at the docked station
    c.send({ t: 'cmd', cmd: 'buy', good: 'food', qty: 10 });
    await c.waitFor((m) =>
      m.t === 'events' && m.list?.some((ev: any) => ev.type === 'tx' && ev.bought && ev.good === 'food') ? true : undefined);
    // profile piggyback arrives within ~0.5 s
    await c.waitFor((m) => m.t === 'snap' && m.profile && m.profile.credits < 2000 ? true : undefined);
    const credits = c.profile.credits;
    const food = c.profile.cargo.find((x: any) => x.good === 'food');
    expect(food?.qty).toBe(10);

    // overdraft is rejected server-side
    c.send({ t: 'cmd', cmd: 'buy', good: 'machinery', qty: 9999 });
    await sleep(600);
    expect(c.profile.credits).toBe(credits);

    // disconnect: state saved; reconnect: same profile
    c.close();
    await sleep(400);
    const c2 = await connect(r.data.token);
    expect(c2.profile.credits).toBe(credits);
    expect(c2.profile.cargo.find((x: any) => x.good === 'food')?.qty).toBe(10);
    c2.close();
    await sleep(200);
  });

  it('concurrent buys cannot duplicate credits or stock', async () => {
    const r = await api('/api/register', { username: 'race_pilot', password: 'secret1' });
    const c = await connect(r.data.token);
    // hammer buy commands in one burst; server processes sequentially
    for (let i = 0; i < 30; i++) c.send({ t: 'cmd', cmd: 'buy', good: 'food', qty: 5 });
    await sleep(1200);
    // hold can fit 30 m³ -> max 30 units of food (1.0 m³ each)
    const food = c.profile.cargo.find((x: any) => x.good === 'food')?.qty ?? 0;
    const spent = 2000 - c.profile.credits;
    expect(food).toBeLessThanOrEqual(30);
    // credits never negative, and we paid a sane positive price per unit
    expect(c.profile.credits).toBeGreaterThanOrEqual(0);
    if (food > 0) expect(spent / food).toBeGreaterThan(5);
    c.close();
    await sleep(200);
  });

  it('input drives the authoritative ship', async () => {
    const r = await api('/api/register', { username: 'mover_one', password: 'secret1' });
    const c = await connect(r.data.token);
    c.send({ t: 'cmd', cmd: 'undock' });
    await sleep(300);
    const before = await c.waitFor((m) => (m.t === 'snap' ? { x: m.self.x, y: m.self.y, z: m.self.z } : undefined));
    // full throttle for 2 seconds
    const iv = setInterval(() => c.send({ t: 'input', i: [1, 0, 0, 0, 0, 0, 0] }), 50);
    await sleep(2000);
    clearInterval(iv);
    c.msgs.length = 0;
    const after = await c.waitFor((m) => (m.t === 'snap' ? { x: m.self.x, y: m.self.y, z: m.self.z } : undefined));
    const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    expect(moved).toBeGreaterThan(50);
    c.close();
    await sleep(200);
  });

  it('status endpoint reports online players', async () => {
    const res = await fetch(`${BASE}/api/status`);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.players_online).toBe('number');
  });
});
