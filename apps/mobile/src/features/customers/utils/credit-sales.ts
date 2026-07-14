import type { LocalSale } from '@core/sync/repositories/sale.repository';
import type { LocalSalePayment } from '@core/sync/repositories/sale-payment.repository';
import type { LocalPaymentAllocation } from '@core/sync/repositories/payment-allocation.repository';

export interface OpenCreditSale {
  saleId: string;
  saleGuuid: string;
  invoiceNo: string | null;
  soldAt: string | null;
  remainingPaise: number;
}

/**
 * A customer's still-owed credit sales, oldest first — the source list for
 * "Collect payment"'s FIFO auto-allocation. Computed entirely from already-
 * synced local rows (no query of its own): each sale's credit portion (Σ its
 * on_credit sale_payments) minus what's already been allocated against it.
 */
export function computeOpenCreditSales(
  customerSales: LocalSale[],
  allSalePayments: LocalSalePayment[],
  allAllocations: LocalPaymentAllocation[],
): OpenCreditSale[] {
  const creditPortionBySale = new Map<string, number>();
  for (const p of allSalePayments) {
    if (!p.onCredit) continue;
    creditPortionBySale.set(p.saleFk, (creditPortionBySale.get(p.saleFk) ?? 0) + p.amountPaise);
  }

  const allocatedBySale = new Map<string, number>();
  for (const a of allAllocations) {
    if (a.targetType !== 'sale') continue;
    allocatedBySale.set(a.targetFk, (allocatedBySale.get(a.targetFk) ?? 0) + a.appliedPaise);
  }

  return customerSales
    .map((sale) => {
      const creditPortion = creditPortionBySale.get(sale.id) ?? 0;
      const allocated = allocatedBySale.get(sale.id) ?? 0;
      return {
        saleId: sale.id,
        saleGuuid: sale.guuid,
        invoiceNo: sale.invoiceNo,
        soldAt: sale.soldAt,
        remainingPaise: creditPortion - allocated,
      };
    })
    .filter((s) => s.remainingPaise > 0)
    .sort((a, b) => (a.soldAt ?? '').localeCompare(b.soldAt ?? ''));
}

/** FIFO allocation of `amountPaise` across open credit sales, oldest first. */
export function allocateFifo(
  amountPaise: number,
  openSales: OpenCreditSale[],
): { saleGuuid: string; appliedPaise: number }[] {
  const allocations: { saleGuuid: string; appliedPaise: number }[] = [];
  let remaining = amountPaise;
  for (const sale of openSales) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, sale.remainingPaise);
    if (applied > 0) {
      allocations.push({ saleGuuid: sale.saleGuuid, appliedPaise: applied });
      remaining -= applied;
    }
  }
  return allocations;
}