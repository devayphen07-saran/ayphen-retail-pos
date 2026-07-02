import type { SubscriptionView } from './subscription.service.js';
import type { SubscriptionResponse } from './dto/subscription.response.js';

/** Pure domain → snake_case contract mapper (layered-architecture §3.7). */
export const SubscriptionResponseMapper = {
  toResponse(v: SubscriptionView): SubscriptionResponse {
    const s = v.subscription;
    return {
      subscription_version: s.subscriptionVersion,
      status:               s.status,
      access_valid_until:   s.accessValidUntil?.toISOString() ?? null,
      trial_ends_at:        s.trialEndsAt?.toISOString() ?? null,
      current_period_end:   s.currentPeriodEnd?.toISOString() ?? null,
      show_upgrade_banner:  v.showUpgradeBanner,
      banner_severity:      v.bannerSeverity,
      plan: {
        code:         v.planCode,
        name:         v.planName,
        entitlements: v.entitlements,
        features:     v.features,
      },
    };
  },
};
