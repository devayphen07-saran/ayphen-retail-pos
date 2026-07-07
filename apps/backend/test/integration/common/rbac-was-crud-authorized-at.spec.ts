import { Test } from '@nestjs/testing';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { RbacRepository } from '../../../src/common/rbac/rbac.repository';
import {
  accounts,
  users,
  stores,
  roles,
  rolePermissions,
  userRoleMappings,
} from '../../../src/db/schema';

/**
 * Regression coverage for a store-isolation gap in `wasCrudAuthorizedAt`
 * (offline-mutation-replay authorization): unlike `RbacService.resolveFromDb`
 * (the live-permission path), this query did not filter grants to roles
 * scoped to the TARGET store — a system-wide role's mapping
 * (`userRoleMappings.storeFk IS NULL`) satisfied the old `OR isNull(...)`
 * clause for ANY storeId, so a `rolePermissions` grant ever attached to a
 * system-wide role (USER, SUPER_ADMIN) would authorize an offline-replayed
 * mutation in a store it was never meant to reach.
 */
describe('RbacRepository.wasCrudAuthorizedAt — store isolation', () => {
  let db: Database;
  let repo: RbacRepository;

  let targetStoreId: string;
  let otherStoreId: string;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [RbacRepository],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    repo = moduleRef.get(RbacRepository);
  });

  beforeEach(async () => {
    await db.delete(userRoleMappings);
    await db.delete(rolePermissions);
    await db.delete(roles);
    await db.delete(stores);
    await db.delete(users);
    await db.delete(accounts);

    const [user] = await db
      .insert(users)
      .values({ name: 'Staffer', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userId = user!.id;

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Acct' })
      .returning();

    const [target, other] = await db
      .insert(stores)
      .values([
        { accountFk: account!.id, name: 'Target Store' },
        { accountFk: account!.id, name: 'Other Store' },
      ])
      .returning();
    targetStoreId = target!.id;
    otherStoreId = other!.id;
  });

  it('authorizes a store-scoped role\'s own grant in its own store', async () => {
    const [role] = await db
      .insert(roles)
      .values({ storeFk: targetStoreId, code: 'CASHIER', name: 'Cashier', isEditable: true })
      .returning();
    await db.insert(rolePermissions).values({ roleFk: role!.id, entityCode: 'Product', action: 'delete' });
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: role!.id, storeFk: targetStoreId });

    const ok = await repo.wasCrudAuthorizedAt({
      userId,
      storeId: targetStoreId,
      entity: 'Product',
      action: 'delete',
      asOf: new Date(),
    });
    expect(ok).toBe(true);
  });

  it('does not authorize a store-scoped role\'s grant against a DIFFERENT store', async () => {
    const [role] = await db
      .insert(roles)
      .values({ storeFk: targetStoreId, code: 'CASHIER', name: 'Cashier', isEditable: true })
      .returning();
    await db.insert(rolePermissions).values({ roleFk: role!.id, entityCode: 'Product', action: 'delete' });
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: role!.id, storeFk: targetStoreId });

    const ok = await repo.wasCrudAuthorizedAt({
      userId,
      storeId: otherStoreId,
      entity: 'Product',
      action: 'delete',
      asOf: new Date(),
    });
    expect(ok).toBe(false);
  });

  it('does not let a system-wide role\'s grant authorize a mutation in ANY store', async () => {
    // Simulates the latent bug scenario: a system-wide role (storeFk NULL)
    // that somehow carries a rolePermissions grant. Should never happen via
    // the normal seeding/role-creation paths, but the query must not trust
    // that invariant implicitly.
    const [systemRole] = await db
      .insert(roles)
      .values({ storeFk: null, code: 'USER', name: 'User', isEditable: false })
      .returning();
    await db.insert(rolePermissions).values({ roleFk: systemRole!.id, entityCode: 'Product', action: 'delete' });
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: systemRole!.id, storeFk: null });

    const ok = await repo.wasCrudAuthorizedAt({
      userId,
      storeId: targetStoreId,
      entity: 'Product',
      action: 'delete',
      asOf: new Date(),
    });
    expect(ok).toBe(false);
  });

  it('does not authorize once the grant has been revoked before asOf', async () => {
    const [role] = await db
      .insert(roles)
      .values({ storeFk: targetStoreId, code: 'CASHIER', name: 'Cashier', isEditable: true })
      .returning();
    const asOf = new Date();
    await db.insert(rolePermissions).values({
      roleFk: role!.id,
      entityCode: 'Product',
      action: 'delete',
      grantedAt: new Date(asOf.getTime() - 60_000),
      revokedAt: new Date(asOf.getTime() - 30_000),
    });
    await db.insert(userRoleMappings).values({ userFk: userId, roleFk: role!.id, storeFk: targetStoreId });

    const ok = await repo.wasCrudAuthorizedAt({
      userId,
      storeId: targetStoreId,
      entity: 'Product',
      action: 'delete',
      asOf,
    });
    expect(ok).toBe(false);
  });
});
