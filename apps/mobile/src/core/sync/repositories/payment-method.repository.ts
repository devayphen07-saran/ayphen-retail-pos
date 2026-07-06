import { paymentMethods } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalPaymentMethod = typeof paymentMethods.$inferSelect;

export const paymentMethodRepository = createSyncedTableRepository({
  table: paymentMethods,
  idColumn: paymentMethods.id,
  guuidColumn: paymentMethods.guuid,
  storeIdColumn: paymentMethods.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    code: String(row.code),
    label: String(row.label),
    kind: (row.kind as string | null) ?? null,
    sortOrder: (row.sort_order as number | null) ?? null,
    isSystem: (row.is_system as boolean | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
