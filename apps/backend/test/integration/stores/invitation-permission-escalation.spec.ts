import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { REDIS } from '../../../src/common/redis/redis.provider';
import { SharedRepositoriesModule } from '../../../src/common/shared-repositories.module';
import { RbacRepository } from '../../../src/common/rbac/rbac.repository';
import { RbacService } from '../../../src/common/rbac/rbac.service';
import { AuditService } from '../../../src/common/audit/audit.service';
import { RoleRepository } from '../../../src/stores/role/role.repository';
import { InvitationService } from '../../../src/stores/invitation/invitation.service';
import { SnapshotService } from '../../../src/auth/mobile/services/snapshot.service';
import { RateLimitService } from '../../../src/auth/core/rate-limit.service';
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
  invitations,
} from '../../../src/db/schema';

/**
 * Regression coverage for the invitation-path privilege-escalation gap
 * (API-review §8). `RoleService.assignRole`/`updatePermissions` guard against
 * granting a role broader than the actor's own permissions, but an invitation
 * assigns exactly that role on accept — so `InvitationService.create` must run
 * the same `GRANT_EXCEEDS_ACTOR_PERMISSIONS` ceiling check, or `Invitation.create`
 * becomes a side door around it (a staffer invites an accomplice into a
 * high-privilege role they don't themselves hold).
 *
 * `create` never touches SnapshotService/RateLimitService (those are on the
 * accept path), so they're stubbed here to keep the module light.
 */
describe('InvitationService — privilege-escalation guard', () => {
  let db: Database;
  let redis: Redis;
  let service: InvitationService;
  let rbac: RbacService;

  let storeId: string;
  let ownerUserId: string;
  let ownerRoleId: string;
  let staffUserId: string;
  let targetRoleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule, SharedRepositoriesModule],
      providers: [
        RoleRepository,
        InvitationService,
        RbacRepository,
        RbacService,
        AuditService,
        { provide: REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
        // Unused by create() — the escalation guard and the whole create path
        // never reach these; stubbed so DI doesn't pull their dependency graph.
        { provide: SnapshotService, useValue: {} },
        { provide: RateLimitService, useValue: {} },
      ],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    redis = moduleRef.get(REDIS);
    service = moduleRef.get(InvitationService);
    rbac = moduleRef.get(RbacService);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.delete(invitations);
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
    await rbac.seedStoreOwnerPermissions(ownerRoleId, ownerUserId, db);
    await db.insert(userRoleMappings).values({ userFk: ownerUserId, roleFk: ownerRoleId, storeFk: storeId });

    // The staffer holds only the "manage team" bundle — enough to create
    // invitations, but nothing that would let them hand out Product.delete.
    const [limitedRole] = await db
      .insert(roles)
      .values({ storeFk: storeId, code: 'TEAM_MANAGER', name: 'Team Manager', isEditable: true })
      .returning();
    await db.insert(rolePermissions).values([
      { roleFk: limitedRole!.id, entityCode: 'Invitation', action: 'create' },
      { roleFk: limitedRole!.id, entityCode: 'UserRoleMapping', action: 'create' },
    ]);
    await db.insert(userRoleMappings).values({ userFk: staffUserId, roleFk: limitedRole!.id, storeFk: storeId });

    // The role the staffer will try to invite an accomplice into.
    const [targetRole] = await db
      .insert(roles)
      .values({ storeFk: storeId, code: 'MANAGER', name: 'Manager', isEditable: true })
      .returning();
    targetRoleId = targetRole!.id;
  });

  it('blocks inviting to a role that grants permissions the actor does not hold', async () => {
    await db.insert(rolePermissions).values([
      { roleFk: targetRoleId, entityCode: 'Product', action: 'delete' },
    ]);

    await expect(
      service.create(storeId, staffUserId, {
        roleId: targetRoleId,
        phone: '+15550000001',
      }),
    ).rejects.toMatchObject({
      errorCode: 'GRANT_EXCEEDS_ACTOR_PERMISSIONS',
    } satisfies Partial<AppException>);

    // The guard runs before any side effect — no invitation row is written.
    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.roleFk, targetRoleId));
    expect(rows).toHaveLength(0);
  });

  it('allows inviting to a role whose grants the actor already holds', async () => {
    await db.insert(rolePermissions).values([
      { roleFk: targetRoleId, entityCode: 'UserRoleMapping', action: 'create' },
    ]);

    const result = await service.create(storeId, staffUserId, {
      roleId: targetRoleId,
      phone: '+15550000002',
    });
    expect(result.token).toBeTruthy();
  });

  it('allows the store owner (full CRUD) to invite to any role', async () => {
    await db.insert(rolePermissions).values([
      { roleFk: targetRoleId, entityCode: 'Product', action: 'delete' },
      { roleFk: targetRoleId, entityCode: 'Payment', action: 'view' },
    ]);

    const result = await service.create(storeId, ownerUserId, {
      roleId: targetRoleId,
      phone: '+15550000003',
    });
    expect(result.token).toBeTruthy();
  });
});