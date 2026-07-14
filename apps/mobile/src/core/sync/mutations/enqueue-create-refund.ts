import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { refundRepository } from '../repositories/refund.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

const REFUND_MUTATION_PRIORITY = 10;

export interface CreateRefundLineInput {
  saleLineGuuid: string;
  qty: number;
  /** For the LOCAL optimistic total only — the server recomputes each line's
   *  refund amount proportionally from the original sale_line's total
   *  (refund.handler.ts), so this estimate never has to be exact. */
  estimatedUnitPricePaise: number;
}

export interface CreateRefundInput {
  /** The original sale's resolved LOCAL id — already in hand (the refund
   *  screen is reached from that sale's own detail view). */
  saleId: string;
  saleGuuid: string;
  accountId: string;
  accountGuuid: string;
  reason?: string;
  lines: CreateRefundLineInput[];
}

/**
 * F3 — a refund against a completed/partially-refunded sale. Composite
 * mutation (header + lines together, refund.handler.ts); only the `refunds`
 * header gets an optimistic local row, for the same reason
 * enqueue-create-sale.ts only writes `sales` — refund_lines have no
 * independent queue entry to reconcile against, so they arrive via the next
 * pull instead of being written speculatively here.
 */
export async function enqueueCreateRefund(
  storeId: string,
  input: CreateRefundInput,
  guuid: string = Crypto.randomUUID(),
): Promise<string> {
  const mutationId = ulid();
  const now = new Date().toISOString();
  const estimatedAmountPaise = input.lines.reduce(
    (sum, l) => sum + Math.round(l.qty * l.estimatedUnitPricePaise),
    0,
  );

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await refundRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        sale_fk: input.saleId,
        account_fk: input.accountId,
        amount_paise: estimatedAmountPaise,
        reason: input.reason ?? null,
        refunded_at: now,
        row_version: 0,
        modified_at: now,
      },
    ]);

    await mutationQueueRepository.enqueue(tx, {
      mutationId,
      storeId,
      entityType: 'refund',
      entityGuuid: guuid,
      action: 'create',
      priority: REFUND_MUTATION_PRIORITY,
      payload: {
        guuid,
        sale_guuid: input.saleGuuid,
        account_guuid: input.accountGuuid,
        reason: input.reason,
        lines: input.lines.map((l) => ({ sale_line_guuid: l.saleLineGuuid, qty: l.qty })),
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}