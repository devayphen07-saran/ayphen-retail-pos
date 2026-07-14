import type { LocalSupplierBill } from '@core/sync/repositories/supplier-bill.repository';
import type { LocalPaymentAllocation } from '@core/sync/repositories/payment-allocation.repository';

export interface OpenBill {
  billId: string;
  billGuuid: string;
  billNo: string | null;
  amountPaise: number;
  remainingPaise: number;
  billDate: string | null;
}

/** A supplier's still-owed bills, oldest first — mirrors
 *  computeOpenCreditSales on the receivables side, but simpler: a bill's
 *  amount is known directly (no credit-portion derivation needed). */
export function computeOpenBills(
  bills: LocalSupplierBill[],
  allocations: LocalPaymentAllocation[],
): OpenBill[] {
  const allocatedByBill = new Map<string, number>();
  for (const a of allocations) {
    if (a.targetType !== 'bill') continue;
    allocatedByBill.set(a.targetFk, (allocatedByBill.get(a.targetFk) ?? 0) + a.appliedPaise);
  }

  return bills
    .map((b) => ({
      billId: b.id,
      billGuuid: b.guuid,
      billNo: b.billNo,
      amountPaise: b.amountPaise,
      remainingPaise: b.amountPaise - (allocatedByBill.get(b.id) ?? 0),
      billDate: b.billDate,
    }))
    .filter((b) => b.remainingPaise > 0)
    .sort((a, b) => (a.billDate ?? '').localeCompare(b.billDate ?? ''));
}