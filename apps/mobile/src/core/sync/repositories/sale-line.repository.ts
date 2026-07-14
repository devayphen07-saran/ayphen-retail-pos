import { saleLines } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalSaleLine = typeof saleLines.$inferSelect;

/** Pull-only — written locally only as part of enqueue-create-sale.ts's
 *  composite write; never independently pushed (see schema.ts's comment). */
export const saleLineRepository = createSyncedTableRepository({
  table: saleLines,
  idColumn: saleLines.id,
  guuidColumn: saleLines.guuid,
  storeIdColumn: saleLines.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    saleFk: String(row.sale_fk),
    productFk: String(row.product_fk),
    qty: String(row.qty),
    unitPricePaise: Number(row.unit_price_paise),
    discountPaise: Number(row.discount_paise),
    lineTotalPaise: Number(row.line_total_paise),
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});