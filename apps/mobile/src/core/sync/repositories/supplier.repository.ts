import { suppliers } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalSupplier = typeof suppliers.$inferSelect;

export const supplierRepository = createSyncedTableRepository({
  table: suppliers,
  idColumn: suppliers.id,
  guuidColumn: suppliers.guuid,
  storeIdColumn: suppliers.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    name: String(row.name),
    displayName: (row.display_name as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    logoUri: (row.logo_uri as string | null) ?? null,
    gstNumber: (row.gst_number as string | null) ?? null,
    panNumber: (row.pan_number as string | null) ?? null,
    paymentTermLookupFk: (row.payment_term_lookup_fk as string | null) ?? null,
    paymentTermDays: (row.payment_term_days as number | null) ?? null,
    creditLimit: row.credit_limit != null ? String(row.credit_limit) : null,
    overrideCreditLimit: (row.override_credit_limit as boolean | null) ?? null,
    addressLine1: (row.address_line_1 as string | null) ?? null,
    addressLine2: (row.address_line_2 as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    stateLookupFk: (row.state_lookup_fk as string | null) ?? null,
    pinCode: (row.pin_code as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});