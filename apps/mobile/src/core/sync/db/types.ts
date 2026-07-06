import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core/db';
import type * as schema from './schema';

/**
 * The type every repository/applier is written against — satisfied by BOTH
 * the real runtime driver (drizzle-orm/expo-sqlite) and the test driver
 * (drizzle-orm/better-sqlite3, real SQLite, no mocking). Repository code never
 * imports either driver directly, so the same logic runs against a real
 * on-device DB and a real in-memory DB in Jest.
 */
export type SyncSchema = typeof schema;
export type SyncDb = BaseSQLiteDatabase<'sync', unknown, SyncSchema>;
