import { taxRates } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalTaxRate = typeof taxRates.$inferSelect;

export const taxRateRepository = createSyncedTableRepository({
  table: taxRates,
  idColumn: taxRates.id,
  guuidColumn: taxRates.guuid,
  storeIdColumn: taxRates.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    name: String(row.name),
    ratePercent: String(row.rate_percent),
    isInclusive: (row.is_inclusive as boolean | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
