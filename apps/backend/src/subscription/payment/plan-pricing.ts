/**
 * Plan → price map (subscription §3C), in paise. Provider-neutral: the payment
 * adapter only receives amount+currency. Keyed by `plan_code` (plan + billing
 * frequency); `planName` must match a real `plans.name` row.
 *
 * NOTE — doc/seed drift: subscription.md §3 lists free/basic/premium/professional/
 * enterprise, but the actual seed (db/scripts/seed.ts) has only `free`, `starter`,
 * `growth`. This map is keyed to the SEEDED plans so `activateFromPayment` can
 * resolve a live `plans.id`. Extend here (and the seed) when new plans land.
 * Prices below follow §3C for the closest tier. Move to a `plan_prices` table
 * later without touching callers.
 */
export interface PlanPrice {
  planName: string;   // must equal a plans.name value (the plan being switched to)
  amount:   number;   // paise
  currency: string;
}

export const PLAN_PRICING: Record<string, PlanPrice> = {
  starter_monthly: { planName: 'starter', amount:  49900, currency: 'INR' },
  starter_annual:  { planName: 'starter', amount: 499900, currency: 'INR' },
  growth_monthly:  { planName: 'growth',  amount:  99900, currency: 'INR' },
  growth_annual:   { planName: 'growth',  amount: 999900, currency: 'INR' },
};

export function resolvePlanPrice(planCode: string): PlanPrice | null {
  return PLAN_PRICING[planCode] ?? null;
}
