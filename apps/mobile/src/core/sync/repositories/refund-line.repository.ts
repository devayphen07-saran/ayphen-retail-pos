import { refundLines } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalRefundLine = typeof refundLines.$inferSelect;

/** Pull-only — see sale-line.repository.ts's comment. */
export const refundLineRepository = createSyncedTableRepository({
  table: refundLines,
  idColumn: refundLines.id,
  guuidColumn: refundLines.guuid,
  storeIdColumn: refundLines.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    refundFk: String(row.refund_fk),
    saleLineFk: String(row.sale_line_fk),
    qty: String(row.qty),
    amountPaise: Number(row.amount_paise),
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});