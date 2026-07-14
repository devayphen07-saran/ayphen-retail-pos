import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ErrorCodes } from '#common/error-codes.js';
import { sales, saleLines, salePayments, refunds, refundLines, paymentAccounts, customerLedgerEvents } from '#db/schema.js';
import { SyncWireMapper } from '../../mappers/response/sync-wire.mapper.js';
import { AccountPostingService } from '../../../ledger/account-posting.service.js';
import type { HandlerOutcome, MutationAction, MutationContext, SyncMutationHandler } from '../mutation.types.js';
import type { SyncEntityType } from '../../sync.constants.js';

const refundLineSchema = z.object({
  sale_line_guuid: z.uuid(),
  qty: z.number().positive(),
});

const createSchema = z.object({
  guuid: z.uuid(),
  sale_guuid: z.uuid(),
  account_guuid: z.uuid(),
  reason: z.string().trim().max(280).optional(),
  lines: z.array(refundLineSchema).min(1, 'A refund needs at least one item.'),
});

const rejected = (
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
): HandlerOutcome => ({ kind: 'rejected', code, message, conflictType: 'VALIDATION' });

/**
 * F3 (docs/prd/accounts-and-ledger.md) — a refund against a completed or
 * partially-refunded sale. Composite create (header + lines in one
 * transaction), append-only: a refund is never edited or deleted; a mistaken
 * refund would need its own compensating flow (not built yet).
 *
 * BR-4/V-9: capped server-side at both the sale level (Σ refunds ≤ sale
 * total) and the line level (Σ refunded qty ≤ original line qty) — the
 * client's numbers are advisory only.
 */
@Injectable()
export class RefundMutationHandler implements SyncMutationHandler {
  readonly entityType: SyncEntityType = 'refund';
  readonly permissionEntity = 'Refund' as const;

  constructor(private readonly posting: AccountPostingService) {}

