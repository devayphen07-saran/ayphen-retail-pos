import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ErrorCodes } from '#common/error-codes.js';
import { customerPayments, paymentAllocations, sales, salePayments, customers, paymentAccounts, customerLedgerEvents, refunds } from '#db/schema.js';
import { SyncWireMapper } from '../../mappers/response/sync-wire.mapper.js';
import { AccountPostingService } from '../../../ledger/account-posting.service.js';
import type { HandlerOutcome, MutationAction, MutationContext, SyncMutationHandler } from '../mutation.types.js';
import type { SyncEntityType } from '../../sync.constants.js';

const allocationSchema = z.object({
  sale_guuid: z.uuid(),
  applied_paise: z.number().int().positive(),
});

const createSchema = z.object({
  guuid: z.uuid(),
  customer_guuid: z.uuid(),
  account_guuid: z.uuid(),
  allocations: z.array(allocationSchema).min(1, 'A payment needs at least one sale to settle.'),
});

const rejected = (
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
): HandlerOutcome => ({ kind: 'rejected', code, message, conflictType: 'VALIDATION' });

/**
 * F5 settlement (docs/prd/accounts-and-ledger.md D10) — "Collect payment":
 * a customer pays down one or more of their credit sales in one composite
 * mutation (header + allocations, one transaction). This is the double-entry
 * moment — the customer's book moves down, a real account's book moves up
 * (AccountPostingService.postCustomerPayment) — matched to SPECIFIC sales via
 * `payment_allocations`, not a lump balance (D10).
 *
 * BR-5 (Σ allocations ≤ payment amount) holds by construction — amount_paise
 * is always the sum of allocations, never client-supplied. BR-6 (Σ allocated
 * ≤ that sale's remaining credit) is the real check below.
 */
@Injectable()
export class CustomerPaymentMutationHandler implements SyncMutationHandler {
  readonly entityType: SyncEntityType = 'customer_payment';
  readonly permissionEntity = 'Customer' as const;

  constructor(private readonly posting: AccountPostingService) {}

  async apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    _expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    if (action !== 'create') {
      return rejected(ErrorCodes.VALIDATION_FAILED, 'customer_payment is append-only');
    }

