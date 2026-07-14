import { Injectable } from '@nestjs/common';
import { accountTransactions, openingBalances, customerLedgerEvents } from '#db/schema.js';
import type { DbTransaction } from '#db/db.module.js';
import type { MutationContext } from '../sync/push/mutation.types.js';

type CashMovementRow = {
  id: string;
  storeFk: string;
  accountFk: string;
  type: 'payin' | 'payout' | 'drop' | 'tip';
  amountPaise: number;
};

/** `cash_movements.type` → the ledger direction it posts (docs/prd/accounts-and-ledger.md D2:
 *  credit = money IN, debit = OUT). `tip` is posted as a credit for now — the
 *  drawer-vs-staff-owed distinction from the PRD isn't modeled yet; revisit
 *  when tip payout tracking is built. */
const CASH_MOVEMENT_DIRECTION: Record<CashMovementRow['type'], 'credit' | 'debit'> = {
  payin: 'credit',
  tip: 'credit',
  payout: 'debit',
  drop: 'debit',
};

/**
 * Derives `account_transactions` projection rows from money events, in the
 * SAME transaction as the event insert (docs/prd/accounts-and-ledger.md D1 /
 * SD-1) — the server is the projection's only writer; a client can never post
 * one directly (BR-3). Called from each event handler's `onInserted` hook.
 */
@Injectable()
export class AccountPostingService {
  async postCashMovement(
    tx: DbTransaction,
    movement: CashMovementRow,
    ctx: MutationContext,
  ): Promise<void> {
    await tx.insert(accountTransactions).values({
      storeFk: movement.storeFk,
      accountFk: movement.accountFk,
      direction: CASH_MOVEMENT_DIRECTION[movement.type],
      amountPaise: movement.amountPaise,
      reason: movement.type,
      sourceType: 'cash_movement',
      sourceFk: movement.id,
      createdBy: ctx.userId,
      deviceFk: ctx.deviceId,
    });
  }

  /**
   * F1 (docs/prd/accounts-and-ledger.md): a store's seeded account starts with
   * a real balance instead of zero. Server-authored only (StoreService.
   * createStore, same transaction as the account seed) — writes the event AND
   * its posting together since, unlike cash_movement, there is no separate
   * sync handler doing the event insert for this one.
   */
  async recordOpeningBalance(
    tx: DbTransaction,
    params: { storeFk: string; accountFk: string; amountPaise: number; userId: string },
  ): Promise<void> {
    const [event] = await tx
      .insert(openingBalances)
      .values({
        storeFk: params.storeFk,
        accountFk: params.accountFk,
        amountPaise: params.amountPaise,
        createdBy: params.userId,
      })
      .returning({ id: openingBalances.id });

    await tx.insert(accountTransactions).values({
      storeFk: params.storeFk,
      accountFk: params.accountFk,
      direction: 'credit',
      amountPaise: params.amountPaise,
      reason: 'opening_balance',
      sourceType: 'opening',
      sourceFk: event!.id,
      createdBy: params.userId,
    });
  }

  /**
   * F2 — one posting per `sale_payment` (split tender = multiple postings,
   * docs/prd/accounts-and-ledger.md AF-1). `sourceFk` is the sale_payment's
   * own id, not the sale's, so each tender line traces to its own posting.
   */
  async postSalePayment(
    tx: DbTransaction,
    params: { storeFk: string; accountFk: string; amountPaise: number; salePaymentId: string },
    ctx: MutationContext,
  ): Promise<void> {
    await tx.insert(accountTransactions).values({
      storeFk: params.storeFk,
      accountFk: params.accountFk,
      direction: 'credit',
      amountPaise: params.amountPaise,
      reason: 'sale',
      sourceType: 'sale',
      sourceFk: params.salePaymentId,
      createdBy: ctx.userId,
      deviceFk: ctx.deviceId,
    });
  }

