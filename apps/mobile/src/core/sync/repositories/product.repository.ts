import { products } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalProduct = typeof products.$inferSelect;

/** `unit_fk`/`taxrate_fk`/`category_lookup_fk` on the wire are the referenced
 *  row's local `id` (the pull projection selects the resolved FK column, not
 *  a guuid) — this is the read-side shape; mutation payloads going the other
 *  way (push) resolve by guuid instead (product.handler.ts), so a Phase-2
 *  mutation builder must translate id → guuid when queuing a write. */
export const productRepository = createSyncedTableRepository({
  table: products,
  idColumn: products.id,
  guuidColumn: products.guuid,
  storeIdColumn: products.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    name: String(row.name),
    sku: (row.sku as string | null) ?? null,
    barcode: (row.barcode as string | null) ?? null,
    categoryLookupFk: (row.category_lookup_fk as string | null) ?? null,
    unitFk: (row.unit_fk as string | null) ?? null,
    taxrateFk: (row.taxrate_fk as string | null) ?? null,
    sellingPrice: String(row.selling_price),
    costPrice: row.cost_price != null ? String(row.cost_price) : null,
    mrp: row.mrp != null ? String(row.mrp) : null,
    hsnCode: (row.hsn_code as string | null) ?? null,
    trackInventory: (row.track_inventory as boolean | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
