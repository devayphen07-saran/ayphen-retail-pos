import { paymentAccounts } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalPaymentAccount = typeof paymentAccounts.$inferSelect;

export const paymentAccountRepository = createSyncedTableRepository({
  table: paymentAccounts,
  idColumn: paymentAccounts.id,
  guuidColumn: paymentAccounts.guuid,
  storeIdColumn: paymentAccounts.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    name: String(row.name),
    kind: (row.kind as string | null) ?? null,
    details: (row.details as unknown) ?? null,
    isDefault: (row.is_default as boolean | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    isSystem: (row.is_system as boolean | null) ?? null,
    systemKey: (row.system_key as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});