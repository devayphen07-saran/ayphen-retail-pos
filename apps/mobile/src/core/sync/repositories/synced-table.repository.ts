import { eq, inArray, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { SQLiteTable, SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { SyncDb } from '../db/types';

/** A pulled row: snake_case keys, exactly as the server's toWireRow() renders it. */
export type WireRow = Record<string, unknown>;

/**
 * `set: { col: excluded.col, ... }` for every column except the ones passed —
 * mirrors the backend's own `getTableColumns` + explicit-column-set pattern
 * (master-data.handler.ts) rather than hand-listing every field per table.
 */
function conflictUpdateSet<T extends SQLiteTable>(
  table: T,
  excludeKeys: string[],
): Record<string, SQL> {
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(columns)) {
    if (excludeKeys.includes(key)) continue;
    set[key] = sql.raw(`excluded.${column.name}`);
  }
  return set;
}

export interface SyncedTableConfig<
  TTable extends SQLiteTable,
  TRow extends WireRow,
> {
  table: TTable;
  idColumn: SQLiteColumn;
  guuidColumn: SQLiteColumn;
  storeIdColumn: SQLiteColumn;
  /**
   * The upsert conflict target — defaults to `[idColumn]`. Override for a
   * table whose PK is composite (e.g. `lookups`' `(storeId, id)` — a global
   * lookup row shares the SAME `id` across every store that pulls it, so `id`
   * alone as the target would let one store's sync overwrite another
   * store's local `storeId` stamp on that shared row; see schema.ts's comment
   * on that table). Must match the table's actual declared primary key
   * exactly, or SQLite rejects the `ON CONFLICT` clause at insert time.
   */
  conflictTarget?: SQLiteColumn[];
  /**
   * Wire row (snake_case, from /sync/initial or /sync/changes) → Drizzle
   * insert shape (camelCase). `storeId` is passed separately, NOT read off
   * the wire row — the pull is already scoped to one store
   * (`/stores/:storeId/sync/...`), so the server's wire projection doesn't
   * repeat `store_fk` on every row (verified against sync-filter.registry.ts's
   * column selections).
   */
  fromWire: (row: WireRow, storeId: string) => TRow;
}

/**
 * One synced table's local repository — upsert-by-id (idempotent, matches
 * pull semantics: the same row re-delivered is a no-op overwrite) and
 * delete-by-guuid (tombstone application). Mirrors the backend's
 * GenericSyncFilter/MasterDataSyncHandler pairing 1:1 so the two sides stay
 * easy to cross-reference.
 */
export function createSyncedTableRepository<
  TTable extends SQLiteTable,
  TRow extends WireRow,
>(cfg: SyncedTableConfig<TTable, TRow>) {
  const conflictColumns = cfg.conflictTarget ?? [cfg.idColumn];
  const conflictKeys = conflictColumns.map((col) => columnKey(cfg.table, col));

  return {
    /** Idempotent upsert-by-conflict-target — safe to call with a page that
     *  includes rows already applied (cold-start resume, idempotent
     *  re-delivery). */
    async upsertAll(
      db: SyncDb,
      storeId: string,
      rows: WireRow[],
    ): Promise<void> {
      if (rows.length === 0) return;
      const values = rows.map((row) => cfg.fromWire(row, storeId));
      await db
        .insert(cfg.table)
        .values(values as never)
        .onConflictDoUpdate({
          target: conflictColumns,
          set: conflictUpdateSet(cfg.table, conflictKeys),
        });
    },

    /** Tombstone application — a hard delete locally regardless of how the
     *  server soft-deletes (the client never needs the deleted row again). */
    async deleteByGuuids(db: SyncDb, guuids: string[]): Promise<void> {
      if (guuids.length === 0) return;
      await db.delete(cfg.table).where(inArray(cfg.guuidColumn, guuids));
    },

    async listByStore(db: SyncDb, storeId: string): Promise<TRow[]> {
      return db
        .select()
        .from(cfg.table)
        .where(eq(cfg.storeIdColumn, storeId)) as Promise<TRow[]>;
    },

    async findByGuuid(db: SyncDb, guuid: string): Promise<TRow | null> {
      const [row] = await db
        .select()
        .from(cfg.table)
        .where(eq(cfg.guuidColumn, guuid))
        .limit(1);
      return (row as TRow) ?? null;
    },
  };
}

/** The camelCase key a column lands under in Drizzle's insert/select shape. */
function columnKey(table: SQLiteTable, column: SQLiteColumn): string {
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  for (const [key, col] of Object.entries(columns)) {
    if (col === column) return key;
  }
  throw new Error(
    `[sync] column '${column.name}' is not part of this table's metadata`,
  );
}
