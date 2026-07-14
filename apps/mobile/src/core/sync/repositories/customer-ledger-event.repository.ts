import { customerLedgerEvents } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalCustomerLedgerEvent = typeof customerLedgerEvents.$inferSelect;

/** Pull-only (BR-3-style) — server-derived, written by sale.handler.ts's
 *  credit portion and customer-payment.handler.ts's settlement. */
export const customerLedgerEventRepository = createSyncedTableRepository({
  table: customerLedgerEvents,
  idColumn: customerLedgerEvents.id,
  guuidColumn: customerLedgerEvents.guuid,
  storeIdColumn: customerLedgerEvents.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    customerFk: String(row.customer_fk),
    kind: (row.kind as string | null) ?? null,
    amountPaise: Number(row.amount_paise),
    sourceType: (row.source_type as string | null) ?? null,
    sourceFk: (row.source_fk as string | null) ?? null,
    flagged: (row.flagged as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
