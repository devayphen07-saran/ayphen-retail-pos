import { lookups } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalLookup = typeof lookups.$inferSelect;

/** `store_fk` is nullable on the SERVER — lookup is global-or-store
 *  (globalOrStoreScope). A global row is still pulled per-store, and we stamp
 *  the active store on it locally for a uniform WHERE — so the conflict
 *  target is the table's composite (storeId, id) PK, not `id` alone: the same
 *  global lookup id synced under two different stores must upsert as two
 *  independent local rows, not clobber each other's storeId (schema.ts). */
export const lookupRepository = createSyncedTableRepository({
  table: lookups,
  idColumn: lookups.id,
  guuidColumn: lookups.guuid,
  storeIdColumn: lookups.storeId,
  conflictTarget: [lookups.storeId, lookups.id],
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    lookupTypeFk: String(row.lookup_type_fk),
    code: String(row.code),
    label: String(row.label),
    description: (row.description as string | null) ?? null,
    sortOrder: (row.sort_order as number | null) ?? null,
    isHidden: (row.is_hidden as boolean | null) ?? null,
    isSystem: (row.is_system as boolean | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
