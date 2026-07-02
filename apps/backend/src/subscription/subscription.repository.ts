import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '../db/db.module.js';
import * as schema from '../db/schema.js';
import {
  accountSubscriptions,
  accounts,
  accountUsers,
  plans,
  planEntitlements,
  planFeatures,
  subscriptionAuditOutbox,
} from '../db/schema.js';

export type AccountSubscription = typeof accountSubscriptions.$inferSelect;

export interface SubscriptionWithPlan {
  subscription: AccountSubscription;
  planCode:     string;
  planName:     string;
  entitlements: Record<string, number | null>;
  features:     Record<string, boolean>;
}

/**
 * Data access for account subscriptions (subscription §19, §29). All mutating
 * methods take an optional `tx` so a service can compose the state change and
 * its outbox row into one Unit of Work. Time-based transitions are expressed as
 * a single atomic `UPDATE … WHERE <predicate>` so a concurrent/duplicate run is
 * a no-op (idempotent).
 */
@Injectable()
export class SubscriptionRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** Resolve the account a user owns, or null. Billing actions are owner-gated. */
  async findOwnedAccountId(userId: string, tx?: DbExecutor): Promise<string | null> {
    const [row] = await this.client(tx)
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.ownerUserFk, userId));
    return row?.id ?? null;
  }

  /** The account owner's user id (for account-level billing audit). */
  async findAccountOwnerUserId(accountId: string, tx?: DbExecutor): Promise<string | null> {
    const [row] = await this.client(tx)
      .select({ ownerUserFk: accounts.ownerUserFk })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return row?.ownerUserFk ?? null;
  }

  /** Resolve the (single) account a user belongs to, for the read model. */
  async findMemberAccountId(userId: string, tx?: DbExecutor): Promise<string | null> {
    const [row] = await this.client(tx)
      .select({ accountFk: accountUsers.accountFk })
      .from(accountUsers)
      .where(eq(accountUsers.userFk, userId));
    return row?.accountFk ?? null;
  }

  /** Resolve a plan's id from its name (plans.name), or null. */
  async findPlanIdByName(planName: string, tx?: DbExecutor): Promise<string | null> {
    const [row] = await this.client(tx)
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.name, planName));
    return row?.id ?? null;
  }

  /** Billing prefill from the user's own profile (subscription BR-028). */
  async findBillingPrefill(
    userId: string,
    tx?: DbExecutor,
  ): Promise<{ name: string; contact: string }> {
    const [row] = await this.client(tx)
      .select({ name: schema.users.name, phone: schema.users.phone })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return { name: row?.name ?? '', contact: row?.phone ?? '' };
  }

  async findByAccountId(accountId: string, tx?: DbExecutor): Promise<AccountSubscription | null> {
    const [row] = await this.client(tx)
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));
    return row ?? null;
  }

  /** Full read model: subscription joined with its plan's entitlements + features. */
  async findWithPlan(accountId: string, tx?: DbExecutor): Promise<SubscriptionWithPlan | null> {
    const sub = await this.findByAccountId(accountId, tx);
    if (!sub) return null;

    const [[plan], entRows, featRows] = await Promise.all([
      this.client(tx).select({ code: plans.name, name: plans.displayName })
        .from(plans).where(eq(plans.id, sub.planFk)),
      this.client(tx).select({ key: planEntitlements.key, value: planEntitlements.value })
        .from(planEntitlements).where(eq(planEntitlements.planFk, sub.planFk)),
      this.client(tx).select({ key: planFeatures.key, enabled: planFeatures.enabled })
        .from(planFeatures).where(eq(planFeatures.planFk, sub.planFk)),
    ]);

    const entitlements: Record<string, number | null> = {};
    for (const r of entRows) entitlements[r.key] = r.value;
    const features: Record<string, boolean> = {};
    for (const r of featRows) features[r.key] = r.enabled;

    return {
      subscription: sub,
      planCode: plan?.code ?? 'unknown',
      planName: plan?.name ?? 'Unknown',
      entitlements,
      features,
    };
  }

  /**
   * Apply a state change and bump `subscription_version` in one statement.
   * Returns the fresh row (with the new version) so callers can invalidate cache
   * and emit the outbox event with an accurate version.
   */
  async applyTransition(
    accountId: string,
    patch: Partial<
      Pick<
        AccountSubscription,
        | 'status'
        | 'planFk'
        | 'trialEndsAt'
        | 'currentPeriodStart'
        | 'currentPeriodEnd'
        | 'pastDueGraceUntil'
        | 'accessValidUntil'
        | 'cancelAtPeriodEnd'
        | 'razorpaySubId'
      >
    >,
    tx?: DbExecutor,
  ): Promise<AccountSubscription> {
    const [row] = await this.client(tx)
      .update(accountSubscriptions)
      .set({
        ...patch,
        subscriptionVersion: sql`${accountSubscriptions.subscriptionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(accountSubscriptions.accountFk, accountId))
      .returning();
    return row!;
  }

  /** Queue a critical billing event to the outbox (same txn as the domain write). */
  async enqueueOutbox(
    accountId: string,
    eventType: string,
    payload: Record<string, unknown>,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .insert(subscriptionAuditOutbox)
      .values({ accountFk: accountId, eventType, payload });
  }

  // ─── Reconciliation cron: atomic, idempotent set-based transition ───────────

  /**
   * trialing → expired where the trial clock has elapsed (no recurrence/grace in
   * this flow). Single atomic `UPDATE … WHERE` so a duplicate run is a no-op.
   * access_valid_until (= trial_ends_at) is already in the past, so the guard
   * write-blocks immediately; this just makes the status explicit + bumps version.
   */
  async expireTrials(now: Date, tx?: DbExecutor): Promise<string[]> {
    const rows = await this.client(tx)
      .update(accountSubscriptions)
      .set({
        status: 'expired',
        subscriptionVersion: sql`${accountSubscriptions.subscriptionVersion} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(accountSubscriptions.status, 'trialing'),
        lt(accountSubscriptions.trialEndsAt, now),
      ))
      .returning({ accountFk: accountSubscriptions.accountFk });
    return rows.map((r) => r.accountFk);
  }

  // ─── Outbox drain ───────────────────────────────────────────────────────────

  async findPendingOutbox(limit: number, tx?: DbExecutor) {
    return this.client(tx)
      .select()
      .from(subscriptionAuditOutbox)
      .where(sql`${subscriptionAuditOutbox.processedAt} IS NULL`)
      .orderBy(subscriptionAuditOutbox.createdAt)
      .limit(limit);
  }

  async markOutboxProcessed(id: string, now: Date, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(subscriptionAuditOutbox)
      .set({ processedAt: now })
      .where(eq(subscriptionAuditOutbox.id, id));
  }
}
