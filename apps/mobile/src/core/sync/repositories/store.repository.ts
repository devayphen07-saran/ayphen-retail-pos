import { stores } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalStore = typeof stores.$inferSelect;

export const storeRepository = createSyncedTableRepository({
  table: stores,
  idColumn: stores.id,
  guuidColumn: stores.guuid,
  storeIdColumn: stores.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    guuid: String(row.guuid),
    storeId,
    name: String(row.name),
    gstNumber: (row.gst_number as string | null) ?? null,
    address: row.address != null ? JSON.stringify(row.address) : null,
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    invoicePrefix: (row.invoice_prefix as string | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    locked: (row.locked as boolean | null) ?? null,
    modifiedAt: String(row.modified_at),
  }),
});
