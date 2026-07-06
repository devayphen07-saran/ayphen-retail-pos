import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork } from '#db/db.module.js';
import { rethrowUniqueViolationAs } from '#db/rethrow-unique-violation.js';
import { RoleRepository, type RoleRow, type RoleGrant } from './role.repository.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#auth/core/audit.service.js';
import {
  isEntityCode,
  type CrudAction,
} from '#common/rbac/permission-matrix.constants.js';

const SYSTEM_ROLE_CODES = new Set(['USER', 'STORE_OWNER', 'SUPER_ADMIN']);

export interface PermissionGrantInput {
  entity: string;
  action: CrudAction;
}

/**
 * Role lifecycle service (rbac.md §21). Creating/assigning/revoking/deleting
 * custom roles and editing their permissions, delegating cache invalidation +
 * version bumps to RbacService. All mutations are store-scoped; system roles are
 * never editable/assignable here.
 */
@Injectable()
export class RoleService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: RoleRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  async listRoles(storeId: string): Promise<RoleRow[]> {
    return this.repo.listStoreRoles(storeId);
  }

  /** A role plus its current permission matrix (view target for the edit screen). */
  async getRole(storeId: string, roleId: string): Promise<{ role: RoleRow; grants: RoleGrant[] }> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role) throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    const grants = await this.repo.listGrants(roleId);
    return { role, grants };
  }

  /** Create a custom role, seeded with DEFAULT_ROLE_CRUD (§9, §21). */
  async createRole(
    storeId: string,
    actorId: string,
    name: string,
    description: string | null,
  ): Promise<{ id: string; name: string }> {
    // Pre-check is TOCTOU-able by itself — two concurrent creates for the
    // same name can both pass it before either commits. roles_store_name_uq
    // (schema.ts) is the real guard; normalize its violation to the same
    // ROLE_ALREADY_EXISTS shape so the client sees consistent text either way.
    if (await this.repo.nameTaken(storeId, name)) {
      throw new ConflictError(ErrorCodes.ROLE_ALREADY_EXISTS, 'A role with this name already exists');
    }
    const role = await rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        const r = await this.repo.createCustomRole(storeId, name, description, tx);
        await this.rbac.seedDefaultPermissions(r.id, actorId, tx);
        return r;
      }),
      () => new ConflictError(ErrorCodes.ROLE_ALREADY_EXISTS, 'A role with this name already exists'),
      'roles_store_name_uq',
    );
    await this.audit.log({
      event: 'ROLE_PERMISSION_CHANGED',
      activityType: 'ROLE_PERMISSION_CHANGED',
      prefix: 'Role',
      suffix: `"${name}" created`,
      userId: actorId,
      storeFk: storeId,
      isSuccess: true,
      entityType: 'Role',
      entityId: role.id,
    });
    return { id: role.id, name };
  }

  /** Replace a custom role's CRUD grants (§21). */
  async updatePermissions(
    storeId: string,
    actorId: string,
    roleId: string,
    grants: PermissionGrantInput[],
  ): Promise<void> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role) throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (!role.isEditable) throw new ForbiddenError(ErrorCodes.ROLE_NOT_EDITABLE, 'This role cannot be edited');

    // Reject unknown entity codes outright instead of silently dropping
    // them — a client that mistyped an entity code deserves a clear error,
    // not a request that "succeeds" while quietly granting fewer permissions
    // than asked for.
    const invalid = grants.filter((g) => !isEntityCode(g.entity));
    if (invalid.length > 0) {
      throw new UnprocessableError(
        ErrorCodes.INVALID_ENTITY_CODE,
        'One or more entity codes are not recognized',
        { entities: invalid.map((g) => g.entity) },
      );
    }

    const members = await this.uow.execute(async (tx) => {
      await this.repo.revokeAllCrud(roleId, tx);
      await this.repo.insertCrud(
        grants.map((g) => ({
          roleFk: roleId,
          entityCode: g.entity,
          action: g.action,
          grantedBy: actorId,
        })),
        tx,
      );
      // Bump every member's version so their cache/JWT re-resolve (H-6, §16).
      return this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
    });

    await this.rbac.invalidateRoleMembersCache(roleId, storeId);
    await this.audit.log({
      event: 'ROLE_PERMISSION_CHANGED',
      activityType: 'ROLE_PERMISSION_CHANGED',
      prefix: 'Role',
      suffix: `permissions updated (${members.length} members)`,
      userId: actorId,
      storeFk: storeId,
      isSuccess: true,
      entityType: 'Role',
      entityId: roleId,
    });
  }

  /** Delete a custom role (§21). Blocked for system roles or roles with members. */
  async deleteRole(storeId: string, actorId: string, roleId: string): Promise<void> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role) throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (!role.isEditable) throw new ForbiddenError(ErrorCodes.ROLE_NOT_EDITABLE, 'This role cannot be edited');
    if ((await this.repo.countActiveMembers(roleId)) > 0) {
      throw new ConflictError(ErrorCodes.ROLE_HAS_ACTIVE_ASSIGNMENTS, 'This role still has active assignments');
    }
    await this.repo.softDeleteRole(roleId);
    await this.audit.log({
      event: 'ROLE_PERMISSION_CHANGED',
      activityType: 'ROLE_PERMISSION_CHANGED',
      prefix: 'Role',
      suffix: `"${role.name}" deleted`,
      userId: actorId,
      storeFk: storeId,
      isSuccess: true,
      entityType: 'Role',
      entityId: roleId,
    });
  }

  /** Assign an existing account member to a custom role in this store (§21). */
  async assignRole(
    storeId: string,
    actorId: string,
    roleId: string,
    targetUserId: string,
  ): Promise<void> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role) throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (SYSTEM_ROLE_CODES.has(role.code)) {
      throw new ForbiddenError(ErrorCodes.ROLE_NOT_ASSIGNABLE, 'This role cannot be assigned');
    }
    if (!(await this.repo.isAccountMember(targetUserId, storeId))) {
      throw new ForbiddenError(ErrorCodes.USER_NOT_STORE_MEMBER, 'The target user is not a member of this store');
    }
    // Same TOCTOU shape as createRole above — assignmentExists is a
    // pre-check, user_role_mappings_uq (schema.ts) is the real guard.
    if (await this.repo.assignmentExists(targetUserId, roleId, storeId)) {
      throw new ConflictError(ErrorCodes.ASSIGNMENT_ALREADY_EXISTS, 'This user is already assigned to this role');
    }

    await rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        await this.repo.insertAssignment(
          { userFk: targetUserId, roleFk: roleId, storeFk: storeId, assignedBy: actorId },
          tx,
        );
        await this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
      }),
      () => new ConflictError(ErrorCodes.ASSIGNMENT_ALREADY_EXISTS, 'This user is already assigned to this role'),
      'user_role_mappings_uq',
    );
    await this.rbac.invalidateUserStoreCache(targetUserId, storeId);
    await this.audit.log({
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
    });
  }

  /** Revoke a user's role assignment in this store (§21). */
  async revokeRole(
    storeId: string,
    actorId: string,
    roleId: string,
    targetUserId: string,
  ): Promise<void> {
    const revoked = await this.uow.execute(async (tx) => {
      const ok = await this.repo.revokeAssignment(targetUserId, roleId, storeId, tx);
      if (ok) await this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
      return ok;
    });
    if (!revoked) throw new NotFoundError(ErrorCodes.ASSIGNMENT_NOT_FOUND, 'Role assignment not found');

    await this.rbac.invalidateUserStoreCache(targetUserId, storeId);
    await this.audit.log({
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
    });
  }
}
