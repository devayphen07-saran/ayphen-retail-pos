import { paymentAllocations } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalPaymentAllocation = typeof paymentAllocations.$inferSelect;

/** Pull-only — written solely by customer-payment.handler.ts. */
export const paymentAllocationRepository = createSyncedTableRepository({
  table: paymentAllocations,
  idColumn: paymentAllocations.id,
  guuidColumn: paymentAllocations.guuid,
  storeIdColumn: paymentAllocations.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    paymentFk: String(row.payment_fk),
    targetType: (row.target_type as string | null) ?? null,
    targetFk: String(row.target_fk),
    appliedPaise: Number(row.applied_paise),
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
