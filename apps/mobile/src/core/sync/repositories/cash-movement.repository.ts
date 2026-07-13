import { cashMovements } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalCashMovement = typeof cashMovements.$inferSelect;

export const cashMovementRepository = createSyncedTableRepository({
  table: cashMovements,
  idColumn: cashMovements.id,
  guuidColumn: cashMovements.guuid,
  storeIdColumn: cashMovements.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    accountFk: String(row.account_fk),
    type: (row.type as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    amountPaise: Number(row.amount_paise),
    byUserFk: (row.by_user_fk as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});