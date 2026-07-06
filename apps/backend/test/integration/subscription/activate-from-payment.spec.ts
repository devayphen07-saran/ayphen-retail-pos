import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, UnitOfWork, type Database } from '../../../src/db/db.module';
import { MOBILE_REDIS } from '../../../src/auth/mobile/services/redis.provider';
import { SubscriptionRepository } from '../../../src/subscription/subscription.repository';
import { SubscriptionService } from '../../../src/subscription/subscription.service';
import { DowngradeDetectionService } from '../../../src/subscription/downgrade-detection.service';
import { ReconciliationService } from '../../../src/subscription/reconciliation.service';
import { EntitlementService } from '../../../src/subscription/entitlement.service';
import { StoreRepository } from '../../../src/stores/store.repository';
import { LocationRepository } from '../../../src/locations/location.repository';
import { DeviceAccessRepository } from '../../../src/devices/device-access.repository';
import { env } from '../../../src/config/env';
import {
  accounts,
  plans,
  accountSubscriptions,
  processedPaymentEvents,
  subscriptionAuditOutbox,
} from '../../../src/db/schema';

/**
 * Regression coverage for the payment-activation idempotency fix (flow-critic
 * review, subscription §9/§19): `activateFromPayment` must transactionally
 * claim `providerRef` in `processed_payment_events` in the SAME unit of work
 * as the state transition, so a duplicate delivery (webhook redelivery racing
 * a client `verify()` call, or a bare retry) can never double-activate or —
 * the bug this guards against — leave a payment permanently stuck because an
 * ambient Redis flag was claimed before the DB write and never released.
 */
describe('SubscriptionService.activateFromPayment — idempotency', () => {
  let db: Database;
  let redis: Redis;
  let service: SubscriptionService;
  let uow: UnitOfWork;
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
        LocationRepository,
        DeviceAccessRepository,
        { provide: MOBILE_REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
      ],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    redis = moduleRef.get(MOBILE_REDIS);
    service = moduleRef.get(SubscriptionService);
    uow = moduleRef.get(UnitOfWork);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.delete(processedPaymentEvents);
    await db.delete(subscriptionAuditOutbox);
    await db.delete(accountSubscriptions);
    await db.delete(accounts);
    await db.delete(plans).where(eq(plans.name, 'growth-test'));

    const [plan] = await db
      .insert(plans)
      .values({ name: 'growth-test', displayName: 'Growth (test)' })
      .returning();
    planId = plan!.id;

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Test Account' })
      .returning();
    accountId = account!.id;

    await db.insert(accountSubscriptions).values({ accountFk: accountId, planFk: planId });
  });

  it('activates once and records one outbox row for a single call', async () => {
    const sub = await service.activateFromPayment(accountId, planId, 'growth-test', 'order_1', 'pay_1');
    expect(sub.status).toBe('active');
    expect(sub.subscriptionVersion).toBe(2); // 1 (default) -> 2 (activation)

    const outboxRows = await db
      .select()
      .from(subscriptionAuditOutbox)
      .where(eq(subscriptionAuditOutbox.accountFk, accountId));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.eventType).toBe('SUBSCRIPTION_ACTIVATED');

    const claims = await db
      .select()
      .from(processedPaymentEvents)
      .where(eq(processedPaymentEvents.providerRef, 'pay_1'));
    expect(claims).toHaveLength(1);
  });

  it('a duplicate call for the same providerRef is a no-op: no version bump, no second outbox row', async () => {
    const first = await service.activateFromPayment(accountId, planId, 'growth-test', 'order_1', 'pay_1');
    const second = await service.activateFromPayment(accountId, planId, 'growth-test', 'order_1', 'pay_1');

    expect(second.subscriptionVersion).toBe(first.subscriptionVersion);
    expect(second.status).toBe('active');

    const outboxRows = await db
      .select()
      .from(subscriptionAuditOutbox)
      .where(eq(subscriptionAuditOutbox.accountFk, accountId));
    expect(outboxRows).toHaveLength(1); // still just the one from the first call
  });

  it('two concurrent calls for the same providerRef activate exactly once', async () => {
    const [a, b] = await Promise.all([
      service.activateFromPayment(accountId, planId, 'growth-test', 'order_concurrent', 'pay_concurrent'),
      service.activateFromPayment(accountId, planId, 'growth-test', 'order_concurrent', 'pay_concurrent'),
    ]);

    // Exactly one of the two calls performed the real transition (version 2);
    // the other observed the claim conflict and returned the same row as a no-op.
    expect(a.subscriptionVersion).toBe(b.subscriptionVersion);
    expect(a.subscriptionVersion).toBe(2);

    const outboxRows = await db
      .select()
      .from(subscriptionAuditOutbox)
      .where(eq(subscriptionAuditOutbox.accountFk, accountId));
    expect(outboxRows).toHaveLength(1);

    const claims = await db
      .select()
      .from(processedPaymentEvents)
      .where(eq(processedPaymentEvents.providerRef, 'pay_concurrent'));
    expect(claims).toHaveLength(1);
  });

  it('a failure after the claim rolls back the whole transaction — the claim is not left behind', async () => {
    const realExecute = uow.execute.bind(uow);
    const spy = jest
      .spyOn(uow, 'execute')
      .mockImplementationOnce((work) =>
        realExecute(async (tx) => {
          await work(tx);
          throw new Error('simulated failure after the domain write, before commit');
        }),
      );

    await expect(
      service.activateFromPayment(accountId, planId, 'growth-test', 'order_fail', 'pay_fail'),
    ).rejects.toThrow('simulated failure');

    // Transaction rolled back: no claim, no activation, no outbox row.
    const claims = await db
      .select()
      .from(processedPaymentEvents)
      .where(eq(processedPaymentEvents.providerRef, 'pay_fail'));
    expect(claims).toHaveLength(0);

    const [sub] = await db
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));
    expect(sub!.status).toBe('trialing');

    spy.mockRestore();

    // Retrying after the failure succeeds cleanly — nothing was left stuck.
    const retried = await service.activateFromPayment(accountId, planId, 'growth-test', 'order_fail', 'pay_fail');
    expect(retried.status).toBe('active');
  });
});
