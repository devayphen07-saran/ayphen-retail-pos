import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../schema';
import type { SyncDb } from '../types';

/**
 * Test-only DB — never imported from app code (better-sqlite3 is a Node
 * native module; Metro would fail to bundle it). Runs the SAME migration SQL
 * the app runs (drizzle-kit's dialect: 'sqlite' output is driver-agnostic),
 * against a real in-memory SQLite engine — not a mock. This is what lets
 * repository/queue tests verify actual transaction/rollback behavior.
 */
export function createTestDb(): SyncDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(__dirname, '../migrations') });
  return db as unknown as SyncDb;
}
