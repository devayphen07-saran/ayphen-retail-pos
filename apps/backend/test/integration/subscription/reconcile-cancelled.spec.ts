import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { SubscriptionRepository } from '../../../src/subscription/subscription.repository';
import { accounts, plans, accountSubscriptions } from '../../../src/db/schema';

/**
 * `expireCancelledAtPeriodEnd` (subscription §12) must claim active +
 * cancel_at_period_end rows once the paid period elapses, and
 * `expireActiveToPastDue` must NOT also claim them — a subscription the owner
 * intentionally ended must become `cancelled`, never mistaken for an unpaid
 * renewal failure.
 */
describe('SubscriptionRepository — cancelled-at-period-end reconciliation', () => {
  let db: Database;
  let repo: SubscriptionRepository;
  let planId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [SubscriptionRepository],
    }).compile();
    db = moduleRef.get(DRIZZLE);
    repo = moduleRef.get(SubscriptionRepository);
  });

  beforeEach(async () => {
    await db.delete(accountSubscriptions);
    await db.delete(accounts);
    await db.delete(plans).where(eq(plans.name, 'growth-reconcile-test'));

    const [plan] = await db
      .insert(plans)
      .values({ name: 'growth-reconcile-test', displayName: 'Growth (reconcile test)' })
      .returning();
    planId = plan!.id;
  });

  async function makeAccount(): Promise<string> {
    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Test Account' })
      .returning();
    return account!.id;
  }

  it('transitions an elapsed cancel_at_period_end subscription to cancelled', async () => {
    const accountId = await makeAccount();
    const past = new Date(Date.now() - 60_000);
    await db.insert(accountSubscriptions).values({
      accountFk: accountId,
      planFk: planId,
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: past,
      accessValidUntil: past,
    });

    const now = new Date();
    const cancelled = await repo.expireCancelledAtPeriodEnd(now);
    expect(cancelled).toContain(accountId);

    const [sub] = await db
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));
    expect(sub!.status).toBe('cancelled');
    expect(sub!.subscriptionVersion).toBe(2);
  });

  it('expireActiveToPastDue does not touch a cancel_at_period_end subscription', async () => {
    const accountId = await makeAccount();
    const past = new Date(Date.now() - 60_000);
    await db.insert(accountSubscriptions).values({
      accountFk: accountId,
      planFk: planId,
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: past,
      accessValidUntil: past,
    });

    const now = new Date();
    const pastDued = await repo.expireActiveToPastDue(now, 7);
    expect(pastDued).not.toContain(accountId);

    const [sub] = await db
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));
    expect(sub!.status).toBe('active'); // untouched — awaiting expireCancelledAtPeriodEnd instead
  });

  it('expireActiveToPastDue still claims a genuine unpaid-renewal failure (no cancel intent)', async () => {
    const accountId = await makeAccount();
    const past = new Date(Date.now() - 60_000);
    await db.insert(accountSubscriptions).values({
      accountFk: accountId,
      planFk: planId,
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: past,
      accessValidUntil: past,
    });

    const now = new Date();
    const pastDued = await repo.expireActiveToPastDue(now, 7);
    expect(pastDued).toContain(accountId);

    const [sub] = await db
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));
    expect(sub!.status).toBe('past_due');
  });
});
