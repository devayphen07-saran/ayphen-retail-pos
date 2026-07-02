import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { UnitOfWork, type DbExecutor } from '../db/db.module.js';
import { MOBILE_REDIS } from '../auth/mobile/services/redis.provider.js';
import {
  SubscriptionRepository,
  type AccountSubscription,
  type SubscriptionWithPlan,
} from './subscription.repository.js';
import { subVersionPointerKey } from './subscription-cache.js';

/** One paid period (subscription §9/§10: 30 days for monthly). */
export const BILLING_PERIOD_DAYS = 30;

export type BannerSeverity = 'none' | 'info' | 'warning' | 'critical';

export interface SubscriptionView extends SubscriptionWithPlan {
  bannerSeverity:    BannerSeverity;
  showUpgradeBanner: boolean;
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
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
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

  // ─── Transitions (payment / lifecycle) ──────────────────────────────────────

  /** Payment captured → active for a fresh billing period. */
  async activateFromPayment(
    accountId: string,
    planFk: string,
    providerRef: string,
  ): Promise<AccountSubscription> {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + BILLING_PERIOD_DAYS * 86_400_000);
    const sub = await this.transact(accountId, 'SUBSCRIPTION_ACTIVATED', { providerRef }, (tx) =>
      this.repo.applyTransition(accountId, {
        status: 'active',
        planFk,
        currentPeriodStart: now,
        currentPeriodEnd:   periodEnd,
        accessValidUntil:   periodEnd,
      }, tx),
    );
    return sub;
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

  /**
   * Run a transition + its outbox row atomically, then invalidate the cache.
   * Cache DEL is deliberately post-commit: never inside the txn.
   */
  private async transact(
    accountId: string,
    eventType: string,
    payload: Record<string, unknown>,
    work: (tx: DbExecutor) => Promise<AccountSubscription>,
  ): Promise<AccountSubscription> {
    const sub = await this.uow.execute(async (tx) => {
      const updated = await work(tx);
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