import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UnitOfWork } from '../db/db.module.js';
import { RoleRepository } from './role.repository.js';
import { RbacService } from '../common/rbac/rbac.service.js';
import { AuditService } from '../auth/core/audit.service.js';
import {
  isEntityCode,
  type CrudAction,
} from '../common/rbac/permission-matrix.constants.js';

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

  async listRoles(storeId: string) {
    return this.repo.listStoreRoles(storeId);
  }

  /** Create a custom role, seeded with DEFAULT_ROLE_CRUD (§9, §21). */
  async createRole(
    storeId: string,
    actorId: string,
    name: string,
    description: string | null,
  ): Promise<{ id: string; name: string }> {
    if (await this.repo.nameTaken(storeId, name)) {
      throw new ConflictException('ROLE_ALREADY_EXISTS');
    }
    const role = await this.uow.execute(async (tx) => {
      const r = await this.repo.createCustomRole(storeId, name, description, tx);
      await this.rbac.seedDefaultPermissions(r.id, actorId, tx);
      return r;
    });
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
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    if (!role.isEditable) throw new ForbiddenException('ROLE_NOT_EDITABLE');

    const clean = grants.filter((g) => isEntityCode(g.entity));

    const members = await this.uow.execute(async (tx) => {
      await this.repo.revokeAllCrud(roleId, tx);
      await this.repo.insertCrud(
        clean.map((g) => ({
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
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    if (!role.isEditable) throw new ForbiddenException('ROLE_NOT_EDITABLE');
    if ((await this.repo.countActiveMembers(roleId)) > 0) {
      throw new ConflictException('ROLE_HAS_ACTIVE_ASSIGNMENTS');
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
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    if (SYSTEM_ROLE_CODES.has(role.code)) {
      throw new ForbiddenException('ROLE_NOT_ASSIGNABLE');
    }
    if (!(await this.repo.isAccountMember(targetUserId, storeId))) {
      throw new ForbiddenException('USER_NOT_STORE_MEMBER');
    }
    if (await this.repo.assignmentExists(targetUserId, roleId, storeId)) {
      throw new ConflictException('ASSIGNMENT_ALREADY_EXISTS');
    }

    await this.uow.execute(async (tx) => {
      await this.repo.insertAssignment(
        { userFk: targetUserId, roleFk: roleId, storeFk: storeId, assignedBy: actorId },
        tx,
      );
      await this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
    });
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
    if (!revoked) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');

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
