import { refunds } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalRefund = typeof refunds.$inferSelect;

export const refundRepository = createSyncedTableRepository({
  table: refunds,
  idColumn: refunds.id,
  guuidColumn: refunds.guuid,
  storeIdColumn: refunds.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    saleFk: String(row.sale_fk),
    accountFk: String(row.account_fk),
    amountPaise: Number(row.amount_paise),
    reason: (row.reason as string | null) ?? null,
    refundedAt: (row.refunded_at as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});