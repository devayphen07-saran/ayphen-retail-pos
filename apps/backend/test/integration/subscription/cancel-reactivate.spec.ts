import { Test } from '@nestjs/testing';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { MOBILE_REDIS } from '../../../src/auth/mobile/services/redis.provider';
import { SubscriptionRepository } from '../../../src/subscription/subscription.repository';
import { SubscriptionService } from '../../../src/subscription/subscription.service';
import { DowngradeDetectionService } from '../../../src/subscription/downgrade-detection.service';
import { ReconciliationService } from '../../../src/subscription/reconciliation.service';
import { EntitlementService } from '../../../src/subscription/entitlement.service';
import { StoreRepository } from '../../../src/stores/store.repository';
import { DeviceAccessRepository } from '../../../src/devices/device-access.repository';
import { env } from '../../../src/config/env';
import {
  accounts,
  users,
  plans,
  accountSubscriptions,
  subscriptionAuditOutbox,
} from '../../../src/db/schema';

/**
 * Coverage for cancel/reactivate (subscription §12/§13):
 *   - cancel() sets cancel_at_period_end, is owner-gated, and is idempotent.
 *   - reactivate() undoes a pending cancellation in-period, but refuses once
 *     the subscription has actually lapsed (client must use checkout instead).
 *   - the reconciliation transition (`expireCancelledAtPeriodEnd`) is exercised
 *     separately in reconcile.spec — this file only covers the request/undo pair.
 */
describe('SubscriptionService.cancel / reactivate', () => {
  let db: Database;
  let redis: Redis;
  let service: SubscriptionService;
  let ownerId: string;
  let otherUserId: string;
  let accountId: string;
  let planId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [
        SubscriptionRepository,
        SubscriptionService,
        DowngradeDetectionService,
        ReconciliationService,
        EntitlementService,
        StoreRepository,
        DeviceAccessRepository,
        { provide: MOBILE_REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
      ],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    redis = moduleRef.get(MOBILE_REDIS);
    service = moduleRef.get(SubscriptionService);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.delete(subscriptionAuditOutbox);
    await db.delete(accountSubscriptions);
    await db.delete(accounts);
    await db.delete(users).where(eq(users.name, 'Cancel Test Owner'));
    await db.delete(users).where(eq(users.name, 'Cancel Test Stranger'));
    await db.delete(plans).where(eq(plans.name, 'growth-cancel-test'));

    const [plan] = await db
      .insert(plans)
      .values({ name: 'growth-cancel-test', displayName: 'Growth (cancel test)' })
      .returning();
    planId = plan!.id;

    const [owner] = await db
      .insert(users)
      .values({ name: 'Cancel Test Owner', phone: `+91${Date.now()}` })
      .returning();
    ownerId = owner!.id;

    const [stranger] = await db
      .insert(users)
      .values({ name: 'Cancel Test Stranger', phone: `+92${Date.now()}` })
      .returning();
    otherUserId = stranger!.id;

    const [account] = await db
      .insert(accounts)
      .values({
        accountNumber: `ACC-${Date.now()}-${Math.random()}`,
        name: 'Test Account',
        ownerUserFk: ownerId,
      })
      .returning();
    accountId = account!.id;

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 86_400_000);
    await db.insert(accountSubscriptions).values({
      accountFk: accountId,
      planFk: planId,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      accessValidUntil: periodEnd,
    });
  });

  describe('cancel', () => {
    it('sets cancel_at_period_end, bumps version, and enqueues one outbox row', async () => {
      const sub = await service.cancel(ownerId);
      expect(sub.status).toBe('active'); // access continues through the period
      expect(sub.cancelAtPeriodEnd).toBe(true);
      expect(sub.subscriptionVersion).toBe(2);

      const outboxRows = await db
        .select()
        .from(subscriptionAuditOutbox)
        .where(eq(subscriptionAuditOutbox.accountFk, accountId));
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]!.eventType).toBe('SUBSCRIPTION_CANCEL_REQUESTED');
    });

    it('a second call while already pending is a no-op: no version bump, no second outbox row', async () => {
      const first = await service.cancel(ownerId);
      const second = await service.cancel(ownerId);

      expect(second.subscriptionVersion).toBe(first.subscriptionVersion);
      const outboxRows = await db
        .select()
        .from(subscriptionAuditOutbox)
        .where(eq(subscriptionAuditOutbox.accountFk, accountId));
      expect(outboxRows).toHaveLength(1);
    });

    it('rejects a non-owner', async () => {
      await expect(service.cancel(otherUserId)).rejects.toThrow(ForbiddenException);
    });

    it('rejects cancelling a subscription that is not active', async () => {
      await db
        .update(accountSubscriptions)
        .set({ status: 'past_due', pastDueGraceUntil: new Date(Date.now() + 86_400_000) })
        .where(eq(accountSubscriptions.accountFk, accountId));

      await expect(service.cancel(ownerId)).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('reactivate', () => {
    it('clears a pending cancellation with no charge, in-period', async () => {
      await service.cancel(ownerId);
      const sub = await service.reactivate(ownerId);
      expect(sub.status).toBe('active');
      expect(sub.cancelAtPeriodEnd).toBe(false);
      expect(sub.subscriptionVersion).toBe(3); // 1 -> cancel(2) -> reactivate(3)

      const outboxRows = await db
        .select()
        .from(subscriptionAuditOutbox)
        .where(eq(subscriptionAuditOutbox.accountFk, accountId));
      expect(outboxRows.map((r) => r.eventType)).toEqual([
        'SUBSCRIPTION_CANCEL_REQUESTED',
        'SUBSCRIPTION_REACTIVATED',
      ]);
    });

    it('is a no-op when nothing is pending', async () => {
      const sub = await service.reactivate(ownerId);
      expect(sub.cancelAtPeriodEnd).toBe(false);
      expect(sub.subscriptionVersion).toBe(1); // untouched

      const outboxRows = await db
        .select()
        .from(subscriptionAuditOutbox)
        .where(eq(subscriptionAuditOutbox.accountFk, accountId));
      expect(outboxRows).toHaveLength(0);
    });

    it('rejects reactivating a lapsed subscription — client must use checkout', async () => {
      await db
        .update(accountSubscriptions)
        .set({ status: 'cancelled' })
        .where(eq(accountSubscriptions.accountFk, accountId));

      await expect(service.reactivate(ownerId)).rejects.toThrow(UnprocessableEntityException);
    });

    it('rejects a non-owner', async () => {
      await expect(service.reactivate(otherUserId)).rejects.toThrow(ForbiddenException);
    });
  });
});
