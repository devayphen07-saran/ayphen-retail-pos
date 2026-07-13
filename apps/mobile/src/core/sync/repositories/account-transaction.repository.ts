import { accountTransactions } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalAccountTransaction = typeof accountTransactions.$inferSelect;

/** Pull-only (BR-3, docs/prd/accounts-and-ledger.md) — the server derives
 *  every row; this repository's `upsertAll`/`deleteByGuuids` are only ever
 *  called by the pull applier, never by app code writing directly. */
export const accountTransactionRepository = createSyncedTableRepository({
  table: accountTransactions,
  idColumn: accountTransactions.id,
  guuidColumn: accountTransactions.guuid,
  storeIdColumn: accountTransactions.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    accountFk: String(row.account_fk),
    direction: (row.direction as string | null) ?? null,
    amountPaise: Number(row.amount_paise),
    reason: (row.reason as string | null) ?? null,
    sourceType: (row.source_type as string | null) ?? null,
    sourceFk: (row.source_fk as string | null) ?? null,
    shiftSessionFk: (row.shift_session_fk as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});