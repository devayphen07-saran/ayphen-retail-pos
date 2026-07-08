import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { REDIS } from '../../../src/common/redis/redis.provider';
import { RbacRepository } from '../../../src/common/rbac/rbac.repository';
import { RbacService } from '../../../src/common/rbac/rbac.service';
import { AuditService } from '../../../src/common/audit/audit.service';
import { RoleRepository } from '../../../src/stores/role/role.repository';
import { RoleService } from '../../../src/stores/role/role.service';
import { AppException } from '../../../src/common/exceptions/app.exception';
import { env } from '../../../src/config/env';
import {
  accounts,
  accountUsers,
  users,
  stores,
  roles,
  rolePermissions,
  userRoleMappings,
} from '../../../src/db/schema';

/**
 * Regression coverage for three role-subsystem privilege-escalation gaps
 * (backend-standard review, §4/§7): `revokeRole` had no system-role guard
 * (a staffer could strip the store owner's own STORE_OWNER assignment),
 * `updatePermissions` had no ceiling check (a staffer could grant a role more
 * CRUD than they themselves hold, then self-assign it), and `assignRole` had
 * the same missing ceiling check on the assignment path itself (a staffer
 * could self-assign a pre-existing role broader than their own grants
 * without ever touching updatePermissions).
 */
describe('RoleService — privilege-escalation guards', () => {
  let db: Database;
  let redis: Redis;
  let service: RoleService;
  let rbac: RbacService;

  let storeId: string;
  let ownerUserId: string;
  let ownerRoleId: string;
  let staffUserId: string;
  let limitedRoleId: string;
  let targetRoleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [
        RoleRepository,
        RoleService,
        RbacRepository,
        RbacService,
        AuditService,
        { provide: REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
      ],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    redis = moduleRef.get(REDIS);
    service = moduleRef.get(RoleService);
    rbac = moduleRef.get(RbacService);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.delete(userRoleMappings);
    await db.delete(rolePermissions);
    await db.delete(roles);
    await db.delete(stores);
    await db.delete(accountUsers);
    await db.delete(users);
    await db.delete(accounts);
    await redis.flushdb();

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

    const [staff] = await db
      .insert(users)
      .values({ name: 'Staffer', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    staffUserId = staff!.id;

    await db.insert(accountUsers).values([
      { accountFk: account!.id, userFk: ownerUserId },
      { accountFk: account!.id, userFk: staffUserId },
    ]);

    const [store] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Main Store' })
      .returning();
    storeId = store!.id;

    const [ownerRole] = await db
      .insert(roles)
      .values({ storeFk: storeId, code: 'STORE_OWNER', name: 'Owner', isEditable: false })
      .returning();
    ownerRoleId = ownerRole!.id;
    // Mirrors the real store-create flow — STORE_OWNER holds no grants by
    // magic, they're seeded as literal rolePermissions rows (rbac.service.ts
    // resolveFromDb has no owner-code bypass; the "owner sees everything"
    // guarantee depends entirely on this seed actually having run).
    await rbac.seedStoreOwnerPermissions(ownerRoleId, ownerUserId, db);
    await db.insert(userRoleMappings).values({ userFk: ownerUserId, roleFk: ownerRoleId, storeFk: storeId });

    // A limited custom role for the staffer — only Role.edit + UserRoleMapping.create,
    // the exact "manage team" bundle the review flagged as sufficient to self-escalate.
    const [limitedRole] = await db
      .insert(roles)
      .values({ storeFk: storeId, code: 'TEAM_MANAGER', name: 'Team Manager', isEditable: true })
      .returning();
    limitedRoleId = limitedRole!.id;
    await db.insert(rolePermissions).values([
      { roleFk: limitedRoleId, entityCode: 'Role', action: 'edit' },
      { roleFk: limitedRoleId, entityCode: 'UserRoleMapping', action: 'create' },
      { roleFk: limitedRoleId, entityCode: 'UserRoleMapping', action: 'delete' },
    ]);
    await db.insert(userRoleMappings).values({ userFk: staffUserId, roleFk: limitedRoleId, storeFk: storeId });

    // A second editable role the staffer will try to escalate via updatePermissions.
    const [targetRole] = await db
      .insert(roles)
      .values({ storeFk: storeId, code: 'CASHIER', name: 'Cashier', isEditable: true })
      .returning();
    targetRoleId = targetRole!.id;
  });

  it('blocks revoking the store owner\'s own STORE_OWNER assignment', async () => {
    await expect(
      service.revokeRole(storeId, staffUserId, ownerRoleId, ownerUserId),
    ).rejects.toMatchObject({ errorCode: 'ROLE_NOT_REVOCABLE' } satisfies Partial<AppException>);

    const [row] = await db
      .select()
      .from(userRoleMappings)
      .where(eq(userRoleMappings.userFk, ownerUserId));
    expect(row?.revokedAt).toBeNull();
  });

  it('still allows revoking a normal custom-role assignment', async () => {
    await db.insert(userRoleMappings).values({
      userFk: staffUserId,
      roleFk: targetRoleId,
      storeFk: storeId,
    });

    await expect(
      service.revokeRole(storeId, ownerUserId, targetRoleId, staffUserId),
    ).resolves.toBeUndefined();
  });

  it('blocks granting a permission the actor does not hold themselves', async () => {
    await expect(
      service.updatePermissions(storeId, staffUserId, targetRoleId, [
        { entity: 'Product', action: 'delete' },
      ]),
    ).rejects.toMatchObject({ errorCode: 'GRANT_EXCEEDS_ACTOR_PERMISSIONS' } satisfies Partial<AppException>);
  });

  it('allows granting a permission the actor already holds', async () => {
    await expect(
      service.updatePermissions(storeId, staffUserId, targetRoleId, [
        { entity: 'UserRoleMapping', action: 'create' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('allows the store owner (full CRUD) to grant anything', async () => {
    await expect(
      service.updatePermissions(storeId, ownerUserId, targetRoleId, [
        { entity: 'Product', action: 'delete' },
        { entity: 'Payment', action: 'view' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('blocks assigning a role that grants permissions the actor does not hold', async () => {
    await db.insert(rolePermissions).values([
      { roleFk: targetRoleId, entityCode: 'Product', action: 'delete' },
    ]);

    await expect(
      service.assignRole(storeId, staffUserId, targetRoleId, staffUserId),
    ).rejects.toMatchObject({ errorCode: 'GRANT_EXCEEDS_ACTOR_PERMISSIONS' } satisfies Partial<AppException>);

    const [row] = await db
      .select()
      .from(userRoleMappings)
      .where(eq(userRoleMappings.roleFk, targetRoleId));
    expect(row).toBeUndefined();
  });

  it('allows assigning a role whose grants the actor already holds', async () => {
    await db.insert(rolePermissions).values([
      { roleFk: targetRoleId, entityCode: 'UserRoleMapping', action: 'create' },
    ]);

    await expect(
      service.assignRole(storeId, staffUserId, targetRoleId, staffUserId),
    ).resolves.toBeUndefined();
  });

  it('allows the store owner (full CRUD) to assign any role', async () => {
    await db.insert(rolePermissions).values([
      { roleFk: targetRoleId, entityCode: 'Product', action: 'delete' },
      { roleFk: targetRoleId, entityCode: 'Payment', action: 'view' },
    ]);

    await expect(
      service.assignRole(storeId, ownerUserId, targetRoleId, staffUserId),
    ).resolves.toBeUndefined();
  });
});