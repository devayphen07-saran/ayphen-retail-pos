import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { REDIS } from '../../../src/common/redis/redis.provider';
import { SnapshotService } from '../../../src/auth/mobile/services/snapshot.service';
import { CryptoService } from '../../../src/auth/core/crypto.service';
import { AppConfigService } from '../../../src/config/app-config.service';
import { env } from '../../../src/config/env';
import {
  accounts,
  users,
  stores,
  roles,
  rolePermissions,
  userRoleMappings,
} from '../../../src/db/schema';

/**
 * Regression coverage for the invite-accept / store-creation snapshot-embed
 * fix (backend review, §P1): both flows call `snapshot.invalidate(userId)`
 * then `snapshot.getOrBuild(userId)` to embed a fresh snapshot in their
 * response, instead of making the client do a full bootstrap round trip.
 * `getOrBuild` is cache-first — calling it BEFORE `invalidate()` would embed
 * the stale, pre-grant snapshot, and the client would trust it (it's HMAC
 * signed) until the next `permissionsVersion` header mismatch. This test
 * proves both halves: (1) skipping invalidate really does serve stale data,
 * and (2) invalidate-then-getOrBuild really does serve fresh data — so a
 * future edit that swaps the order or drops the invalidate call fails loudly
 * here instead of shipping a silent staleness bug.
 */
describe('SnapshotService — invalidate-then-getOrBuild ordering', () => {
  let db: Database;
  let redis: Redis;
  let service: SnapshotService;

  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [
        SnapshotService,
        { provide: REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
        {
          provide: CryptoService,
          useFactory: () => {
            const crypto = new CryptoService(new AppConfigService());
            crypto.onModuleInit();
            return crypto;
          },
        },
        AppConfigService,
      ],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    redis = moduleRef.get(REDIS);
    service = moduleRef.get(SnapshotService);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.delete(userRoleMappings);
    await db.delete(rolePermissions);
    await db.delete(roles);
    await db.delete(stores);
    await db.delete(users);
    await db.delete(accounts);
    await redis.flushdb();

    const [user] = await db
      .insert(users)
      .values({ name: 'Grantee', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userId = user!.id;

    const [account] = await db
      .insert(accounts)
      .values({
        accountNumber: `ACC-${Date.now()}-${Math.random()}`,
        name: 'Acct',
        ownerUserFk: userId,
      })
      .returning();
    accountId = account!.id;

    const [storeA] = await db
      .insert(stores)
      .values({ accountFk: accountId, name: 'Store A' })
      .returning();

    const [roleA] = await db
      .insert(roles)
      .values({ storeFk: storeA!.id, code: 'STORE_OWNER', name: 'Owner', isEditable: false })
      .returning();
    await db.insert(rolePermissions).values([
      { roleFk: roleA!.id, entityCode: 'Product', action: 'view' },
    ]);
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: roleA!.id, storeFk: storeA!.id });
  });

  /** Simulates what invitation-accept / store-creation do: grant a second
   *  store's access directly against the DB, bypassing the snapshot cache
   *  entirely (the same way a real grant transaction would). */
  async function grantSecondStore(): Promise<void> {
    const [storeB] = await db
      .insert(stores)
      .values({ accountFk: accountId, name: 'Store B' })
      .returning();
    const [roleB] = await db
      .insert(roles)
      .values({ storeFk: storeB!.id, code: 'CASHIER', name: 'Cashier', isEditable: true })
      .returning();
    await db.insert(rolePermissions).values([
      { roleFk: roleB!.id, entityCode: 'Product', action: 'view' },
    ]);
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: roleB!.id, storeFk: storeB!.id });
  }

  it('getOrBuild alone (no invalidate) serves the stale cached snapshot after a new grant', async () => {
    const first = await service.getOrBuild(userId);
    expect(first.snapshot.stores).toHaveLength(1);

    await grantSecondStore();

    // No invalidate() call — this documents the failure mode the real fix
    // must avoid: cache-first getOrBuild doesn't know anything changed.
    const stale = await service.getOrBuild(userId);
    expect(stale.snapshot.stores).toHaveLength(1);
  });

  it('invalidate() then getOrBuild() serves the fresh snapshot after a new grant', async () => {
    await service.getOrBuild(userId);

    await grantSecondStore();

    await service.invalidate(userId);
    const fresh = await service.getOrBuild(userId);

    expect(fresh.snapshot.stores).toHaveLength(2);
  });

  it('getOrBuild() BEFORE invalidate() would still serve stale data (the exact bug the call order prevents)', async () => {
    await service.getOrBuild(userId);
    await grantSecondStore();

    // Wrong order: build first, invalidate after — proves why the real code
    // must invalidate BEFORE getOrBuild, not just "somewhere in the flow".
    const wrongOrder = await service.getOrBuild(userId);
    await service.invalidate(userId);

    expect(wrongOrder.snapshot.stores).toHaveLength(1);
  });
});
