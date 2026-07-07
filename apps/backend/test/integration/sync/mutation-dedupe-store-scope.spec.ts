import { Test } from '@nestjs/testing';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { SyncIdempotencyRepository } from '../../../src/sync/repositories/sync-idempotency.repository';
import { SyncMutationFailureRepository } from '../../../src/sync/repositories/sync-mutation-failure.repository';
import { SyncConflictRepository } from '../../../src/sync/repositories/sync-conflict.repository';
import {
  accounts,
  users,
  stores,
  syncMutationIdempotency,
  syncMutationFailures,
  syncConflicts,
} from '../../../src/db/schema';

/**
 * Regression coverage for the sync dedupe/poison/conflict store-scoping fix
 * (backend-standard review, sync §10/§11): the compound key on all three
 * tables used to be (mutation_id, user_fk) — a user with roles at two stores
 * reusing a mutation_id across stores would silently short-circuit a real
 * write at the second store as "duplicate". storeFk is now part of the key.
 */
describe('Sync dedupe/poison/conflict repositories — store scoping', () => {
  let db: Database;
  let idempotency: SyncIdempotencyRepository;
  let failures: SyncMutationFailureRepository;
  let conflicts: SyncConflictRepository;

  let userId: string;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [SyncIdempotencyRepository, SyncMutationFailureRepository, SyncConflictRepository],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    idempotency = moduleRef.get(SyncIdempotencyRepository);
    failures = moduleRef.get(SyncMutationFailureRepository);
    conflicts = moduleRef.get(SyncConflictRepository);
  });

  beforeEach(async () => {
    await db.delete(syncConflicts);
    await db.delete(syncMutationFailures);
    await db.delete(syncMutationIdempotency);
    await db.delete(stores);
    await db.delete(users);
    await db.delete(accounts);

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Acct' })
      .returning();

    const [user] = await db
      .insert(users)
      .values({ name: 'Multi-store owner', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userId = user!.id;

    const inserted = await db
      .insert(stores)
      .values([
        { accountFk: account!.id, name: 'Store A' },
        { accountFk: account!.id, name: 'Store B' },
      ])
      .returning();
    storeAId = inserted.find((s) => s.name === 'Store A')!.id;
    storeBId = inserted.find((s) => s.name === 'Store B')!.id;
  });

  it('idempotency: the same mutation_id claimed at two stores does not collide', async () => {
    const mutationId = `mut-${Date.now()}`;

    await db.insert(syncMutationIdempotency).values({
      mutationId,
      userFk: userId,
      storeFk: storeAId,
      entityType: 'product',
      action: 'create',
      status: 'applied',
      result: { ok: true, store: 'A' },
    });
    await db.insert(syncMutationIdempotency).values({
      mutationId,
      userFk: userId,
      storeFk: storeBId,
      entityType: 'product',
      action: 'create',
      status: 'applied',
      result: { ok: true, store: 'B' },
    });

    const atA = await idempotency.find(mutationId, userId, storeAId);
    const atB = await idempotency.find(mutationId, userId, storeBId);
    expect((atA!.result as { store: string }).store).toBe('A');
    expect((atB!.result as { store: string }).store).toBe('B');
  });

  it('idempotency: remove at one store leaves the other store untouched', async () => {
    const mutationId = `mut-${Date.now()}`;
    await db.insert(syncMutationIdempotency).values([
      {
        mutationId, userFk: userId, storeFk: storeAId,
        entityType: 'product', action: 'create', status: 'applied', result: {},
      },
      {
        mutationId, userFk: userId, storeFk: storeBId,
        entityType: 'product', action: 'create', status: 'applied', result: {},
      },
    ]);

    await idempotency.remove(mutationId, userId, storeAId);

    expect(await idempotency.find(mutationId, userId, storeAId)).toBeNull();
    expect(await idempotency.find(mutationId, userId, storeBId)).not.toBeNull();
  });

  it('poison failures: bump at one store does not inflate the other store\'s count', async () => {
    const mutationId = `mut-${Date.now()}`;

    await failures.bump(mutationId, userId, storeAId, 'boom A');
    await failures.bump(mutationId, userId, storeAId, 'boom A again');
    await failures.bump(mutationId, userId, storeBId, 'boom B');

    expect(await failures.count(mutationId, userId, storeAId)).toBe(2);
    expect(await failures.count(mutationId, userId, storeBId)).toBe(1);
  });

  it('conflicts: recording at one store does not overwrite the other store\'s row', async () => {
    const mutationId = `mut-${Date.now()}`;

    await conflicts.record({
      mutationId, userFk: userId, storeFk: storeAId,
      entityType: 'product', conflictType: 'MASTER_DATA', clientPayload: { a: 1 },
    });
    await conflicts.record({
      mutationId, userFk: userId, storeFk: storeBId,
      entityType: 'product', conflictType: 'VALIDATION', clientPayload: { b: 1 },
    });

    const [atA] = await conflicts.list(storeAId, {});
    const [atB] = await conflicts.list(storeBId, {});
    expect(atA!.conflictType).toBe('MASTER_DATA');
    expect(atB!.conflictType).toBe('VALIDATION');
  });
});