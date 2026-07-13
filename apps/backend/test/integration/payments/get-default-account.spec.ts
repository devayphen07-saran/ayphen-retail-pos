import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { PaymentAccountRepository } from '../../../src/payments/payment-account.repository';
import { accounts, users, stores, paymentAccounts } from '../../../src/db/schema';

/**
 * BR-9: `getDefaultAccount` must always resolve a tender for a seeded store.
 * Resolution order is flagged-default → Cash system row → first active by name,
 * and it is TOTAL because Cash is `is_system` (undeletable/undeactivatable via
 * the seed-lock), so it can never return null for a real store. These tests
 * insert the seed rows directly (bypassing the seed-lock, which lives in the
 * write handler) to exercise every fallback branch.
 */
describe('PaymentAccountRepository.getDefaultAccount — BR-9 default resolution', () => {
  let db: Database;
  let repo: PaymentAccountRepository;
  let storeId: string;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [PaymentAccountRepository],
    }).compile();
    db = moduleRef.get(DRIZZLE);
    repo = moduleRef.get(PaymentAccountRepository);
  });

  beforeEach(async () => {
    await db.delete(paymentAccounts);
    await db.delete(stores);
    await db.delete(users);
    await db.delete(accounts);

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Acct' })
      .returning();
    const [user] = await db
      .insert(users)
      .values({ name: 'Owner', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userId = user!.id;
    const [store] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Store' })
      .returning();
    storeId = store!.id;

    // Seed Cash (default) + Bank, mirroring seedDefaultPaymentAccounts.
    await db.insert(paymentAccounts).values([
      {
        storeFk: storeId,
        name: 'Cash',
        kind: 'cash',
        isSystem: true,
        systemKey: 'cash',
        isDefault: true,
        isActive: true,
        createdBy: userId,
      },
      {
        storeFk: storeId,
        name: 'Bank',
        kind: 'bank',
        isSystem: true,
        systemKey: 'bank',
        isDefault: false,
        isActive: true,
        createdBy: userId,
      },
    ]);
  });

  function addAccount(overrides: Partial<typeof paymentAccounts.$inferInsert> = {}) {
    return db
      .insert(paymentAccounts)
      .values({
        storeFk: storeId,
        name: `Acc-${Date.now()}-${Math.random()}`,
        kind: 'upi',
        isActive: true,
        isDefault: false,
        createdBy: userId,
        ...overrides,
      })
      .returning();
  }

  it('returns the flagged default when one exists (a custom account)', async () => {
    // Move the default off Cash onto a custom account (single-default invariant).
    await db.update(paymentAccounts).set({ isDefault: false }).where(eq(paymentAccounts.storeFk, storeId));
    const [custom] = await addAccount({ name: 'PhonePe', isDefault: true });

    const resolved = await repo.getDefaultAccount(storeId);
    expect(resolved?.guuid).toBe(custom!.guuid);
    expect(resolved?.name).toBe('PhonePe');
  });

  it('falls back to Cash when no row is flagged default', async () => {
    await db.update(paymentAccounts).set({ isDefault: false }).where(eq(paymentAccounts.storeFk, storeId));

    const resolved = await repo.getDefaultAccount(storeId);
    expect(resolved?.systemKey).toBe('cash');
  });

  it('falls back to Cash when the flagged default was soft-deleted', async () => {
    await db.update(paymentAccounts).set({ isDefault: false }).where(eq(paymentAccounts.storeFk, storeId));
    const [custom] = await addAccount({ name: 'PhonePe', isDefault: true });
    // Soft-delete the current default (deletedAt set; is_default not cleared).
    await db
      .update(paymentAccounts)
      .set({ deletedAt: new Date() })
      .where(eq(paymentAccounts.guuid, custom!.guuid));

    const resolved = await repo.getDefaultAccount(storeId);
    expect(resolved?.systemKey).toBe('cash');
  });

  it('never returns null even when Cash is the only active account', async () => {
    // Deactivate Bank, add + delete a custom, leave only Cash active.
    await db
      .update(paymentAccounts)
      .set({ isActive: false, isDefault: false })
      .where(and(eq(paymentAccounts.storeFk, storeId), eq(paymentAccounts.systemKey, 'bank')));
    const [custom] = await addAccount({ name: 'Gone' });
    await db.update(paymentAccounts).set({ deletedAt: new Date() }).where(eq(paymentAccounts.guuid, custom!.guuid));

    const resolved = await repo.getDefaultAccount(storeId);
    expect(resolved).not.toBeNull();
    expect(resolved?.systemKey).toBe('cash');
  });

  it('excludes inactive accounts from resolution', async () => {
    // Inactive rows are never eligible (they can't be the default anyway — the
    // ck_payment_accounts_default_active CHECK forbids it). With defaults cleared
    // and only an inactive custom present, resolution still lands on Cash.
    await db.update(paymentAccounts).set({ isDefault: false }).where(eq(paymentAccounts.storeFk, storeId));
    await addAccount({ name: 'Dormant', isActive: false });

    const resolved = await repo.getDefaultAccount(storeId);
    expect(resolved?.systemKey).toBe('cash');
    expect(resolved?.name).toBe('Cash');
  });
});
