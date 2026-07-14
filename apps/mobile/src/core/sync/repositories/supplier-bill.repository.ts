import { supplierBills } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalSupplierBill = typeof supplierBills.$inferSelect;

export const supplierBillRepository = createSyncedTableRepository({
  table: supplierBills,
  idColumn: supplierBills.id,
  guuidColumn: supplierBills.guuid,
  storeIdColumn: supplierBills.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    supplierFk: String(row.supplier_fk),
    billNo: (row.bill_no as string | null) ?? null,
    amountPaise: Number(row.amount_paise),
    billDate: (row.bill_date as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
