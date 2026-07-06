import { units } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalUnit = typeof units.$inferSelect;

export const unitRepository = createSyncedTableRepository({
  table: units,
  idColumn: units.id,
  guuidColumn: units.guuid,
  storeIdColumn: units.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    name: String(row.name),
    abbreviation: (row.abbreviation as string | null) ?? null,
    allowsFractions: (row.allows_fractions as boolean | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
