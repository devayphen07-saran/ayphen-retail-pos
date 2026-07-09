import { Injectable } from '@nestjs/common';
import { type DbExecutor } from '#db/db.module.js';
import { SubscriptionRepository } from './subscription.repository.js';

/** Known entitlement keys (plan_entitlements.key). Integer value; null = unlimited. */
export type EntitlementKey =
  | 'max_stores'
  | 'max_devices_per_store'
  | 'max_products';

/**
 * Reads plan limits/features for an account (subscription §3, §26.6). The lookup
 * chain is account → account_subscription → plan → plan_entitlements/plan_features.
 * Enforcement uses strict less-than: currentCount < limit (null = unlimited).
 * Data access is delegated to SubscriptionRepository — the service owns only the
 * "row absent → blocked" business policy.
 */
@Injectable()
export class EntitlementService {
  constructor(private readonly repo: SubscriptionRepository) {}

  /**
   * Entitlement integer for an account. `null` = unlimited (an explicit NULL
   * `value` in `plan_entitlements`). `0` = blocked — a **missing** row means
   * the plan doesn't grant this entitlement at all, never "unlimited"
   * (subscription.md §3.1 rule 4). Distinguishing "row absent" from "row
   * present with value=NULL" is the whole point — collapsing both to `null`
   * would silently grant unlimited access on a seed gap.
   */
  async get(
    accountId: string,
    key: EntitlementKey,
    tx?: DbExecutor,
  ): Promise<number | null> {
    const row = await this.repo.findEntitlementValue(accountId, key, tx);
    if (!row) return 0;
    return row.value;
  }

  /** null limit = unlimited; otherwise strict less-than (subscription §3A). */
  canCreate(limit: number | null, current: number): boolean {
    return limit === null || current < limit;
  }
}