    const parsed = createSchema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      return rejected(ErrorCodes.VALIDATION_FAILED, detail || 'invalid payload');
    }
    const data = parsed.data;

    // ── Resolve customer / account / target sales — independent lookups, run
    // together rather than as three sequential round-trips ─────────────────
    const saleGuuids = [...new Set(data.allocations.map((a) => a.sale_guuid))];
    const [[customer], [account], saleRows] = await Promise.all([
      ctx.tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.guuid, data.customer_guuid), eq(customers.storeFk, ctx.storeId), isNull(customers.deletedAt)))
        .limit(1),
      ctx.tx
        .select({ id: paymentAccounts.id, isActive: paymentAccounts.isActive })
        .from(paymentAccounts)
        .where(and(eq(paymentAccounts.guuid, data.account_guuid), eq(paymentAccounts.storeFk, ctx.storeId), isNull(paymentAccounts.deletedAt)))
        .limit(1),
      ctx.tx
        .select({ id: sales.id, guuid: sales.guuid, customerFk: sales.customerFk })
        .from(sales)
        .where(and(inArray(sales.guuid, saleGuuids), eq(sales.storeFk, ctx.storeId))),
    ]);

    if (!customer) {
      return { kind: 'rejected', code: ErrorCodes.CUSTOMER_NOT_FOUND, message: 'This customer could not be found.', conflictType: 'BUSINESS_RULE' };
    }
    if (!account) return rejected(ErrorCodes.VALIDATION_FAILED, `unknown account: ${data.account_guuid}`);
    if (!account.isActive) {
      return { kind: 'rejected', code: ErrorCodes.ACCOUNT_INACTIVE, message: "This account is inactive and can't be used.", conflictType: 'BUSINESS_RULE' };
    }

    // ── Each target sale must belong to THIS customer ───────────────────────
    const saleByGuuid = new Map(saleRows.map((s) => [s.guuid, s]));
    for (const g of saleGuuids) {
      const sale = saleByGuuid.get(g);
      if (!sale || sale.customerFk !== customer.id) {
        return { kind: 'rejected', code: ErrorCodes.SALE_NOT_FOUND, message: 'One of these sales could not be found for this customer.', conflictType: 'BUSINESS_RULE' };
      }
    }

    // ── BR-6: each allocation ≤ that sale's remaining credit ────────────────
    // These three all depend only on `saleIds`, not on each other — run them
    // together too.
    const saleIds = saleRows.map((s) => s.id);
    const [creditPortionBySale, creditNotesBySale, priorAllocated] = await Promise.all([
      ctx.tx
        .select({ saleFk: salePayments.saleFk, total: sql<string>`sum(${salePayments.amountPaise})` })
        .from(salePayments)
        .where(and(inArray(salePayments.saleFk, saleIds), eq(salePayments.onCredit, true)))
        .groupBy(salePayments.saleFk),
      // A prior refund on a sale may have already reversed part of its credit
      // portion (refund.handler.ts's `credit_note` events) — that share is no
      // longer owed, so it must come off the settleable cap too, or a
      // customer could still be asked to pay for goods they already
      // returned.
      saleIds.length
        ? ctx.tx
            .select({ saleFk: refunds.saleFk, total: sql<string>`sum(${customerLedgerEvents.amountPaise})` })
            .from(customerLedgerEvents)
            .innerJoin(refunds, eq(customerLedgerEvents.sourceFk, refunds.id))
            .where(and(eq(customerLedgerEvents.kind, 'credit_note'), inArray(refunds.saleFk, saleIds)))
            .groupBy(refunds.saleFk)
        : Promise.resolve([]),
      ctx.tx
        .select({ targetFk: paymentAllocations.targetFk, total: sql<string>`sum(${paymentAllocations.appliedPaise})` })
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.targetType, 'sale'), inArray(paymentAllocations.targetFk, saleIds)))
        .groupBy(paymentAllocations.targetFk),
    ]);
    const creditPortionMap = new Map(creditPortionBySale.map((r) => [r.saleFk, Number(r.total)]));
    const creditNoteMap = new Map(creditNotesBySale.map((r) => [r.saleFk, Number(r.total)]));
    const priorAllocatedMap = new Map(priorAllocated.map((r) => [r.targetFk, Number(r.total)]));

    // `runningAllocatedMap` seeds from prior (already-committed) allocations
    // and is updated as this loop goes, so two allocations in the SAME
    // request targeting the same sale_guuid stack against each other instead
    // of each independently checking the same stale pre-request snapshot.
    const runningAllocatedMap = new Map(priorAllocatedMap);
    for (const alloc of data.allocations) {
      const sale = saleByGuuid.get(alloc.sale_guuid)!;
      const creditPortion = (creditPortionMap.get(sale.id) ?? 0) - (creditNoteMap.get(sale.id) ?? 0);
      const already = runningAllocatedMap.get(sale.id) ?? 0;
      if (already + alloc.applied_paise > creditPortion) {
        return { kind: 'rejected', code: ErrorCodes.TARGET_OVER_SETTLED, message: 'This sale is already fully settled.', conflictType: 'BUSINESS_RULE' };
      }
      runningAllocatedMap.set(sale.id, already + alloc.applied_paise);
    }

    const amountPaise = data.allocations.reduce((sum, a) => sum + a.applied_paise, 0);

    const [payment] = await ctx.tx
      .insert(customerPayments)
      .values({
        storeFk: ctx.storeId,
        guuid: data.guuid,
        customerFk: customer.id,
        accountFk: account.id,
        amountPaise,
        createdBy: ctx.userId,
        deviceFk: ctx.deviceId,
      })
      .returning();

    await ctx.tx.insert(paymentAllocations).values(
      data.allocations.map((a) => ({
        storeFk: ctx.storeId,
        paymentFk: payment!.id,
        targetType: 'sale' as const,
        targetFk: saleByGuuid.get(a.sale_guuid)!.id,
        appliedPaise: a.applied_paise,
      })),
    );

    await this.posting.postCustomerPayment(
      ctx.tx,
      { storeFk: ctx.storeId, customerFk: customer.id, accountFk: account.id, amountPaise, customerPaymentId: payment!.id },
      ctx,
    );

    return {
      kind: 'applied',
      entityId: payment!.id,
      entityGuuid: payment!.guuid,
      data: SyncWireMapper.toAppliedRow(payment as Record<string, unknown>),
    };
  }
}