  /**
   * F3 — a refund posts one debit to the account it was refunded from. Only
   * for the CASH portion of a refund — see postRefundCreditNote for the
   * portion that was originally sold on credit (no real account moves for
   * that part, so refund.handler.ts never calls this with that share).
   */
  async postRefund(
    tx: DbTransaction,
    params: { storeFk: string; accountFk: string; amountPaise: number; refundId: string },
    ctx: MutationContext,
  ): Promise<void> {
    await tx.insert(accountTransactions).values({
      storeFk: params.storeFk,
      accountFk: params.accountFk,
      direction: 'debit',
      amountPaise: params.amountPaise,
      reason: 'refund',
      sourceType: 'refund',
      sourceFk: params.refundId,
      createdBy: ctx.userId,
      deviceFk: ctx.deviceId,
    });
  }

  /**
   * F3 — the portion of a refund that reverses money the customer never
   * actually paid (it was on credit): reduces what they owe instead of
   * moving a real account. No account_transactions row, same reasoning as
   * postCreditSale. Called from refund.handler.ts alongside postRefund when
   * a refund spans both a credit and a cash portion of the original sale.
   */
  async postRefundCreditNote(
    tx: DbTransaction,
    params: { storeFk: string; customerFk: string; amountPaise: number; refundId: string },
    ctx: MutationContext,
  ): Promise<void> {
    await tx.insert(customerLedgerEvents).values({
      storeFk: params.storeFk,
      customerFk: params.customerFk,
      kind: 'credit_note',
      amountPaise: params.amountPaise,
      sourceType: 'refund',
      sourceFk: params.refundId,
      createdBy: ctx.userId,
    });
  }

  /**
   * F5 (docs/prd/accounts-and-ledger.md) — a credit sale posts NO account
   * posting; it moves only the customer's book. Called from
   * sale.handler.ts for the on-credit portion of a sale.
   */
  async postCreditSale(
    tx: DbTransaction,
    params: { storeFk: string; customerFk: string; amountPaise: number; saleId: string; flagged: boolean },
    ctx: MutationContext,
  ): Promise<void> {
    await tx.insert(customerLedgerEvents).values({
      storeFk: params.storeFk,
      customerFk: params.customerFk,
      kind: 'credit_sale',
      amountPaise: params.amountPaise,
      sourceType: 'sale',
      sourceFk: params.saleId,
      flagged: params.flagged,
      createdBy: ctx.userId,
    });
  }

  /**
   * F5 settlement — the double-entry moment: the customer's book moves down
   * (credit_sale reversed) AND the account book moves up (cash/bank in), in
   * the same transaction as customer-payment.handler.ts's allocation writes.
   */
  async postCustomerPayment(
    tx: DbTransaction,
    params: { storeFk: string; customerFk: string; accountFk: string; amountPaise: number; customerPaymentId: string },
    ctx: MutationContext,
  ): Promise<void> {
    await tx.insert(customerLedgerEvents).values({
      storeFk: params.storeFk,
      customerFk: params.customerFk,
      kind: 'payment',
      amountPaise: params.amountPaise,
      sourceType: 'customer_payment',
      sourceFk: params.customerPaymentId,
      createdBy: ctx.userId,
    });

    await tx.insert(accountTransactions).values({
      storeFk: params.storeFk,
      accountFk: params.accountFk,
      direction: 'credit',
      amountPaise: params.amountPaise,
      reason: 'credit_payment',
      sourceType: 'customer_payment',
      sourceFk: params.customerPaymentId,
      createdBy: ctx.userId,
      deviceFk: ctx.deviceId,
    });
  }

  /**
   * F6 (docs/prd/accounts-and-ledger.md) — paying a vendor. Unlike a customer
   * settlement there is no separate "book" event to post first: the vendor's
   * payable is `supplier_bills` itself (its status is derived from
   * allocations, see supplier-payment.handler.ts), so this posts only the
   * cash-out side.
   */
  async postSupplierPayment(
    tx: DbTransaction,
    params: { storeFk: string; accountFk: string; amountPaise: number; supplierPaymentId: string },
    ctx: MutationContext,
  ): Promise<void> {
    await tx.insert(accountTransactions).values({
      storeFk: params.storeFk,
      accountFk: params.accountFk,
      direction: 'debit',
      amountPaise: params.amountPaise,
      reason: 'vendor_payment',
      sourceType: 'supplier_payment',
      sourceFk: params.supplierPaymentId,
      createdBy: ctx.userId,
      deviceFk: ctx.deviceId,
    });
  }
}