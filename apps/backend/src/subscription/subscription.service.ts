import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import type { Redis } from 'ioredis';
import { UnitOfWork, type DbExecutor } from '#db/db.module.js';
import { REDIS } from '#common/redis/redis.provider.js';
import {
  SubscriptionRepository,
  type AccountSubscription,
  type SubscriptionWithPlan,
} from './subscription.repository.js';
import { DowngradeDetectionService } from './downgrade-detection.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { subVersionPointerKey } from './subscription-cache.js';
import { PLAN_PRICING, resolvePlanPrice } from './payment/plan-pricing.js';
import { resolvePlanMeta } from './plan-meta.js';

/** One paid period (subscription §9/§10: 30 days for monthly, 365 for annual). */
export const BILLING_PERIOD_DAYS = 30;
export const ANNUAL_BILLING_PERIOD_DAYS = 365;

export type BannerSeverity = 'none' | 'info' | 'warning' | 'critical';

export interface SubscriptionView extends SubscriptionWithPlan {
  bannerSeverity:    BannerSeverity;
  showUpgradeBanner: boolean;
}

/** camelCase domain result for cancel/reactivate — exactly what the response mapper needs. */
export interface SubscriptionActionResult {
  status:             AccountSubscription['status'];
  cancelAtPeriodEnd:  boolean;
  subscriptionVersion: number;
}

/** camelCase domain shape of one billing-cycle option in the plan catalog. */
export interface PlanPricingOptionResult {
  planCode:          string;
  billingCycle:      'monthly' | 'annual';
  amount:            number;
  currency:          string;
  savingsPercentage: number;
}

/** camelCase domain shape of one plan-catalog entry (mapper shapes the wire). */
export interface PlanCatalogEntryResult {
  planName:          string;
  displayName:       string;
  displayOrder:      number;
  isRecommended:     boolean;
  shortDescription:  string;
  featureHighlights: string[];
  pricing:           PlanPricingOptionResult[];
  entitlements:      Record<string, number | null>;
  features:          Record<string, boolean>;
}


