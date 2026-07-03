import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { LookupRepository } from '../../../src/lookup/lookup.repository';
import { LookupTypeRepository } from '../../../src/lookup/lookup-type.repository';
import { LookupService } from '../../../src/lookup/lookup.service';
import { accounts, stores, lookup, lookupType } from '../../../src/db/schema';

/**
 * Lookup engine business rules (lookup-entity-prd.md §9). Exercises the
 * service layer against the real Postgres container, including the DB-level
 * unique constraints (uk_lookup_type_code, uk_lookup_type_id) that back D2/D3.
 */
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

describe('LookupService', () => {
  let db: Database;
  let service: LookupService;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [LookupService, LookupRepository, LookupTypeRepository],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    service = moduleRef.get(LookupService);
  });

  beforeEach(async () => {
    await db.delete(lookup);
    await db.delete(lookupType);
    await db.delete(stores);
    await db.delete(accounts);

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Test Account' })
      .returning();
    const [storeA] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Store A' })
      .returning();
    const [storeB] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Store B' })
      .returning();
    storeAId = storeA!.id;
    storeBId = storeB!.id;
  });

  // ── Types ──────────────────────────────────────────────────────────────────

  it('createType rejects a duplicate type code (409 LOOKUP_CODE_EXISTS)', async () => {
    await service.createType({ code: 'PAYMENT_TERMS', title: 'Payment Terms' });
    await expect(
      service.createType({ code: 'PAYMENT_TERMS', title: 'Payment Terms (again)' }),
    ).rejects.toMatchObject({ message: 'LOOKUP_CODE_EXISTS' });
  });

  // ── Values — BR-3 (dropdown scoping) ────────────────────────────────────────

  it('listValues returns global + this store\'s values, not another store\'s', async () => {
    await service.createType({ code: 'REASONS', title: 'Reasons' });
    await service.addValue('REASONS', storeAId, USER_A, { code: 'DAMAGED', label: 'Damaged' });
    await service.addValue('REASONS', storeBId, USER_B, { code: 'EXPIRED', label: 'Expired' });

    const storeAValues = await service.listValues('REASONS', storeAId);
    expect(storeAValues.map((v) => v.code)).toEqual(['DAMAGED']);

    const storeBValues = await service.listValues('REASONS', storeBId);
    expect(storeBValues.map((v) => v.code)).toEqual(['EXPIRED']);
  });

  it('listValues excludes hidden and inactive values', async () => {
    await service.createType({ code: 'CHARGES', title: 'Charges' });
    const value = await service.addValue('CHARGES', storeAId, USER_A, {
      code: 'PACKING',
      label: 'Packing',
    });

    await service.updateValue(value.guuid, storeAId, USER_A, { is_hidden: true });
    expect(await service.listValues('CHARGES', storeAId)).toEqual([]);
  });

  // ── D3 — per-type unique code, not global ───────────────────────────────────

  it('the same code can exist under two different types (D3 — per-type unique, not global)', async () => {
    await service.createType({ code: 'PAYMENT_TERMS', title: 'Payment Terms' });
    await service.createType({ code: 'CHARGES', title: 'Charges' });

    await expect(
      service.addValue('PAYMENT_TERMS', storeAId, USER_A, { code: 'CASH', label: 'Cash' }),
    ).resolves.toMatchObject({ code: 'CASH' });
    await expect(
      service.addValue('CHARGES', storeAId, USER_A, { code: 'CASH', label: 'Cash Handling' }),
    ).resolves.toMatchObject({ code: 'CASH' });
  });

  // ── BR-4 — duplicate code within a type ─────────────────────────────────────

  it('addValue rejects a duplicate code within the same type (409 LOOKUP_CODE_EXISTS)', async () => {
    await service.createType({ code: 'REASONS', title: 'Reasons' });
    await service.addValue('REASONS', storeAId, USER_A, { code: 'DAMAGED', label: 'Damaged' });

    await expect(
      service.addValue('REASONS', storeAId, USER_A, { code: 'DAMAGED', label: 'Damaged (dup)' }),
    ).rejects.toMatchObject({ message: 'LOOKUP_CODE_EXISTS' });
  });

  it('addValue against an unknown type throws 404 LOOKUP_TYPE_NOT_FOUND', async () => {
    await expect(
      service.addValue('NOPE', storeAId, USER_A, { code: 'X', label: 'X' }),
    ).rejects.toMatchObject({ message: 'LOOKUP_TYPE_NOT_FOUND' });
  });

  // ── BR-1 — is_system values are protected ───────────────────────────────────

  it('rejects editing/deleting an is_system value (403 LOOKUP_VALUE_PROTECTED)', async () => {
    await service.createType({ code: 'TITLE', title: 'Salutation' });
    const type = await db.select().from(lookupType).limit(1);
    const [systemValue] = await db
      .insert(lookup)
      .values({
        lookupTypeFk: type[0]!.id,
        storeFk: storeAId,
        code: 'MR',
        label: 'Mr.',
        isSystem: true,
      })
      .returning();

    await expect(
      service.updateValue(systemValue!.guuid, storeAId, USER_A, { label: 'Mister' }),
    ).rejects.toMatchObject({ message: 'LOOKUP_VALUE_PROTECTED' });

    await expect(
      service.softDeleteValue(systemValue!.guuid, storeAId),
    ).rejects.toMatchObject({ message: 'LOOKUP_VALUE_PROTECTED' });
  });

  // ── Tenant isolation — a value from another store is invisible, not just forbidden ──

  it('rejects editing a value belonging to a different store (404, not 403 — no cross-tenant leak)', async () => {
    await service.createType({ code: 'REASONS', title: 'Reasons' });
    const value = await service.addValue('REASONS', storeAId, USER_A, {
      code: 'DAMAGED',
      label: 'Damaged',
    });

    await expect(
      service.updateValue(value.guuid, storeBId, USER_B, { label: 'Hacked' }),
    ).rejects.toMatchObject({ message: 'LOOKUP_VALUE_NOT_FOUND' });
  });

  // ── BR-6 — soft delete ───────────────────────────────────────────────────────

  it('softDeleteValue sets is_active=false rather than removing the row', async () => {
    await service.createType({ code: 'REASONS', title: 'Reasons' });
    const value = await service.addValue('REASONS', storeAId, USER_A, {
      code: 'DAMAGED',
      label: 'Damaged',
    });

    await service.softDeleteValue(value.guuid, storeAId);

    // Row still exists (soft-delete), just excluded from listValues.
    const [row] = await db.select().from(lookup).where(eq(lookup.guuid, value.guuid));
    expect(row).toBeDefined();
    expect(row?.isActive).toBe(false);
    expect(await service.listValues('REASONS', storeAId)).toEqual([]);
  });
});