  async apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    _expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    if (action !== 'create') {
      return rejected(ErrorCodes.VALIDATION_FAILED, 'refund is append-only');
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

    // ── Resolve the original sale (V-10: must exist, this store) ───────────
    const [sale] = await ctx.tx
      .select({ id: sales.id, totalPaise: sales.totalPaise, customerFk: sales.customerFk })
      .from(sales)
      .where(and(eq(sales.guuid, data.sale_guuid), eq(sales.storeFk, ctx.storeId)))
      .limit(1);
    if (!sale) {
      return { kind: 'rejected', code: ErrorCodes.SALE_NOT_FOUND, message: 'This sale could not be found.', conflictType: 'BUSINESS_RULE' };
    }

    // ── Resolve the refund destination account (V-2 / EF-9) ────────────────
    const [account] = await ctx.tx
      .select({ id: paymentAccounts.id, isActive: paymentAccounts.isActive })
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.guuid, data.account_guuid), eq(paymentAccounts.storeFk, ctx.storeId), isNull(paymentAccounts.deletedAt)))
      .limit(1);
    if (!account) return rejected(ErrorCodes.VALIDATION_FAILED, `unknown account: ${data.account_guuid}`);
    if (!account.isActive) {
      return { kind: 'rejected', code: ErrorCodes.ACCOUNT_INACTIVE, message: "This account is inactive and can't be used.", conflictType: 'BUSINESS_RULE' };
    }

    // ── Resolve the sale_line targets — must belong to THIS sale ────────────
    const saleLineGuuids = [...new Set(data.lines.map((l) => l.sale_line_guuid))];
    const originalLines = await ctx.tx
      .select({
        id: saleLines.id,
        guuid: saleLines.guuid,
        saleFk: saleLines.saleFk,
        qty: saleLines.qty,
        lineTotalPaise: saleLines.lineTotalPaise,
      })
      .from(saleLines)
      .where(inArray(saleLines.guuid, saleLineGuuids));
    const originalByGuuid = new Map(originalLines.map((l) => [l.guuid, l]));
    for (const g of saleLineGuuids) {
      const line = originalByGuuid.get(g);
      if (!line || line.saleFk !== sale.id) {
        return { kind: 'rejected', code: ErrorCodes.SALE_LINE_NOT_FOUND, message: 'One of these items is not on this sale.', conflictType: 'BUSINESS_RULE' };
      }
    }

    // ── Prior refunds against these lines / this sale (for the caps) ───────
    const originalLineIds = originalLines.map((l) => l.id);
    const priorLineRefunds = await ctx.tx
      .select({
        saleLineFk: refundLines.saleLineFk,
        qty: sql<string>`sum(${refundLines.qty})`,
        amount: sql<string>`sum(${refundLines.amountPaise})`,
      })
      .from(refundLines)
      .where(inArray(refundLines.saleLineFk, originalLineIds))
      .groupBy(refundLines.saleLineFk);
    const priorQtyByLine = new Map(priorLineRefunds.map((r) => [r.saleLineFk, Number(r.qty)]));
    const priorAmountByLine = new Map(priorLineRefunds.map((r) => [r.saleLineFk, Number(r.amount)]));

    const [priorSaleRefund] = await ctx.tx
      .select({ total: sql<string>`coalesce(sum(${refunds.amountPaise}), 0)` })
      .from(refunds)
      .where(eq(refunds.saleFk, sale.id));
    const priorRefundedPaise = Number(priorSaleRefund?.total ?? 0);

    // ── How much of the ORIGINAL sale was on credit (for the credit/cash
    // split below) and how much of that has already been reversed by a
    // prior refund on this sale ─────────────────────────────────────────────
    const [saleCreditRow] = await ctx.tx
      .select({ total: sql<string>`coalesce(sum(${salePayments.amountPaise}), 0)` })
      .from(salePayments)
      .where(and(eq(salePayments.saleFk, sale.id), eq(salePayments.onCredit, true)));
    const saleCreditPaise = Number(saleCreditRow?.total ?? 0);

    const [priorCreditNoteRow] = await ctx.tx
      .select({ total: sql<string>`coalesce(sum(${customerLedgerEvents.amountPaise}), 0)` })
      .from(customerLedgerEvents)
      .innerJoin(refunds, eq(customerLedgerEvents.sourceFk, refunds.id))
      .where(and(eq(customerLedgerEvents.kind, 'credit_note'), eq(refunds.saleFk, sale.id)));
    const priorCreditNotePaise = Number(priorCreditNoteRow?.total ?? 0);

    // ── Server-compute each refund line's amount (line-total-proportional) ──
    // `runningQtyByLine`/`runningAmountByLine` seed from prior (already-
    // committed) refunds and are updated as this loop goes, so two lines in
    // the SAME request targeting the same sale_line_guuid stack against each
    // other instead of each independently checking the same stale
    // pre-request snapshot (which would let both pass even though their sum
    // exceeds what was sold).
    //
    // The amount is the CUMULATIVE proportional target for the new running
    // qty, minus what's already been refunded on this line — not a fresh
    // `round(qty/originalQty * lineTotal)` each time. That independent-
    // rounding approach drifts: three separate 1-of-3 unit refunds on a
    // ₹1.00/3-unit line each round(1/3 × 100) = 33, leaving 1 paisa
    // permanently unrefunded once the line is fully returned. Recomputing
    // the cumulative target every time — and snapping to the exact
    // `lineTotalPaise` with no rounding once the full original qty is
    // refunded — means the last partial refund on a line always absorbs
    // whatever the earlier roundings shorted it.
    const runningQtyByLine = new Map(priorQtyByLine);
    const runningAmountByLine = new Map(priorAmountByLine);
    const values: { saleLineFk: string; qty: string; amountPaise: number }[] = [];
    for (const l of data.lines) {
      const original = originalByGuuid.get(l.sale_line_guuid)!;
      const originalQty = Number(original.qty);
      const priorQty = runningQtyByLine.get(original.id) ?? 0;
      if (priorQty + l.qty > originalQty + 1e-9) {
        return {
          kind: 'rejected',
          code: ErrorCodes.REFUND_EXCEEDS_SALE,
          message: 'Refund quantity exceeds what was sold on this item.',
          conflictType: 'BUSINESS_RULE',
        };
      }
      const newQty = priorQty + l.qty;
      const priorAmount = runningAmountByLine.get(original.id) ?? 0;
      const cumulativeTarget =
        newQty + 1e-9 >= originalQty ? original.lineTotalPaise : Math.round((newQty / originalQty) * original.lineTotalPaise);
      const amountPaise = cumulativeTarget - priorAmount;
      runningQtyByLine.set(original.id, newQty);
      runningAmountByLine.set(original.id, cumulativeTarget);
      values.push({ saleLineFk: original.id, qty: String(l.qty), amountPaise });
    }
    const refundAmountPaise = values.reduce((sum, v) => sum + v.amountPaise, 0);

    // ── BR-4 / V-9: sale-level cap ───────────────────────────────────────────
    const newlyRefundedTotal = priorRefundedPaise + refundAmountPaise;
    if (newlyRefundedTotal > sale.totalPaise) {
      return {
        kind: 'rejected',
        code: ErrorCodes.REFUND_EXCEEDS_SALE,
        message: "Refund can't exceed the remaining refundable amount on this sale.",
        conflictType: 'BUSINESS_RULE',
      };
    }

    // ── Split this refund between the sale's credit and cash portions ──────
    // Same cumulative-target-minus-already-given pattern as the per-line
    // amounts above, but at the sale level: the credit share reduces what
    // the customer owes (postRefundCreditNote) instead of debiting a real
    // account, so a refund on a credit sale actually reverses the ledger
    // (previously: the full amount was always debited from `account`,
    // leaving the customer's outstanding balance untouched even though the
    // goods came back).
    let creditPortionOfRefund = 0;
    if (saleCreditPaise > 0) {
      const creditCumulativeTarget =
        newlyRefundedTotal + 1e-9 >= sale.totalPaise ? saleCreditPaise : Math.round((newlyRefundedTotal / sale.totalPaise) * saleCreditPaise);
      creditPortionOfRefund = creditCumulativeTarget - priorCreditNotePaise;
    }
    const cashPortionOfRefund = refundAmountPaise - creditPortionOfRefund;

    const [refund] = await ctx.tx
      .insert(refunds)
      .values({
        storeFk: ctx.storeId,
        guuid: data.guuid,
        saleFk: sale.id,
        accountFk: account.id,
        amountPaise: refundAmountPaise,
        reason: data.reason ?? null,
        createdBy: ctx.userId,
        deviceFk: ctx.deviceId,
      })
      .returning();

    await ctx.tx.insert(refundLines).values(
      values.map((v) => ({ storeFk: ctx.storeId, refundFk: refund!.id, saleLineFk: v.saleLineFk, qty: v.qty, amountPaise: v.amountPaise })),
    );

    // `refunds.amount_paise` stays the FULL refund (matches Σ refund_lines,
    // what the mobile UI shows) — only the actual account posting is capped
    // to the cash portion. account_guuid stays a required field even on a
    // fully-credit-sale refund (cashPortionOfRefund === 0, so this call is
    // simply skipped): the mobile screen always asks for a destination
    // account today, so this is a harmless no-op rather than a validation
    // hole. A future pass could make the field conditional in the UI.
    if (cashPortionOfRefund > 0) {
      await this.posting.postRefund(
        ctx.tx,
        { storeFk: ctx.storeId, accountFk: account.id, amountPaise: cashPortionOfRefund, refundId: refund!.id },
        ctx,
      );
    }
    if (creditPortionOfRefund > 0) {
      // saleCreditPaise > 0 implies sale.customerFk is set — BR-2/V-5 require
      // a customer for any credit portion of a sale.
      await this.posting.postRefundCreditNote(
        ctx.tx,
        { storeFk: ctx.storeId, customerFk: sale.customerFk!, amountPaise: creditPortionOfRefund, refundId: refund!.id },
        ctx,
      );
    }

    // Server-internal status derivation — never exposed via a generic sync
    // mutation; only this handler ever updates it. `sales` has no
    // sync_touch_row trigger (it's never touched by a generic update path),
    // so modified_at must be bumped explicitly here — otherwise a device that
    // already pulled this sale as 'completed' would never see the status
    // change via delta (the keyset walks modified_at).
    await ctx.tx
      .update(sales)
      .set({
        status: newlyRefundedTotal >= sale.totalPaise ? 'refunded' : 'partially_refunded',
        modifiedAt: sql`now()`,
      })
      .where(eq(sales.id, sale.id));

    return {
      kind: 'applied',
      entityId: refund!.id,
      entityGuuid: refund!.guuid,
      data: SyncWireMapper.toAppliedRow(refund as Record<string, unknown>),
    };
  }
}