import { customerPayments } from '../db/schema';
import { createSyncedTableRepository, type WireRow } from './synced-table.repository';

export type LocalCustomerPayment = typeof customerPayments.$inferSelect;

export const customerPaymentRepository = createSyncedTableRepository({
  table: customerPayments,
  idColumn: customerPayments.id,
  guuidColumn: customerPayments.guuid,
  storeIdColumn: customerPayments.storeId,
  fromWire: (row: WireRow, storeId: string) => ({
    id: String(row.id),
    storeId,
    guuid: String(row.guuid),
    customerFk: String(row.customer_fk),
    accountFk: String(row.account_fk),
    amountPaise: Number(row.amount_paise),
    paidAt: (row.paid_at as string | null) ?? null,
    rowVersion: Number(row.row_version),
    modifiedAt: String(row.modified_at),
  }),
});
