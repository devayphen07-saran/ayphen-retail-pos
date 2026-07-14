import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { saleRepository } from '../repositories/sale.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

/** Revenue mutations drain before master-data edits — same reasoning as
 *  enqueue-create-cash-movement.ts. */
const SALE_MUTATION_PRIORITY = 10;

export interface CreateSaleLineInput {
  /** The product's resolved LOCAL id (already in hand from the product list
   *  the cart was built from — no null-placeholder-then-resolve needed). */
  productId: string;
  productGuuid: string;
  qty: number;
  unitPricePaise: number;
  discountPaise?: number;
}

export interface CreateSalePaymentInput {
  tender: 'cash' | 'card' | 'upi' | 'wallet' | 'other';
  amountPaise: number;
  /** Absent exactly when `onCredit` is true (F5, Phase 3) — mirrors the
   *  server's ck_sale_payments_credit_has_no_account constraint. */
  accountId?: string;
  accountGuuid?: string;
  onCredit?: boolean;
}

export interface CreateSaleInput {
  lines: CreateSaleLineInput[];
  payments: CreateSalePaymentInput[];
  /** Required when any payment is on_credit (BR-2/V-5). */
  customerGuuid?: string;
}

function lineTotalPaise(l: CreateSaleLineInput): number {
  return Math.round(l.qty * l.unitPricePaise) - (l.discountPaise ?? 0);
}

/**
 * F2/F5 (docs/prd/accounts-and-ledger.md) — a sale, pushed as ONE composite
 * mutation (header + lines + payments together — see sale.handler.ts for
 * why), so unlike enqueue-create-supplier.ts this only writes an optimistic
 * LOCAL row for the sale header, not its lines/payments: those have no
 * independent queue entry of their own, so the generic drain-queue
 * reconciliation (drain-queue.ts's `commit-applied`, which deletes the
 * temp-id row by guuid and upserts the server's real row) has no way to
 * reconcile them — a locally-written sale_line would sit forever under a
 * client-generated id while the authoritative row arrives separately via the
 * next pull under the server's real id, showing every item twice. The line/
 * payment breakdown is populated by that pull instead — it lands in the SAME
 * round-trip as the sale's own reconciliation, so in practice there's no
 * visible gap once the request completes.
 */
export async function enqueueCreateSale(
  storeId: string,
  input: CreateSaleInput,
  guuid: string = Crypto.randomUUID(),
): Promise<string> {
  const mutationId = ulid();
  const now = new Date().toISOString();
  const totalPaise = input.lines.reduce((sum, l) => sum + lineTotalPaise(l), 0);

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await saleRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        customer_fk: null, // resolved server-side from customer_guuid; filled in by the next pull
        total_paise: totalPaise,
        status: 'completed',
        invoice_no: null, // server-assigned; filled in once the pull lands
        sold_at: now,
        row_version: 0,
        modified_at: now,
      },
    ]);

    await mutationQueueRepository.enqueue(tx, {
      mutationId,
      storeId,
      entityType: 'sale',
      entityGuuid: guuid,
      action: 'create',
      priority: SALE_MUTATION_PRIORITY,
      payload: {
        guuid,
        customer_guuid: input.customerGuuid,
        lines: input.lines.map((l) => ({
          product_guuid: l.productGuuid,
          qty: l.qty,
          unit_price_paise: l.unitPricePaise,
          discount_paise: l.discountPaise,
        })),
        payments: input.payments.map((p) => ({
          account_guuid: p.accountGuuid,
          tender: p.tender,
          amount_paise: p.amountPaise,
          on_credit: p.onCredit,
        })),
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}