/**
 * The single funnel for subscription state changes (subscription §19). Every
 * transition, in one Unit of Work:
 *   1. UPDATE … SET …, subscription_version = subscription_version + 1
 *   2. INSERT a subscription_audit_outbox row (durable audit, §29.14)
 * then, post-commit, DELETEs the guard's Redis cache key so the next request
 * reads fresh state and emits the new version header.
 *
 * Centralizing writes here guarantees version-bump + cache-invalidation never
 * drift apart across the many endpoints/cron that mutate a subscription.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly uow: UnitOfWork,
    private readonly downgradeDetection: DowngradeDetectionService,
    private readonly reconciliation: ReconciliationService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ─── Read model ─────────────────────────────────────────────────────────────

  async getViewForUser(userId: string): Promise<SubscriptionView | null> {
    const accountId = await this.repo.findMemberAccountId(userId);
    if (!accountId) return null;
    const withPlan = await this.repo.findWithPlan(accountId);
    if (!withPlan) return null;
    const { bannerSeverity, showUpgradeBanner } = this.computeBanner(withPlan.subscription);
    return { ...withPlan, bannerSeverity, showUpgradeBanner };
  }

  /**
   * Cheap poll target for `GET /me/subscription/sv` (subscription §16) — just the
   * version counter, so a client can cheaply detect "should I re-fetch the full
   * payload" without paying for the plan/entitlement joins on every poll.
   */
  async getVersionForUser(userId: string): Promise<number | null> {
    const accountId = await this.repo.findMemberAccountId(userId);
    if (!accountId) return null;
    return this.repo.findVersionByAccountId(accountId);
  }

  /**
   * GET /me/subscription/plans catalog. Static config (plan entitlements/
   * features + `PLAN_PRICING`) — cacheable client-side for ~24h (subscription
   * §22B), not account-scoped. One row per active plan; each row's `pricing`
   * lists every purchasable billing cycle for that plan (`free` has none).
   */
  async getPlanCatalog(): Promise<PlanCatalogEntryResult[]> {
    const plans = await this.repo.findActivePlansWithEntitlementsAndFeatures();

    const catalog = plans.map((plan): PlanCatalogEntryResult => {
      const options = Object.entries(PLAN_PRICING).filter(([, price]) => price.planName === plan.name);
      const monthly = options.find(([, price]) => price.billingCycle === 'monthly')?.[1];

      const pricing: PlanPricingOptionResult[] = options.map(([planCode, price]) => ({
        planCode,
        billingCycle:      price.billingCycle,
        amount:            price.amount,
        currency:          price.currency,
        savingsPercentage:
          price.billingCycle === 'annual' && monthly
            ? Math.round(((monthly.amount * 12 - price.amount) / (monthly.amount * 12)) * 100)
            : 0,
      }));

      const meta = resolvePlanMeta(plan.name);
      return {
        planName:          plan.name,
        displayName:       plan.displayName,
        displayOrder:      meta.displayOrder,
        isRecommended:     meta.isRecommended,
        shortDescription:  meta.shortDescription,
        featureHighlights: meta.featureHighlights,
        pricing,
        entitlements: plan.entitlements,
        features:     plan.features,
      };
    });

    return catalog.sort((a, b) => a.displayOrder - b.displayOrder);
  }

  // ─── Transitions (payment / lifecycle) ──────────────────────────────────────

  /**
   * Payment captured → active for a fresh billing period.
   *
   * Idempotent by construction: `claimPaymentEvent` inserts `providerRef` into
   * `processed_payment_events` (PK = providerRef) in the SAME transaction as
   * the activation UPDATE below. A conflict (already claimed) means an earlier
   * call already committed the activation — this call returns the current row
   * untouched, with no second version bump / outbox event. The claim and the
   * effect can therefore never drift apart, unlike an ambient flag checked
   * ahead of (not inside) the transaction — see `BillingService.applySuccess`.
   */
  async activateFromPayment(
    accountId: string,
    planFk: string,
    planCode: string,
    orderId: string,
    providerRef: string,
  ): Promise<void> {
    const now = new Date();
    // Billing cycle (monthly vs annual) is keyed into planCode, not planFk —
    // an annual purchase must not lapse into past_due after 30 days just
    // because it shares a planFk with the monthly variant.
    const billingCycle = resolvePlanPrice(planCode)?.billingCycle ?? 'monthly';
    const periodDays = billingCycle === 'annual' ? ANNUAL_BILLING_PERIOD_DAYS : BILLING_PERIOD_DAYS;
    const periodEnd = new Date(now.getTime() + periodDays * 86_400_000);
    await this.transact(accountId, 'SUBSCRIPTION_ACTIVATED', { providerRef }, async (tx) => {
      const claimed = await this.repo.claimPaymentEvent(accountId, orderId, providerRef, tx);
      if (!claimed) return null; // already activated by an earlier call — no-op, no outbox row
      const activated = await this.repo.applyTransition(accountId, {
        status: 'active',
        planFk,
        planCode,
        currentPeriodStart: now,
        currentPeriodEnd:   periodEnd,
        accessValidUntil:   periodEnd,
      }, tx);

      // Every plan switch (upgrade or downgrade) funnels through this same
      // path (there's no separate "change plan" endpoint — see class doc).
      // Re-check against the plan that just became active: if the account
      // now exceeds it on any axis, every write is blocked account-wide
      // until the owner resolves which stores/locations/devices to keep
      // (subscription §15D, device-management §19, POST /subscription/reconciliation).
      const overLimit = await this.downgradeDetection.isOverLimit(accountId, tx);
      if (overLimit) {
        return this.repo.applyTransition(accountId, { reconciliationStatus: 'pending' }, tx);
      }

      // Not over limit on the new plan: if a prior downgrade left anything
      // locked/revoked, this plan change (an upgrade, or a big-enough one)
      // now covers it — restore everything that was locked for 'downgrade'/
      // revoked for 'plan_downgrade' (Step 9 of the reconciliation design).
      // Nothing was ever deleted, so this restore is exact. A no-op update
      // when there was nothing to restore (the common case: first purchase,
      // renewal, or an upgrade that was never preceded by a downgrade).
      if (activated.reconciliationStatus !== 'none') {
        await this.reconciliation.autoRestore(accountId, tx);
      }
      return activated;
    });
  }

  /**
   * Owner requests cancellation (subscription §12). Access continues through
   * the paid period; a reconciliation cron transition (`expireCancelledAtPeriodEnd`)
   * flips `active → cancelled` once `currentPeriodEnd` passes. Idempotent: a
   * second call while already pending is a no-op (no second outbox row).
   */
  async cancel(userId: string): Promise<SubscriptionActionResult> {
    const accountId = await this.requireOwnedAccount(userId);
    const sub = await this.transact(accountId, 'SUBSCRIPTION_CANCEL_REQUESTED', {}, async (tx) => {
      const current = await this.repo.findByAccountId(accountId, tx);
      if (!current) throw new NotFoundError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
      if (current.status !== 'active') {
        throw new UnprocessableError(ErrorCodes.SUBSCRIPTION_NOT_ACTIVE, 'Subscription is not active');
      }
      if (current.cancelAtPeriodEnd) return null; // already requested — no-op
      return this.repo.applyTransition(accountId, { cancelAtPeriodEnd: true }, tx);
    });
    return this.toActionResult(sub);
  }

  /**
   * Owner undoes a pending cancellation while still within the paid period
   * (subscription §13 case A) — no charge, just clears the flag. A lapsed
   * subscription (already `cancelled`/`expired`/`past_due`/`paused`) cannot be
   * reactivated this way; the client must go through checkout instead (§13
   * case B), which reuses the existing payment-activation path.
   */
  async reactivate(userId: string): Promise<SubscriptionActionResult> {
    const accountId = await this.requireOwnedAccount(userId);
    const sub = await this.transact(accountId, 'SUBSCRIPTION_REACTIVATED', {}, async (tx) => {
      const current = await this.repo.findByAccountId(accountId, tx);
      if (!current) throw new NotFoundError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
      if (current.status !== 'active') {
        throw new UnprocessableError(ErrorCodes.SUBSCRIPTION_LAPSED_USE_CHECKOUT, 'Subscription has lapsed; use checkout to resubscribe');
      }
      if (!current.cancelAtPeriodEnd) return null; // nothing pending — no-op
      return this.repo.applyTransition(accountId, { cancelAtPeriodEnd: false }, tx);
    });
    return this.toActionResult(sub);
  }

  // ─── Cache ──────────────────────────────────────────────────────────────────

  /**
   * Invalidate the guard cache after a version bump. Deleting the version pointer
   * is enough: the next read misses, re-queries the DB (now at the new version),
   * and repopulates a fresh version-pinned snapshot. The old snapshot key is left
   * to expire by TTL — unreferenced, so no delete-vs-write race (§19).
   */
  async invalidateCache(accountId: string): Promise<void> {
    try {
      await this.redis.del(subVersionPointerKey(accountId));
    } catch {
      // Best-effort; TTL is the backstop.
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** Persistence entity → the domain result cancel/reactivate hand to the response mapper. */
  private toActionResult(sub: AccountSubscription): SubscriptionActionResult {
    return {
      status:              sub.status,
      cancelAtPeriodEnd:   sub.cancelAtPeriodEnd,
      subscriptionVersion: sub.subscriptionVersion,
    };
  }

  /** Resolve the account a user owns, or reject. Mirrors `BillingService`'s
   *  gate — cancel/reactivate are owner-only billing actions (subscription §12/§13). */
  private async requireOwnedAccount(userId: string): Promise<string> {
    const accountId = await this.repo.findOwnedAccountId(userId);
    if (!accountId) throw new ForbiddenError(ErrorCodes.NOT_ACCOUNT_OWNER, 'You are not the account owner');
    return accountId;
  }

  /**
   * Run a transition + its outbox row atomically, then invalidate the cache.
   * Cache DEL is deliberately post-commit: never inside the txn.
   *
   * `work` may return `null` to signal "already applied, no-op" (e.g. a
   * payment-activation claim that lost the race inside the same tx) — in that
   * case the outbox row is skipped (nothing new happened) and the current row
   * is re-read and returned instead.
   */
  private async transact(
    accountId: string,
    eventType: string,
    payload: Record<string, unknown>,
    work: (tx: DbExecutor) => Promise<AccountSubscription | null>,
  ): Promise<AccountSubscription> {
    const sub = await this.uow.execute(async (tx) => {
      const updated = await work(tx);
      if (!updated) {
        const current = await this.repo.findByAccountId(accountId, tx);
        if (!current) throw new NotFoundError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'Subscription not found', { accountId });
        return current;
      }
      await this.repo.enqueueOutbox(
        accountId,
        eventType,
        { ...payload, status: updated.status, version: updated.subscriptionVersion },
        tx,
      );
      return updated;
    });
    await this.invalidateCache(accountId);
    return sub;
  }

  /** Banner severity from status + remaining window (subscription §22). */
  private computeBanner(sub: AccountSubscription): {
    bannerSeverity: BannerSeverity;
    showUpgradeBanner: boolean;
  } {
    const now = Date.now();
    const daysUntil = (d: Date | null) =>
      d ? Math.ceil((d.getTime() - now) / 86_400_000) : Infinity;

    switch (sub.status) {
      case 'trialing': {
        const left = daysUntil(sub.trialEndsAt);
        if (left <= 1) return { bannerSeverity: 'critical', showUpgradeBanner: true };
        if (left <= 3) return { bannerSeverity: 'warning',  showUpgradeBanner: true };
        return { bannerSeverity: 'info', showUpgradeBanner: true };
      }
      case 'expired':
        return { bannerSeverity: 'critical', showUpgradeBanner: true };
      case 'active':
      default:
        return { bannerSeverity: 'none', showUpgradeBanner: false };
    }
  }
}