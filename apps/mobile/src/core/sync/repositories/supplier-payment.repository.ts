import { supplierPayments } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalSupplierPayment = typeof supplierPayments.$inferSelect;

export const supplierPaymentRepository = createSyncedTableRepository({
  table: supplierPayments,
  idColumn: supplierPayments.id,
  guuidColumn: supplierPayments.guuid,
  storeIdColumn: supplierPayments.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    supplierFk: String(row.supplier_fk),
    accountFk: String(row.account_fk),
    amountPaise: Number(row.amount_paise),
    paidAt: (row.paid_at as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});