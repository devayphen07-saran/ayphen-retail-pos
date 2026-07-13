import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork } from '#db/db.module.js';
import { rethrowUniqueViolationAs } from '#db/rethrow-unique-violation.js';
import { RoleRepository } from './role.repository.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';
import { SYSTEM_ROLE_CODES } from '#common/rbac/permission-matrix.constants.js';
import { assertGrantsWithinActorScope } from '#common/rbac/effective-permissions.js';

/**
 * Role assignment use-cases (rbac.md §21) — assigning/revoking a store member to
 * a custom role. Split from RoleService (which owns role CRUD + permission
 * editing) per the service-decomposition rule (layered-architecture §3.5): the
 * two families share no state, so keeping them apart keeps each focused and
 * under the size/method ceiling. System roles are never assignable/revocable
 * here, and the escalation guard forbids assigning a role broader than the
 * actor's own grants.
 */
@Injectable()
export class RoleAssignmentService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: RoleRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly snapshot: SnapshotService,
  ) {}

  /** Assign an existing account member to a custom role in this store (§21). */
  async assignRole(
    storeId: string,
    actorId: string,
    roleId: string,
    targetUserId: string,
  ): Promise<void> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role)
      throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (SYSTEM_ROLE_CODES.has(role.code)) {
      throw new ForbiddenError(
        ErrorCodes.ROLE_NOT_ASSIGNABLE,
        'This role cannot be assigned',
      );
    }
    if (!(await this.repo.isAccountMember(targetUserId, storeId))) {
      throw new ForbiddenError(
        ErrorCodes.USER_NOT_STORE_MEMBER,
        'The target user is not a member of this store',
      );
    }
    // Same TOCTOU shape as createRole — assignmentExists is a pre-check,
    // user_role_mappings_uq (schema.ts) is the real guard.
    if (await this.repo.assignmentExists(targetUserId, roleId, storeId)) {
      throw new ConflictError(
        ErrorCodes.ASSIGNMENT_ALREADY_EXISTS,
        'This user is already assigned to this role',
      );
    }

    // Escalation guard — Role.edit + UserRoleMapping.create must not be enough
    // to mint a role broader than the actor's own grants and self-assign it.
    const roleGrants = await this.repo.listGrants(roleId);
    await assertGrantsWithinActorScope(
      this.rbac,
      actorId,
      storeId,
      roleGrants,
      (g) => g.entityCode,
      'You cannot assign a role that grants permissions you do not hold yourself',
    );

    await rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        await this.repo.insertAssignment(
          {
            userFk: targetUserId,
            roleFk: roleId,
            storeFk: storeId,
            assignedBy: actorId,
          },
          tx,
        );
        await this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
        await this.audit.logInTransaction(
          {
            event: 'ROLE_ASSIGNMENT_CREATED',
            activityType: 'ROLE_ASSIGNMENT_CREATED',
            prefix: 'Role',
            suffix: `assigned "${role.name}"`,
            userId: actorId,
            actorId,
            storeFk: storeId,
            isSuccess: true,
            entityType: 'UserRoleMapping',
            metadata: { targetUserId, roleId },
          },
          tx,
        );
      }),
      () =>
        new ConflictError(
          ErrorCodes.ASSIGNMENT_ALREADY_EXISTS,
          'This user is already assigned to this role',
        ),
      'user_role_mappings_uq',
    );
    await this.rbac.invalidateUserStoreCache(targetUserId, storeId);
    // The target's cached, client-signed permission snapshot is now stale too
    // — without this, a newly-granted role wouldn't show up client-side (esp.
    // offline) until the snapshot's own TTL lapses.
    await this.snapshot.invalidate(targetUserId);
  }

  /** Revoke a user's role assignment in this store (§21). */
  async revokeRole(
    storeId: string,
    actorId: string,
    roleId: string,
    targetUserId: string,
  ): Promise<void> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role)
      throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (SYSTEM_ROLE_CODES.has(role.code)) {
      throw new ForbiddenError(
        ErrorCodes.ROLE_NOT_REVOCABLE,
        'This role assignment cannot be revoked',
      );
    }

    const revoked = await this.uow.execute(async (tx) => {
      const ok = await this.repo.revokeAssignment(
        targetUserId,
        roleId,
        storeId,
        tx,
      );
      if (ok) {
        await this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
        await this.audit.logInTransaction(
          {
            event: 'ROLE_ASSIGNMENT_REVOKED',
            activityType: 'ROLE_ASSIGNMENT_REVOKED',
            prefix: 'Role',
            suffix: `revoked`,
            userId: actorId,
            actorId,
            storeFk: storeId,
            isSuccess: true,
            entityType: 'UserRoleMapping',
            metadata: { targetUserId, roleId },
          },
          tx,
        );
      }
      return ok;
    });
    if (!revoked)
      throw new NotFoundError(
        ErrorCodes.ASSIGNMENT_NOT_FOUND,
        'Role assignment not found',
      );

    await this.rbac.invalidateUserStoreCache(targetUserId, storeId);
    // Same staleness gap as assignRole — a revoked role must not keep
    // granting access via a client-trusted cached snapshot.
    await this.snapshot.invalidate(targetUserId);
  }
}
