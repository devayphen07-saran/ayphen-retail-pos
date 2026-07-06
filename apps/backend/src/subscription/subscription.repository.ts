import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import * as schema from '#db/schema.js';
import {
  accountSubscriptions,
  accounts,
  accountUsers,
  plans,
  planEntitlements,
  planFeatures,
  subscriptionAuditOutbox,
  processedPaymentEvents,
  paymentOrders,
} from '#db/schema.js';

export type AccountSubscription = typeof accountSubscriptions.$inferSelect;

export interface SubscriptionWithPlan {
  subscription: AccountSubscription;
  planCode:     string;
  planName:     string;
  // Billing cadence code (e.g. 'starter_annual') from account_subscriptions.plan_code —
  // distinct from `planCode` above, which is actually the plan *name* ('starter').
  billingPlanCode: string | null;
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

  /** Just the version counter — the cheap poll target for `GET /me/subscription/sv`. */
  async findVersionByAccountId(accountId: string, tx?: DbExecutor): Promise<number | null> {
    const [row] = await this.client(tx)
      .select({ subscriptionVersion: accountSubscriptions.subscriptionVersion })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));
    return row?.subscriptionVersion ?? null;
  }

  /** Resolve a plan's id from its name (plans.name), or null. */
  async findPlanIdByName(planName: string, tx?: DbExecutor): Promise<string | null> {
    const [row] = await this.client(tx)
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.name, planName));
    return row?.id ?? null;
  }

  /**
   * All active plans with their entitlements/features, for the plan-catalog
   * endpoint (GET /me/subscription/plans). Static config, cheap to fetch in
   * full — the controller layer merges in pricing from `PLAN_PRICING`.
   */
  async findActivePlansWithEntitlementsAndFeatures(tx?: DbExecutor): Promise<
    Array<{ id: string; name: string; displayName: string; entitlements: Record<string, number | null>; features: Record<string, boolean> }>
  > {
    const client = this.client(tx);
    const [planRows, entRows, featRows] = await Promise.all([
      client.select({ id: plans.id, name: plans.name, displayName: plans.displayName })
        .from(plans).where(eq(plans.isActive, true)),
      client.select({ planFk: planEntitlements.planFk, key: planEntitlements.key, value: planEntitlements.value })
        .from(planEntitlements),
      client.select({ planFk: planFeatures.planFk, key: planFeatures.key, enabled: planFeatures.enabled })
        .from(planFeatures),
    ]);

    return planRows.map((plan) => {
      const entitlements: Record<string, number | null> = {};
      for (const r of entRows) if (r.planFk === plan.id) entitlements[r.key] = r.value;
      const features: Record<string, boolean> = {};
      for (const r of featRows) if (r.planFk === plan.id) features[r.key] = r.enabled;
      return { ...plan, entitlements, features };
    });
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
      billingPlanCode: sub.planCode,
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
        | 'planCode'
        | 'trialEndsAt'
        | 'currentPeriodStart'
        | 'currentPeriodEnd'
        | 'pastDueGraceUntil'
        | 'accessValidUntil'
        | 'cancelAtPeriodEnd'
        | 'razorpaySubId'
        | 'reconciliationStatus'
        | 'reconciliationEffectiveAt'
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
    // Zero-match UPDATE (account has no subscription row) → clean 404 rather than
    // handing back `undefined` typed as a subscription and crashing downstream.
    if (!row) {
      throw new NotFoundError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'Subscription not found for account');
    }
    return row;
  }

  /**
   * Transactionally claim a payment event as processed. Returns `true` the
   * first time (row inserted) and `false` on every subsequent call for the
   * same `providerRef` (unique-violation → no-op). Must run in the SAME `tx`
   * as the activation it guards — that's what makes the claim and the effect
   * atomic (subscription §9/§19; the Redis `pay:done:*` flag ahead of this is
   * a fast-path pre-check only, not the source of truth).
   */
  async claimPaymentEvent(
    accountId: string,
    orderId: string,
    providerRef: string,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const rows = await this.client(tx)
      .insert(processedPaymentEvents)
      .values({ providerRef, accountFk: accountId, orderId })
      .onConflictDoNothing({ target: processedPaymentEvents.providerRef })
      .returning({ providerRef: processedPaymentEvents.providerRef });
    return rows.length > 0;
  }

  /**
   * Persist the account/plan a checkout order was created for (subscription
   * §9). Durable counterpart to `BillingService`'s Redis `pay:order:{id}` —
   * that key has a 1h TTL, but a payment webhook can legitimately arrive
   * later (provider redelivery), and without this row there'd be nothing to
   * activate against even though `processed_payment_events` could still
   * accept the claim.
   */
  async insertPaymentOrder(
    orderId: string,
    accountId: string,
    planFk: string,
    planCode: string,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .insert(paymentOrders)
      .values({ orderId, accountFk: accountId, planFk, planCode });
  }

  /** Read back a pending order's account/plan mapping, or null if unknown. */
  async findPaymentOrder(
    orderId: string,
    tx?: DbExecutor,
  ): Promise<{ accountId: string; planFk: string; planCode: string } | null> {
    const [row] = await this.client(tx)
      .select({
        accountId: paymentOrders.accountFk,
        planFk:    paymentOrders.planFk,
        planCode:  paymentOrders.planCode,
      })
      .from(paymentOrders)
      .where(eq(paymentOrders.orderId, orderId));
    return row ?? null;
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

  /**
   * active → past_due where the paid period has elapsed (renewal didn't happen —
   * this codebase has no recurring-charge webhook yet, so period-end itself is
   * the failure signal). Opens the 7-day grace window (subscription §6): both
   * `pastDueGraceUntil` and `accessValidUntil` are stamped so the guard's access
   * check and the `access_valid_until_required` CHECK constraint stay satisfied.
   *
   * Excludes `cancel_at_period_end = true` rows — those end the period on
   * purpose (§12) and must fall through to `expireCancelledAtPeriodEnd` instead
   * of being treated as an unpaid-renewal failure.
   */
  async expireActiveToPastDue(
    now: Date,
    graceDays: number,
    tx?: DbExecutor,
  ): Promise<string[]> {
    const graceUntil = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);
    const rows = await this.client(tx)
      .update(accountSubscriptions)
      .set({
        status: 'past_due',
        pastDueGraceUntil: graceUntil,
        accessValidUntil: graceUntil,
        subscriptionVersion: sql`${accountSubscriptions.subscriptionVersion} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(accountSubscriptions.status, 'active'),
        eq(accountSubscriptions.cancelAtPeriodEnd, false),
        lt(accountSubscriptions.currentPeriodEnd, now),
      ))
      .returning({ accountFk: accountSubscriptions.accountFk });
    return rows.map((r) => r.accountFk);
  }

  /**
   * active + cancel_at_period_end → cancelled once the paid period elapses
   * (subscription §12). `accessValidUntil` is left as-is (already
   * `currentPeriodEnd`, already in the past) so the guard's hard-block path
   * fires; nothing is deleted, reads stay open. Single atomic `UPDATE … WHERE`,
   * idempotent on a duplicate/concurrent run.
   */
  async expireCancelledAtPeriodEnd(now: Date, tx?: DbExecutor): Promise<string[]> {
    const rows = await this.client(tx)
      .update(accountSubscriptions)
      .set({
        status: 'cancelled',
        subscriptionVersion: sql`${accountSubscriptions.subscriptionVersion} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(accountSubscriptions.status, 'active'),
        eq(accountSubscriptions.cancelAtPeriodEnd, true),
        lt(accountSubscriptions.currentPeriodEnd, now),
      ))
      .returning({ accountFk: accountSubscriptions.accountFk });
    return rows.map((r) => r.accountFk);
  }

  /**
   * past_due → expired once the 7-day grace window has elapsed and payment
   * still hasn't recovered (subscription §11). `accessValidUntil` is already in
   * the past at this point (it equals `pastDueGraceUntil`) — this just makes the
   * status explicit so `SubscriptionStatusGuard`'s hard-block path fires instead
   * of only the soft (window-expired) path.
   */
  async expirePastDueGrace(now: Date, tx?: DbExecutor): Promise<string[]> {
    const rows = await this.client(tx)
      .update(accountSubscriptions)
      .set({
        status: 'expired',
        subscriptionVersion: sql`${accountSubscriptions.subscriptionVersion} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(accountSubscriptions.status, 'past_due'),
        lt(accountSubscriptions.pastDueGraceUntil, now),
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

  /** Bump the drain retry counter, returning the new attempt count. */
  async incrementOutboxAttempt(id: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .update(subscriptionAuditOutbox)
      .set({ attempts: sql`${subscriptionAuditOutbox.attempts} + 1` })
      .where(eq(subscriptionAuditOutbox.id, id))
      .returning({ attempts: subscriptionAuditOutbox.attempts });
    return row?.attempts ?? 0;
  }

  /** Give up on a poison row: stamp processed (so it leaves the pending scan)
   *  and record that it was dead-lettered, for alerting. */
  async deadLetterOutbox(id: string, now: Date, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(subscriptionAuditOutbox)
      .set({ processedAt: now, deadLetteredAt: now })
      .where(eq(subscriptionAuditOutbox.id, id));
  }
}
