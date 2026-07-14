import { salePayments } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalSalePayment = typeof salePayments.$inferSelect;

/** Pull-only — see sale-line.repository.ts's comment. */
export const salePaymentRepository = createSyncedTableRepository({
  table: salePayments,
  idColumn: salePayments.id,
  guuidColumn: salePayments.guuid,
  storeIdColumn: salePayments.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    saleFk: String(row.sale_fk),
    accountFk: (row.account_fk as string | null) ?? null,
    tender: (row.tender as string | null) ?? null,
    amountPaise: Number(row.amount_paise),
    onCredit: (row.on_credit as boolean | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});