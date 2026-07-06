import { productCases } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalProductCase = typeof productCases.$inferSelect;

export const productCaseRepository = createSyncedTableRepository({
  table: productCases,
  idColumn: productCases.id,
  guuidColumn: productCases.guuid,
  storeIdColumn: productCases.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    productFk: String(row.product_fk),
    name: String(row.name),
    quantity: String(row.quantity),
    barcode: (row.barcode as string | null) ?? null,
    sellingPrice: row.selling_price != null ? String(row.selling_price) : null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
