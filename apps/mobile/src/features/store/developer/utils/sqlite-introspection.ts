import { sql } from 'drizzle-orm';
import type { SyncDb } from '@core/sync/db/types';

/**
 * Raw introspection of the on-device SQLite file for the "Local Tables"
 * debug screen. Deliberately reads `sqlite_master`/`PRAGMA table_info`
 * instead of iterating the Drizzle `schema.ts` exports — this way the
 * browser also surfaces tables Drizzle itself creates outside the SQL
 * migration files (e.g. its `__drizzle_migrations` tracker) and stays
 * correct without edits whenever a table is added to schema.ts.
 */

export const LOCAL_TABLE_ROW_LIMIT = 200;

export interface LocalTableSummary {
  name: string;
  rowCount: number;
}

export interface LocalTableColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

export async function listLocalTables(db: SyncDb): Promise<LocalTableSummary[]> {
  const tables = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return Promise.all(
    tables.map(async ({ name }) => ({
      name,
      rowCount: await getLocalTableRowCount(db, name),
    })),
  );
}

export async function getLocalTableRowCount(db: SyncDb, tableName: string): Promise<number> {
  const [row] = await db.all<{ count: number }>(
    sql`SELECT COUNT(*) as count FROM ${sql.identifier(tableName)}`,
  );
  return row?.count ?? 0;
}

export async function getLocalTableColumns(db: SyncDb, tableName: string): Promise<LocalTableColumn[]> {
  const rows = await db.all<{ name: string; type: string; notnull: number; pk: number }>(
    sql`PRAGMA table_info(${sql.identifier(tableName)})`,
  );
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    notNull: row.notnull === 1,
    primaryKey: row.pk > 0,
  }));
}

/** Capped at LOCAL_TABLE_ROW_LIMIT — this is a debug viewer, not a paginated
 *  data browser; callers should show `getLocalTableRowCount` alongside this
 *  so a truncated view is visible rather than silently passing for "all". */
export async function getLocalTableRows(
  db: SyncDb,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  return db.all<Record<string, unknown>>(
    sql`SELECT * FROM ${sql.identifier(tableName)} LIMIT ${LOCAL_TABLE_ROW_LIMIT}`,
  );
}
