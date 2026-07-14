import { sales } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalSale = typeof sales.$inferSelect;

export const saleRepository = createSyncedTableRepository({
  table: sales,
  idColumn: sales.id,
  guuidColumn: sales.guuid,
  storeIdColumn: sales.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    customerFk: (row.customer_fk as string | null) ?? null,
    totalPaise: Number(row.total_paise),
    status: (row.status as string | null) ?? null,
    invoiceNo: (row.invoice_no as string | null) ?? null,
    soldAt: (row.sold_at as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
