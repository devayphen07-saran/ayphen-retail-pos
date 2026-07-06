/**
 * Wire types for the subscription domain. Field names mirror the backend DTOs
 * (snake_case) exactly — see `apps/backend/src/subscription/dto/*.ts`.
 */

export type BannerSeverity = 'none' | 'info' | 'warning' | 'critical';

/** GET /me/subscription. */
export interface SubscriptionResponse {
  subscription_version: number;
  status:               string; // 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'expired'
  access_valid_until:   string | null; // ISO
  trial_ends_at:        string | null; // ISO
  current_period_end:   string | null; // ISO
  show_upgrade_banner:  boolean;
  banner_severity:      BannerSeverity;
  // 'pending' → a downgrade left something over limit; every write is blocked
  // account-wide until the owner resolves it (GET/POST /me/subscription/reconciliation).
  reconciliation_status: 'none' | 'pending' | 'applied';
  plan: {
    code:         string;
    name:         string;
    billing_code: string | null; // e.g. 'starter_annual' — matches PlanPricingOption.plan_code
    entitlements: Record<string, number | null>;
    features:     Record<string, boolean>;
  };
}

/** GET /me/subscription/sv. */
export interface SubscriptionVersionResponse {
  subscription_version: number;
}

/** One billing-cycle option for a plan in GET /me/subscription/plans.
 *  `plan_code` is what `checkout` accepts. `savings_percentage` is relative
 *  to this plan's monthly cycle (0 on the monthly option itself). */
export interface PlanPricingOption {
  plan_code:          string;
  billing_cycle:      'monthly' | 'annual';
  amount:             number; // paise
  currency:           string;
  savings_percentage: number;
}

/** One row of GET /me/subscription/plans — one entry per plan, not per billing
 *  cycle. `pricing` is empty on the informational `free` entry (never checked
 *  out into). `display_order`/`is_recommended`/`short_description`/
 *  `feature_highlights` are presentational only. */
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

/** POST /me/account/subscription/checkout body. */
export interface CheckoutSubscriptionRequest {
  plan_code: string;
}

/** POST /me/account/subscription/checkout response. Provider-specific fields
 *  (Razorpay key/order id/amount/currency) are intentionally open-ended —
 *  read them off this object by name, don't destructure-assume every key. */
export interface CheckoutSubscriptionResponse {
  prefill: { name: string; contact: string };
  [key: string]: unknown;
}

/** POST /me/account/subscription/verify body. */
export interface VerifySubscriptionPaymentRequest {
  order_id:   string;
  payment_id: string;
  signature:  string;
}

/** POST /me/account/subscription/verify response. */
export interface VerifySubscriptionPaymentResponse {
  activated: boolean;
}

/** POST /me/subscription/cancel and /reactivate response — thin ack, not the
 *  full view. Refetch GET /me/subscription off the version-bump instead. */
export interface SubscriptionActionResponse {
  status:               string;
  cancel_at_period_end: boolean;
  subscription_version: number;
}

/** GET /me/subscription/reconciliation — the downgrade resolve screen's data.
 *  Head Office never appears in `locations` as a lockable candidate — it's
 *  immune, always kept implicitly. */
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

/** POST /me/subscription/reconciliation body — the owner's downgrade resolution. */
export interface ReconciliationRequest {
  keep_store_ids:    string[];
  keep_location_ids: string[];
  keep_device_ids:   string[];
}

/** POST /me/subscription/active-store body — post-downgrade swap. */
export interface ActiveStoreSwapRequest {
  activate_store_id:   string;
  deactivate_store_id: string;
  keep_location_ids:   string[];
  keep_device_ids:     string[];
}
