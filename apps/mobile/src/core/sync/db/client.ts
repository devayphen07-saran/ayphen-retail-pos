import { openDatabaseSync } from 'expo-sqlite';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { migrations } from './migrations/migrations-data';
import * as schema from './schema';
import type { SyncDb, SyncSchema } from './types';

const DB_NAME = 'ayphen-sync.db';

let concreteDbSingleton: ExpoSQLiteDatabase<SyncSchema> | null = null;

function getConcreteDb(): ExpoSQLiteDatabase<SyncSchema> {
  if (!concreteDbSingleton) {
    const client = openDatabaseSync(DB_NAME, { enableChangeListener: true });
    concreteDbSingleton = drizzle(client, { schema });
  }
  return concreteDbSingleton;
}

/**
 * For screens using `useLiveQuery` (drizzle-orm/expo-sqlite/query) — that hook
 * needs the exact `ExpoSQLiteDatabase` type, not the widened cross-driver
 * `SyncDb` repositories are written against. Read-only call sites only;
 * writes still go through the repositories.
 */
export function getSyncDbForQueries(): ExpoSQLiteDatabase<SyncSchema> {
  return getConcreteDb();
}

/** The on-device sync DB. Opened once per process; expo-sqlite's connection
 *  is safe to share across the app (single writer, WAL-backed). Repositories
 *  are written against the driver-agnostic `SyncDb` type (see db/types.ts) —
 *  this is the one place that widening happens. */
export function getSyncDb(): SyncDb {
  return getConcreteDb() as unknown as SyncDb;
}

/**
 * Migrate-before-sync gate (INV-5, mobile-09 §4): must resolve before any
 * cold start / delta pull / mutation-queue drain touches the DB — a delta
 * landing on an un-migrated table is silent corruption, not a crash.
 * Idempotent: drizzle's migrator tracks applied migrations in its own table.
 * Uses the CONCRETE expo-sqlite type — `migrate()` needs the driver-specific
 * session, not the widened cross-driver `SyncDb`.
 */
export async function runMigrations(): Promise<void> {
  await migrate(getConcreteDb(), migrations);
}
