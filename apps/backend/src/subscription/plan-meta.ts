/**
 * Plan display metadata (subscription §22B plans screen) — static config, same
 * pattern as `PLAN_PRICING`: keyed by `plans.name`, extend here when a new plan
 * lands. Purely presentational; never affects entitlements/features/billing.
 */
export interface PlanMeta {
  displayOrder:      number;
  isRecommended:     boolean;
  shortDescription:  string;
  featureHighlights: string[];
}

const DEFAULT_META: PlanMeta = {
  displayOrder:      99,
  isRecommended:     false,
  shortDescription:  '',
  featureHighlights: [],
};

export const PLAN_META: Record<string, PlanMeta> = {
  free: {
    displayOrder:      0,
    isRecommended:     false,
    shortDescription:  'For trying the platform',
    featureHighlights: ['1 store', '1 location', '100 products', 'Offline POS'],
  },
  starter: {
    displayOrder:      1,
    isRecommended:     true,
    shortDescription:  'Perfect for growing stores',
    featureHighlights: ['3 locations', '5 devices', '10 staff', '2,000 products', 'Barcode scanning'],
  },
  growth: {
    displayOrder:      2,
    isRecommended:     false,
    shortDescription:  'For multi-store businesses',
    featureHighlights: ['Unlimited stores', 'Unlimited locations', '20 devices', 'Unlimited staff', 'Advanced reports'],
  },
};

export function resolvePlanMeta(planName: string): PlanMeta {
  return PLAN_META[planName] ?? DEFAULT_META;
}
