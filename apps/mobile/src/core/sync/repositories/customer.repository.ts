import { customers } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalCustomer = typeof customers.$inferSelect;

export const customerRepository = createSyncedTableRepository({
  table: customers,
  idColumn: customers.id,
  guuidColumn: customers.guuid,
  storeIdColumn: customers.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    name: String(row.name),
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    gstNumber: (row.gst_number as string | null) ?? null,
    customerTypeLookupFk: (row.customer_type_lookup_fk as string | null) ?? null,
    creditLimit: row.credit_limit != null ? String(row.credit_limit) : null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
