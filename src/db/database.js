import pg from "pg";

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function initDatabase() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS naver_sessions (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform        TEXT NOT NULL DEFAULT 'smartplace',
        session_data    TEXT NOT NULL,
        label           TEXT DEFAULT '',
        expires_at      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, platform)
      );

      CREATE TABLE IF NOT EXISTS configs (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform        TEXT NOT NULL DEFAULT 'smartplace',
        config_json     JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, platform)
      );

      CREATE TABLE IF NOT EXISTS run_logs (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform        TEXT NOT NULL,
        mode            TEXT NOT NULL DEFAULT 'dry-run',
        status          TEXT NOT NULL DEFAULT 'running',
        scanned         INTEGER DEFAULT 0,
        processed       INTEGER DEFAULT 0,
        exit_code       INTEGER,
        started_at      TIMESTAMPTZ DEFAULT NOW(),
        ended_at        TIMESTAMPTZ,
        log_text        TEXT DEFAULT ''
      );
    `);
    console.log("[db] 테이블 초기화 완료");
  } finally {
    client.release();
  }
}
