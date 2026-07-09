import type {
  SubscriptionView,
  PlanCatalogEntryResult,
  SubscriptionActionResult,
} from './subscription.service.js';
import type { CheckoutResult, VerifyResult } from './billing.service.js';
import type { ReconciliationContext } from './reconciliation.service.js';
import type {
  SubscriptionResponse,
  SubscriptionActionResponse,
  SubscriptionVersionResponse,
  ReconciliationResponse,
  ReconciliationApplyResponse,
  PlanCatalogEntry,
} from './dto/subscription.response.js';
import type { CheckoutResponse, VerifyPaymentResponse } from './dto/checkout.response.js';

/** Pure domain → snake_case contract mapper (layered-architecture §3.7). */
export const SubscriptionResponseMapper = {
  toResponse(v: SubscriptionView): SubscriptionResponse {
    const s = v.subscription;
    return {
      id:                    s.id,
      subscription_version: s.subscriptionVersion,
      status:               s.status,
      trial_ends_at:        s.trialEndsAt?.toISOString() ?? null,
      current_period_end:   s.currentPeriodEnd?.toISOString() ?? null,
      cancel_at_period_end: s.cancelAtPeriodEnd,
      show_upgrade_banner:  v.showUpgradeBanner,
      banner_severity:      v.bannerSeverity,
      reconciliation_status: s.reconciliationStatus,
      plan: {
        code:          v.planCode,
        name:          v.planName,
        billing_cycle: v.billingCycle,
        price:         v.price,
        entitlements:  v.entitlements,
      },
    };
  },

  toPlanCatalog(entries: PlanCatalogEntryResult[]): PlanCatalogEntry[] {
    return entries.map((e) => this.toPlanCatalogEntry(e));
  },

  toPlanCatalogEntry(e: PlanCatalogEntryResult): PlanCatalogEntry {
    return {
      plan_name:          e.planName,
      display_name:       e.displayName,
      display_order:      e.displayOrder,
      is_recommended:     e.isRecommended,
      short_description:  e.shortDescription,
      feature_highlights: e.featureHighlights,
      pricing: e.pricing.map((p) => ({
        plan_code:          p.planCode,
        billing_cycle:      p.billingCycle,
        amount:             p.amount,
        currency:           p.currency,
        savings_percentage: p.savingsPercentage,
      })),
      entitlements: e.entitlements,
      features:     e.features,
      feature_labels: e.featureLabels,
    };
  },

  toActionResponse(sub: SubscriptionActionResult): SubscriptionActionResponse {
    return {
      status:               sub.status,
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      subscription_version: sub.subscriptionVersion,
    };
  },

  toVersionResponse(version: number): SubscriptionVersionResponse {
    return { subscription_version: version };
  },

  toCheckoutResponse(r: CheckoutResult): CheckoutResponse {
    // clientPayload is Record<string, unknown> at the provider-port boundary,
    // but both bound providers (Razorpay, Fake) always populate exactly these
    // fields — list them explicitly rather than spreading the open bag (§3.7).
    const p = r.clientPayload as {
      provider: string;
      key: string;
      order_id: string;
      amount: number;
      currency: string;
    };
    return {
      provider: p.provider,
      key:      p.key,
      order_id: p.order_id,
      amount:   p.amount,
      currency: p.currency,
      prefill:  r.prefill,
    };
  },

  toVerifyResponse(r: VerifyResult): VerifyPaymentResponse {
    return { activated: r.activated };
  },

  toAppliedResponse(): ReconciliationApplyResponse {
    return { applied: true };
  },

  toReconciliationResponse(ctx: ReconciliationContext): ReconciliationResponse {
    return {
      limits: {
        max_stores:    ctx.limits.maxStores,
        max_devices:   ctx.limits.maxDevices,
      },
      stores: ctx.stores.map((s) => ({
        id: s.id,
        name: s.name,
        device_count: s.deviceCount,
      })),
      devices: ctx.devices.map((d) => ({
        id: d.id,
        store_id: d.storeId,
        label: d.label,
        model: d.model,
        platform: d.platform,
        last_accessed_at: d.lastAccessedAt.toISOString(),
        is_current_device: d.isCurrentDevice,
      })),
    };
  },
};
