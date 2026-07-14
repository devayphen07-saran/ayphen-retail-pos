import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ErrorCodes } from '#common/error-codes.js';
import { supplierPayments, paymentAllocations, supplierBills, suppliers, paymentAccounts } from '#db/schema.js';
import { SyncWireMapper } from '../../mappers/response/sync-wire.mapper.js';
import { AccountPostingService } from '../../../ledger/account-posting.service.js';
import type { HandlerOutcome, MutationAction, MutationContext, SyncMutationHandler } from '../mutation.types.js';
import type { SyncEntityType } from '../../sync.constants.js';

const allocationSchema = z.object({
  bill_guuid: z.uuid(),
  applied_paise: z.number().int().positive(),
});

const createSchema = z.object({
  guuid: z.uuid(),
  supplier_guuid: z.uuid(),
  account_guuid: z.uuid(),
  allocations: z.array(allocationSchema).min(1, 'A payment needs at least one bill to settle.'),
});

const rejected = (
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
): HandlerOutcome => ({ kind: 'rejected', code, message, conflictType: 'VALIDATION' });

/**
 * F6 settlement — paying a vendor down against one or more bills, in one
 * composite mutation (header + allocations, one transaction) exactly like
 * customer-payment.handler.ts on the receivables side. BR-5 (Σ allocations ≤
 * payment amount) holds by construction; BR-6 (Σ allocated ≤ that bill's
 * remaining) is the real check below.
 */
@Injectable()
export class SupplierPaymentMutationHandler implements SyncMutationHandler {
  readonly entityType: SyncEntityType = 'supplier_payment';
  readonly permissionEntity = 'SupplierPayment' as const;

  constructor(private readonly posting: AccountPostingService) {}

  async apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    _expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    if (action !== 'create') {
      return rejected(ErrorCodes.VALIDATION_FAILED, 'supplier_payment is append-only');
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

    // ── Resolve supplier / account / target bills — independent lookups, run
    // together rather than as three sequential round-trips ─────────────────
    const billGuuids = [...new Set(data.allocations.map((a) => a.bill_guuid))];
    const [[supplier], [account], billRows] = await Promise.all([
      ctx.tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.guuid, data.supplier_guuid), eq(suppliers.storeFk, ctx.storeId), isNull(suppliers.deletedAt)))
        .limit(1),
      ctx.tx
        .select({ id: paymentAccounts.id, isActive: paymentAccounts.isActive })
        .from(paymentAccounts)
        .where(and(eq(paymentAccounts.guuid, data.account_guuid), eq(paymentAccounts.storeFk, ctx.storeId), isNull(paymentAccounts.deletedAt)))
        .limit(1),
      ctx.tx
        .select({ id: supplierBills.id, guuid: supplierBills.guuid, supplierFk: supplierBills.supplierFk, amountPaise: supplierBills.amountPaise })
        .from(supplierBills)
        .where(and(inArray(supplierBills.guuid, billGuuids), eq(supplierBills.storeFk, ctx.storeId))),
    ]);

    if (!supplier) {
      return { kind: 'rejected', code: ErrorCodes.SUPPLIER_NOT_FOUND, message: 'This supplier could not be found.', conflictType: 'BUSINESS_RULE' };
    }
    if (!account) return rejected(ErrorCodes.VALIDATION_FAILED, `unknown account: ${data.account_guuid}`);
    if (!account.isActive) {
      return { kind: 'rejected', code: ErrorCodes.ACCOUNT_INACTIVE, message: "This account is inactive and can't be used.", conflictType: 'BUSINESS_RULE' };
    }

    // ── Each target bill must belong to THIS supplier ───────────────────────
    const billByGuuid = new Map(billRows.map((b) => [b.guuid, b]));
    for (const g of billGuuids) {
      const bill = billByGuuid.get(g);
      if (!bill || bill.supplierFk !== supplier.id) {
        return { kind: 'rejected', code: ErrorCodes.BILL_NOT_FOUND, message: 'One of these bills could not be found for this supplier.', conflictType: 'BUSINESS_RULE' };
      }
    }

    // ── BR-6: each allocation ≤ that bill's remaining amount ────────────────
    const billIds = billRows.map((b) => b.id);
    const priorAllocated = billIds.length
      ? await ctx.tx
          .select({ targetFk: paymentAllocations.targetFk, total: sql<string>`sum(${paymentAllocations.appliedPaise})` })
          .from(paymentAllocations)
          .where(and(eq(paymentAllocations.targetType, 'bill'), inArray(paymentAllocations.targetFk, billIds)))
          .groupBy(paymentAllocations.targetFk)
      : [];
    const priorAllocatedMap = new Map(priorAllocated.map((r) => [r.targetFk, Number(r.total)]));

    // `runningAllocatedMap` seeds from prior (already-committed) allocations
    // and is updated as this loop goes, so two allocations in the SAME
    // request targeting the same bill_guuid stack against each other instead
    // of each independently checking the same stale pre-request snapshot.
    // Also reused below to derive each bill's final status exactly once,
    // from the fully-accumulated total rather than a per-allocation partial.
    const runningAllocatedMap = new Map(priorAllocatedMap);
    for (const alloc of data.allocations) {
      const bill = billByGuuid.get(alloc.bill_guuid)!;
      const already = runningAllocatedMap.get(bill.id) ?? 0;
      if (already + alloc.applied_paise > bill.amountPaise) {
        return { kind: 'rejected', code: ErrorCodes.TARGET_OVER_SETTLED, message: 'This bill is already fully settled.', conflictType: 'BUSINESS_RULE' };
      }
      runningAllocatedMap.set(bill.id, already + alloc.applied_paise);
    }

    const amountPaise = data.allocations.reduce((sum, a) => sum + a.applied_paise, 0);

    const [payment] = await ctx.tx
      .insert(supplierPayments)
      .values({
        storeFk: ctx.storeId,
        guuid: data.guuid,
        supplierFk: supplier.id,
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
        targetType: 'bill' as const,
        targetFk: billByGuuid.get(a.bill_guuid)!.id,
        appliedPaise: a.applied_paise,
      })),
    );

    await this.posting.postSupplierPayment(
      ctx.tx,
      { storeFk: ctx.storeId, accountFk: account.id, amountPaise, supplierPaymentId: payment!.id },
      ctx,
    );

    // Server-internal status derivation, same modified_at-bump reasoning as
    // sales.status in refund.handler.ts (this table has no generic-update
    // trigger either). Once per bill TOUCHED this request (not once per
    // allocation entry), using runningAllocatedMap's final accumulated total
    // so a bill allocated to twice in one payload lands on the correct status
    // instead of whatever the last-processed entry happened to compute.
    const touchedBillIds = new Set(data.allocations.map((a) => billByGuuid.get(a.bill_guuid)!.id));
    for (const billId of touchedBillIds) {
      const bill = billRows.find((b) => b.id === billId)!;
      const newlyAllocated = runningAllocatedMap.get(billId) ?? 0;
      await ctx.tx
        .update(supplierBills)
        .set({
          status: newlyAllocated >= bill.amountPaise ? 'paid' : 'partially_paid',
          modifiedAt: sql`now()`,
        })
        .where(eq(supplierBills.id, billId));
    }

    return {
      kind: 'applied',
      entityId: payment!.id,
      entityGuuid: payment!.guuid,
      data: SyncWireMapper.toAppliedRow(payment as Record<string, unknown>),
    };
  }
}