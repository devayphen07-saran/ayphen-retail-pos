import type { LocalCustomerLedgerEvent } from '@core/sync/repositories/customer-ledger-event.repository';

/** Σ credit_sale − Σ payment − Σ credit_note (docs/prd/accounts-and-ledger.md F5).
 *  `credit_note` is posted when a credit sale is refunded (refund.handler.ts)
 *  — it reduces what's owed without implying a real payment was collected.
 *  `adjustment` events have no creation path yet, so there's nothing to fold
 *  in for them. */
export function computeOutstandingPaise(events: LocalCustomerLedgerEvent[]): number {
  return events.reduce((sum, e) => {
    if (e.kind === 'credit_sale') return sum + e.amountPaise;
    if (e.kind === 'payment' || e.kind === 'credit_note') return sum - e.amountPaise;
    return sum;
  }, 0);
}

/** `customers.credit_limit` is a numeric(12,2) RUPEE string; null/0 = unlimited (BR-CUS-020). */
export function creditLimitPaise(raw: string | null | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
