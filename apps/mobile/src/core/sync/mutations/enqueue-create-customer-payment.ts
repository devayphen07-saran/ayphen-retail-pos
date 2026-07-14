import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { customerPaymentRepository } from '../repositories/customer-payment.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

const CUSTOMER_PAYMENT_MUTATION_PRIORITY = 10;

export interface CreateCustomerPaymentAllocationInput {
  saleGuuid: string;
  appliedPaise: number;
}

export interface CreateCustomerPaymentInput {
  customerId: string;
  customerGuuid: string;
  accountId: string;
  accountGuuid: string;
  allocations: CreateCustomerPaymentAllocationInput[];
}

/**
 * F5 settlement ("Collect payment") — composite mutation (header +
 * allocations, customer-payment.handler.ts). Only the `customer_payments`
 * header gets an optimistic local row, for the same reason
 * enqueue-create-sale.ts only writes `sales` — allocations have no
 * independent queue entry to reconcile against.
 */
export async function enqueueCreateCustomerPayment(
  storeId: string,
  input: CreateCustomerPaymentInput,
  guuid: string = Crypto.randomUUID(),
): Promise<string> {
  const mutationId = ulid();
  const now = new Date().toISOString();
  const amountPaise = input.allocations.reduce((sum, a) => sum + a.appliedPaise, 0);

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await customerPaymentRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        customer_fk: input.customerId,
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
      entityType: 'customer_payment',
      entityGuuid: guuid,
      action: 'create',
      priority: CUSTOMER_PAYMENT_MUTATION_PRIORITY,
      payload: {
        guuid,
        customer_guuid: input.customerGuuid,
        account_guuid: input.accountGuuid,
        allocations: input.allocations.map((a) => ({ sale_guuid: a.saleGuuid, applied_paise: a.appliedPaise })),
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}
