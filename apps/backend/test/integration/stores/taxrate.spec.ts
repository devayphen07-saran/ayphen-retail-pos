import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { AuditService } from '../../../src/common/audit/audit.service';
import { TaxRateRepository } from '../../../src/stores/taxrate/taxrate.repository';
import { TaxRateService } from '../../../src/stores/taxrate/taxrate.service';
import { AppException } from '../../../src/common/exceptions/app.exception';
import {
  accounts,
  accountUsers,
  users,
  stores,
  taxRates,
} from '../../../src/db/schema';

/**
 * TaxRateService — online-only, server-authoritative tax-rate CRUD. Covers the
 * business invariants: name uniqueness (DB-enforced), optimistic-locked edits,
 * not-found vs version-conflict disambiguation, idempotent deactivation, rate
 * precision normalization, and cross-store isolation.
 */
describe('TaxRateService', () => {
  let db: Database;
  let service: TaxRateService;

  let storeId: string;
  let otherStoreId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [TaxRateRepository, TaxRateService, AuditService],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    service = moduleRef.get(TaxRateService);
  });

  beforeEach(async () => {
    await db.delete(taxRates);
    await db.delete(stores);
    await db.delete(accountUsers);
    await db.delete(users);
    await db.delete(accounts);

    const [owner] = await db
      .insert(users)
      .values({ name: 'Owner', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    ownerUserId = owner!.id;

    const [account] = await db
      .insert(accounts)
      .values({
        accountNumber: `ACC-${Date.now()}-${Math.random()}`,
        name: 'Acct',
        ownerUserFk: ownerUserId,
      })
      .returning();

    const [store] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Main Store' })
      .returning();
    storeId = store!.id;

    const [other] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Second Store' })
      .returning();
    otherStoreId = other!.id;
  });

  const input = (over: Partial<{ name: string; ratePercent: number; isInclusive: boolean }> = {}) => ({
    name: 'GST 18%',
    ratePercent: 18,
    isInclusive: false,
    ...over,
  });

  it('creates a tax rate, normalizing the rate to 3 decimals', async () => {
    const row = await service.create(storeId, ownerUserId, input({ ratePercent: 18.12345 }));
    expect(row).toMatchObject({
      name: 'GST 18%',
      ratePercent: '18.123',
      isInclusive: false,
      isActive: true,
      rowVersion: 1,
    });
  });

  it('rejects a duplicate name (case-insensitive) in the same store', async () => {
    await service.create(storeId, ownerUserId, input({ name: 'GST 18%' }));
    await expect(
      service.create(storeId, ownerUserId, input({ name: 'gst 18%' })),
    ).rejects.toMatchObject({ errorCode: 'TAXRATE_ALREADY_EXISTS' } satisfies Partial<AppException>);
  });

  it('allows the same name in a different store (store isolation)', async () => {
    await service.create(storeId, ownerUserId, input());
    await expect(
      service.create(otherStoreId, ownerUserId, input()),
    ).resolves.toMatchObject({ name: 'GST 18%' });
  });

  it('updates with the current row version and bumps it', async () => {
    const created = await service.create(storeId, ownerUserId, input());
    const updated = await service.update(storeId, ownerUserId, created.id, {
      name: 'GST 18% (rev)',
      ratePercent: 12,
      isInclusive: true,
      expectedRowVersion: created.rowVersion,
    });
    expect(updated).toMatchObject({
      name: 'GST 18% (rev)',
      ratePercent: '12.000',
      isInclusive: true,
    });
    expect(updated.rowVersion).toBeGreaterThan(created.rowVersion);
  });

  it('rejects an update with a stale row version', async () => {
    const created = await service.create(storeId, ownerUserId, input());
    await expect(
      service.update(storeId, ownerUserId, created.id, {
        ...input({ name: 'stale' }),
        expectedRowVersion: created.rowVersion + 99,
      }),
    ).rejects.toMatchObject({ errorCode: 'TAXRATE_VERSION_CONFLICT' } satisfies Partial<AppException>);
  });

  it('returns not-found when updating a non-existent rate', async () => {
    await expect(
      service.update(storeId, ownerUserId, '00000000-0000-0000-0000-000000000000', {
        ...input(),
        expectedRowVersion: 1,
      }),
    ).rejects.toMatchObject({ errorCode: 'TAXRATE_NOT_FOUND' } satisfies Partial<AppException>);
  });

  it('cannot update a rate belonging to another store', async () => {
    const created = await service.create(storeId, ownerUserId, input());
    await expect(
      service.update(otherStoreId, ownerUserId, created.id, {
        ...input({ name: 'hijack' }),
        expectedRowVersion: created.rowVersion,
      }),
    ).rejects.toMatchObject({ errorCode: 'TAXRATE_NOT_FOUND' } satisfies Partial<AppException>);
  });

  it('deactivates a rate (isActive false, still alive) and is idempotent', async () => {
    const created = await service.create(storeId, ownerUserId, input());

    await expect(service.deactivate(storeId, ownerUserId, created.id)).resolves.toBeUndefined();
    const [row] = await db.select().from(taxRates).where(eq(taxRates.id, created.id));
    expect(row?.isActive).toBe(false);
    expect(row?.deletedAt).toBeNull();

    // Second call is a no-op success, not an error.
    await expect(service.deactivate(storeId, ownerUserId, created.id)).resolves.toBeUndefined();
  });

  it('reuses a freed name after deactivation is NOT allowed (still live)', async () => {
    // Deactivation keeps the row live (deleted_at null), so the unique index
    // still holds the name — a re-create with the same name must be rejected.
    const created = await service.create(storeId, ownerUserId, input());
    await service.deactivate(storeId, ownerUserId, created.id);
    await expect(
      service.create(storeId, ownerUserId, input()),
    ).rejects.toMatchObject({ errorCode: 'TAXRATE_ALREADY_EXISTS' } satisfies Partial<AppException>);
  });

  it('getRate returns not-found for a rate in another store', async () => {
    const created = await service.create(storeId, ownerUserId, input());
    await expect(
      service.getRate(otherStoreId, created.id),
    ).rejects.toMatchObject({ errorCode: 'TAXRATE_NOT_FOUND' } satisfies Partial<AppException>);
  });
});
