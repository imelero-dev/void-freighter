// Persistence: Postgres (JSONB player/market state) with an in-memory
// fallback when DATABASE_URL is unset — used for local dev and tests so the
// full stack runs without Docker. Production always sets DATABASE_URL.

import type { PlayerProfile } from '../src/sim/types';

export interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
}

export interface Db {
  ready(): Promise<void>;
  createAccount(username: string, passwordHash: string): Promise<AccountRow>;
  findAccount(username: string): Promise<AccountRow | null>;
  findAccountById(accountId: number): Promise<AccountRow | null>;
  touchLogin(accountId: number): Promise<void>;
  saveToken(token: string, accountId: number, ttlHours?: number): Promise<void>;
  accountForToken(token: string): Promise<number | null>;
  loadPlayer(accountId: number): Promise<PlayerProfile | null>;
  savePlayer(accountId: number, username: string, state: PlayerProfile): Promise<void>;
  loadMarketState(): Promise<unknown | null>;
  saveMarketState(state: unknown): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_tokens_account ON auth_tokens(account_id);
CREATE TABLE IF NOT EXISTS players (
  account_id INT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  state JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS market_state (
  id INT PRIMARY KEY,
  state JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

class PgDb implements Db {
  private pool!: import('pg').Pool;

  constructor(private url: string) {}

  async ready(): Promise<void> {
    // import lazily so the in-memory path never loads pg
    const { Pool } = await import('pg');
    this.pool = new Pool({ connectionString: this.url, max: 10 });
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query('SELECT 1');
        break;
      } catch (err) {
        if (attempt >= 30) throw err;
        console.log(`waiting for postgres (attempt ${attempt})...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await this.pool.query(SCHEMA);
  }

  async createAccount(username: string, passwordHash: string): Promise<AccountRow> {
    const res = await this.pool.query(
      'INSERT INTO accounts (username, password_hash) VALUES ($1, $2) RETURNING id, username, password_hash',
      [username, passwordHash],
    );
    return res.rows[0];
  }

  async findAccount(username: string): Promise<AccountRow | null> {
    const res = await this.pool.query('SELECT id, username, password_hash FROM accounts WHERE username = $1', [username]);
    return res.rows[0] ?? null;
  }

  async findAccountById(accountId: number): Promise<AccountRow | null> {
    const res = await this.pool.query('SELECT id, username, password_hash FROM accounts WHERE id = $1', [accountId]);
    return res.rows[0] ?? null;
  }

  async touchLogin(accountId: number): Promise<void> {
    await this.pool.query('UPDATE accounts SET last_login = now() WHERE id = $1', [accountId]);
  }

  async saveToken(token: string, accountId: number, ttlHours = 24 * 7): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_tokens (token, account_id, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
      [token, accountId, String(ttlHours)],
    );
  }

  async accountForToken(token: string): Promise<number | null> {
    const res = await this.pool.query(
      'SELECT account_id FROM auth_tokens WHERE token = $1 AND expires_at > now()',
      [token],
    );
    return res.rows[0]?.account_id ?? null;
  }

  async loadPlayer(accountId: number): Promise<PlayerProfile | null> {
    const res = await this.pool.query('SELECT state FROM players WHERE account_id = $1', [accountId]);
    return res.rows[0]?.state ?? null;
  }

  async savePlayer(accountId: number, username: string, state: PlayerProfile): Promise<void> {
    await this.pool.query(
      `INSERT INTO players (account_id, username, state, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id) DO UPDATE SET state = $3, updated_at = now()`,
      [accountId, username, JSON.stringify(state)],
    );
  }

  async loadMarketState(): Promise<unknown | null> {
    const res = await this.pool.query('SELECT state FROM market_state WHERE id = 1');
    return res.rows[0]?.state ?? null;
  }

  async saveMarketState(state: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_state (id, state, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = now()`,
      [JSON.stringify(state)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev/tests)
// ---------------------------------------------------------------------------

class MemDb implements Db {
  private accounts = new Map<string, AccountRow>();
  private tokens = new Map<string, { accountId: number; expiresAt: number }>();
  private players = new Map<number, PlayerProfile>();
  private market: unknown | null = null;
  private nextId = 1;

  async ready(): Promise<void> {}

  async createAccount(username: string, passwordHash: string): Promise<AccountRow> {
    if (this.accounts.has(username.toLowerCase())) throw Object.assign(new Error('unique violation'), { code: '23505' });
    const row: AccountRow = { id: this.nextId++, username, password_hash: passwordHash };
    this.accounts.set(username.toLowerCase(), row);
    return row;
  }

  async findAccount(username: string): Promise<AccountRow | null> {
    return this.accounts.get(username.toLowerCase()) ?? null;
  }

  async findAccountById(accountId: number): Promise<AccountRow | null> {
    for (const row of this.accounts.values()) {
      if (row.id === accountId) return row;
    }
    return null;
  }

  async touchLogin(): Promise<void> {}

  async saveToken(token: string, accountId: number, ttlHours = 24 * 7): Promise<void> {
    this.tokens.set(token, { accountId, expiresAt: Date.now() + ttlHours * 3600_000 });
  }

  async accountForToken(token: string): Promise<number | null> {
    const t = this.tokens.get(token);
    if (!t || t.expiresAt < Date.now()) return null;
    return t.accountId;
  }

  async loadPlayer(accountId: number): Promise<PlayerProfile | null> {
    const p = this.players.get(accountId);
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }

  async savePlayer(accountId: number, _username: string, state: PlayerProfile): Promise<void> {
    this.players.set(accountId, JSON.parse(JSON.stringify(state)));
  }

  async loadMarketState(): Promise<unknown | null> {
    return this.market;
  }

  async saveMarketState(state: unknown): Promise<void> {
    this.market = JSON.parse(JSON.stringify(state));
  }

  async close(): Promise<void> {}
}

export function createDb(): Db {
  const url = process.env.DATABASE_URL;
  if (url) return new PgDb(url);
  console.log('DATABASE_URL not set — using in-memory database (state lost on restart)');
  return new MemDb();
}
