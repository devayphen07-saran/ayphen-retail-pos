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
 * Regression coverage for the mobile permission-snapshot cross-store leak
 * (RBAC audit finding #4): `globalPermissions` used to flatten a user's CRUD
 * grants across every store they belong to, so a permission held in Store A
 * (e.g. Owner) leaked into the mobile UI's gating while Store B (e.g.
 * cashier) was active. `buildStoreAccessBlock` now scopes grants per store,
 * the same way it already scoped locations.
 */
describe('SnapshotService — per-store permission scoping', () => {
  let db: Database;
  let redis: Redis;
  let service: SnapshotService;

  let userId: string;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [
        SnapshotService,
        { provide: REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
        {
          provide: CryptoService,
          // compile() doesn't run lifecycle hooks — derive the signing key here.
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
      .values({ name: 'Multi-store user', phone: `+1${Math.floor(Math.random() * 1e9)}` })
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

    const [storeA] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Store A' })
      .returning();
    storeAId = storeA!.id;

    const [storeB] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Store B' })
      .returning();
    storeBId = storeB!.id;

    // Store A: Owner — broad CRUD.
    const [ownerRole] = await db
      .insert(roles)
      .values({ storeFk: storeAId, code: 'STORE_OWNER', name: 'Owner', isEditable: false })
      .returning();
    await db.insert(rolePermissions).values([
      { roleFk: ownerRole!.id, entityCode: 'Role', action: 'create' },
      { roleFk: ownerRole!.id, entityCode: 'Product', action: 'delete' },
    ]);
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: ownerRole!.id, storeFk: storeAId });

    // Store B: Cashier — one narrow grant only.
    const [cashierRole] = await db
      .insert(roles)
      .values({ storeFk: storeBId, code: 'CASHIER', name: 'Cashier', isEditable: true })
      .returning();
    await db.insert(rolePermissions).values([
      { roleFk: cashierRole!.id, entityCode: 'Product', action: 'view' },
    ]);
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: cashierRole!.id, storeFk: storeBId });
  });

  it("does not leak Store A's grants into Store B's entry", async () => {
    const { snapshot } = await service.getOrBuild(userId);

    const storeAEntry = snapshot.storeLocations.find((s) => s.store_id === storeAId);
    const storeBEntry = snapshot.storeLocations.find((s) => s.store_id === storeBId);

    expect(storeAEntry?.permissions).toEqual(
      expect.arrayContaining(['Role:create', 'Product:delete']),
    );
    expect(storeBEntry?.permissions).toEqual(['Product:view']);

    // The core regression: Store A's Owner-only grants must be absent from
    // Store B, and Store B's narrow grant must be absent from Store A.
    expect(storeBEntry?.permissions).not.toContain('Role:create');
    expect(storeBEntry?.permissions).not.toContain('Product:delete');
    expect(storeAEntry?.permissions).not.toContain('Product:view');
  });

  it('never emits a top-level flattened permissions field', async () => {
    const { snapshot } = await service.getOrBuild(userId);
    expect(snapshot).not.toHaveProperty('globalPermissions');
  });
});
