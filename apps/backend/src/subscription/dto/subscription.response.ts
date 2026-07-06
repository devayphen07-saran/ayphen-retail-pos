/** GET /me/subscription payload (subscription §19). snake_case wire contract. */
export interface SubscriptionResponse {
  subscription_version: number;
  status:               string;
  access_valid_until:   string | null;   // ISO
  trial_ends_at:        string | null;   // ISO
  current_period_end:   string | null;   // ISO
  show_upgrade_banner:  boolean;
  banner_severity:      'none' | 'info' | 'warning' | 'critical';
  // 'pending' → a downgrade left something over limit; every write is blocked
  // account-wide until the owner resolves it (GET/POST /me/subscription/reconciliation).
  reconciliation_status: 'none' | 'pending' | 'applied';
  plan: {
    code:         string;
    name:         string;
    // Billing cadence (e.g. 'starter_annual') — which priced plans catalog
    // entry was purchased. Null pre-checkout (trialing, never billed).
    billing_code: string | null;
    entitlements: Record<string, number | null>;
    features:     Record<string, boolean>;
  };
}

/** POST /me/subscription/cancel and /reactivate — thin ack, not the full view.
 *  Client refetches GET /me/subscription off the version-bump signal (§16)
 *  rather than this endpoint duplicating the view-join. */
export interface SubscriptionActionResponse {
  status:               string;
  cancel_at_period_end: boolean;
  subscription_version: number;
}

/** GET /me/subscription/sv — the bare version counter poll target (§16). */
export interface SubscriptionVersionResponse {
  subscription_version: number;
}

/** POST /me/subscription/reconciliation and /active-store — thin apply ack. */
export interface ReconciliationApplyResponse {
  applied: true;
}

/** GET /me/subscription/reconciliation — the resolve screen's data (this
 *  session's downgrade-reconciliation design). Only present/meaningful while
 *  `reconciliation_status='pending'`; Head Office is never included in
 *  `locations` as a lockable candidate — it's immune, always kept. */
export interface ReconciliationResponse {
  limits: {
    max_stores:    number | null;
    max_locations: number | null;
    max_devices:   number | null;
  };
  stores: Array<{
    id:             string;
    name:           string;
    location_count: number;
    device_count:   number;
  }>;
  locations: Array<{
    id:         string;
    store_id:   string;
    name:       string;
    is_primary: boolean;
  }>;
  devices: Array<{
    id:                string;
    store_id:          string;
    label:             string | null;
    model:             string | null;
    platform:          string;
    last_accessed_at:  string; // ISO
    is_current_device: boolean;
  }>;
}

/** One billing-cycle option for a plan in GET /me/subscription/plans.
 *  `plan_code` is what `POST /me/account/subscription/checkout` accepts.
 *  `savings_percentage` is relative to this plan's monthly cycle (0 on the
 *  monthly option itself; computed off the live prices, never hand-entered). */
export interface PlanPricingOption {
  plan_code:          string;
  billing_cycle:      'monthly' | 'annual';
  amount:             number;   // paise
  currency:           string;
  savings_percentage: number;
}

/** One row of GET /me/subscription/plans — one entry per plan, not per billing
 *  cycle. `pricing` holds every purchasable cycle for this plan (e.g. monthly
 *  + annual for `starter`); it's empty for the `free` plan, which has no
 *  purchasable code (it's the trial default, never checked out into).
 *  `display_order`/`is_recommended`/`short_description`/`feature_highlights`
 *  are presentational only (subscription §22B plans screen). */
export interface PlanCatalogEntry {
  plan_name:          string;
  display_name:       string;
  display_order:      number;
  is_recommended:     boolean;
  short_description:  string;
  feature_highlights: string[];
  pricing:            PlanPricingOption[];
  entitlements:       Record<string, number | null>;
  features:           Record<string, boolean>;
}
