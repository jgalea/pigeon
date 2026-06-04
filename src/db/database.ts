import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type DB = Database.Database

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'pigeon.sqlite'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'STOPPED',
      config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_state (
      session TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (session, key)
    );
    CREATE TABLE IF NOT EXISTS messages (
      session TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      from_me INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT,
      body TEXT,
      caption TEXT,
      media_path TEXT,
      raw TEXT,
      PRIMARY KEY (session, chat_id, msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (session, chat_id, timestamp);
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_status TEXT,
      next_retry_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `)
  return db
}
