import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { supplierPaymentRepository } from '../repositories/supplier-payment.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

const SUPPLIER_PAYMENT_MUTATION_PRIORITY = 10;

export interface CreateSupplierPaymentAllocationInput {
  billGuuid: string;
  appliedPaise: number;
}

export interface CreateSupplierPaymentInput {
  supplierId: string;
  supplierGuuid: string;
  accountId: string;
  accountGuuid: string;
  allocations: CreateSupplierPaymentAllocationInput[];
}

/**
 * F6 settlement ("enter payment... select account... and pay") — composite
 * mutation (header + allocations, supplier-payment.handler.ts). Only the
 * `supplier_payments` header gets an optimistic local row, for the same
 * reason enqueue-create-sale.ts only writes `sales` — allocations have no
 * independent queue entry to reconcile against. The signature (if captured)
 * is attached separately via the record-guuid attachments pipeline once this
 * payment's create mutation has synced — see SupplierPaymentSignatureField.
 */
export async function enqueueCreateSupplierPayment(
  storeId: string,
  input: CreateSupplierPaymentInput,
  guuid: string = Crypto.randomUUID(),
): Promise<string> {
  const mutationId = ulid();
  const now = new Date().toISOString();
  const amountPaise = input.allocations.reduce((sum, a) => sum + a.appliedPaise, 0);

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await supplierPaymentRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        supplier_fk: input.supplierId,
        account_fk: input.accountId,
        amount_paise: amountPaise,
        paid_at: now,
        row_version: 0,
        modified_at: now,
      },
    ]);

    await mutationQueueRepository.enqueue(tx, {
      mutationId,
      storeId,
      entityType: 'supplier_payment',
      entityGuuid: guuid,
      action: 'create',
      priority: SUPPLIER_PAYMENT_MUTATION_PRIORITY,
      payload: {
        guuid,
        supplier_guuid: input.supplierGuuid,
        account_guuid: input.accountGuuid,
        allocations: input.allocations.map((a) => ({ bill_guuid: a.billGuuid, applied_paise: a.appliedPaise })),
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}