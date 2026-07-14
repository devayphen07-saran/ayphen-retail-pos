import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { supplierBillRepository } from '../repositories/supplier-bill.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

/** Money mutations drain before master-data edits — same reasoning as
 *  enqueue-create-cash-movement.ts's constant of the same shape. */
const SUPPLIER_BILL_MUTATION_PRIORITY = 10;

export interface CreateSupplierBillInput {
  supplierId: string;
  supplierGuuid: string;
  billNo?: string;
  amountPaise: number;
  billDate?: string; // ISO
  dueDate?: string; // ISO
  notes?: string;
}

/** F6 (docs/prd/accounts-and-ledger.md) — recording what a vendor billed us.
 *  A flat, single-row create — no composite children, unlike sale/refund. */
export async function enqueueCreateSupplierBill(
  storeId: string,
  input: CreateSupplierBillInput,
  guuid: string = Crypto.randomUUID(),
): Promise<string> {
  const mutationId = ulid();
  const now = new Date().toISOString();

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await supplierBillRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        supplier_fk: input.supplierId,
        bill_no: input.billNo ?? null,
        amount_paise: input.amountPaise,
        bill_date: input.billDate ?? now,
        due_date: input.dueDate ?? null,
        status: 'open',
        notes: input.notes ?? null,
        row_version: 0,
        modified_at: now,
      },
    ]);

    await mutationQueueRepository.enqueue(tx, {
      mutationId,
      storeId,
      entityType: 'supplier_bill',
      entityGuuid: guuid,
      action: 'create',
      priority: SUPPLIER_BILL_MUTATION_PRIORITY,
      payload: {
        guuid,
        supplier_guuid: input.supplierGuuid,
        bill_no: input.billNo,
        amount_paise: input.amountPaise,
        bill_date: input.billDate,
        due_date: input.dueDate,
        notes: input.notes,
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}