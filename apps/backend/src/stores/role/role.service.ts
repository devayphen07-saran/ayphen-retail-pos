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
import {
  RoleRepository,
  deriveRoleCode,
  type RoleRow,
  type RoleGrant,
} from './role.repository.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';
import { InvitationRepository } from '../invitation/invitation.repository.js';
import {
  isEntityCode,
  SYSTEM_ROLE_CODES,
  type CrudAction,
} from '#common/rbac/permission-matrix.constants.js';
import { assertGrantsWithinActorScope } from '#common/rbac/effective-permissions.js';

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
    private readonly snapshot: SnapshotService,
    private readonly invitations: InvitationRepository,
  ) {}

  /** Custom, assignable roles only — system roles (STORE_OWNER etc.) are never
   *  a valid target for assign/revoke/permission-edit, so they're hidden from
   *  this listing rather than merely blocked at the mutation endpoints. */
  async listRoles(storeId: string): Promise<RoleRow[]> {
    const roles = await this.repo.listStoreRoles(storeId);
    return roles.filter((r) => !SYSTEM_ROLE_CODES.has(r.code));
  }

  /** A role plus its current permission matrix (view target for the edit screen). */
  async getRole(
    storeId: string,
    roleId: string,
  ): Promise<{ role: RoleRow; grants: RoleGrant[] }> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role)
      throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
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
    // A name that derives to a reserved system code (STORE_OWNER/SUPER_ADMIN/
    // USER) must never become an editable custom role — the store-owner
    // bypass and other consumers trust roles.code === 'STORE_OWNER'
    // unconditionally, with no isEditable check of their own.
    if (SYSTEM_ROLE_CODES.has(deriveRoleCode(name))) {
      throw new ConflictError(
        ErrorCodes.ROLE_RESERVED_CODE,
        'This role name is reserved and cannot be used',
      );
    }

    // Pre-check is TOCTOU-able by itself — two concurrent creates for the
    // same name can both pass it before either commits. roles_store_name_uq
    // (schema.ts) is the real guard; normalize its violation to the same
    // ROLE_ALREADY_EXISTS shape so the client sees consistent text either way.
    if (await this.repo.nameTaken(storeId, name)) {
      throw new ConflictError(
        ErrorCodes.ROLE_ALREADY_EXISTS,
        'A role with this name already exists',
      );
    }
    const role = await rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        const r = await this.repo.createCustomRole(
          storeId,
          name,
          description,
          tx,
        );
        await this.rbac.seedDefaultPermissions(r.id, actorId, tx);
        await this.audit.logInTransaction(
          {
            event: 'ROLE_PERMISSION_CHANGED',
            activityType: 'ROLE_PERMISSION_CHANGED',
            prefix: 'Role',
            suffix: `"${name}" created`,
            userId: actorId,
            storeFk: storeId,
            isSuccess: true,
            entityType: 'Role',
            entityId: r.id,
          },
          tx,
        );
        return r;
      }),
      () =>
        new ConflictError(
          ErrorCodes.ROLE_ALREADY_EXISTS,
          'A role with this name already exists',
        ),
      'roles_store_name_uq',
    );
    return { id: role.id, name };
  }

  /** Replace a custom role's CRUD grants (§21). Optimistic-locked on
   *  `expectedRowVersion` — two admins editing the same role's full matrix
   *  concurrently get a conflict, not a silent last-write-wins clobber. */
  async updatePermissions(
    storeId: string,
    actorId: string,
    roleId: string,
    grants: PermissionGrantInput[],
    expectedRowVersion: number,
  ): Promise<void> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role)
      throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (!role.isEditable)
      throw new ForbiddenError(
        ErrorCodes.ROLE_NOT_EDITABLE,
        'This role cannot be edited',
      );

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

    // Dedupe by (entity, action) — a client sending the same grant twice
    // would otherwise self-collide on insertCrud's unique constraint. Last
    // occurrence wins, though a well-formed client never sends duplicates.
    const deduped = [
      ...new Map(grants.map((g) => [`${g.entity}:${g.action}`, g])).values(),
    ];

    // A caller can never grant a role more than they themselves hold in this
    // store — otherwise Role.edit + UserRoleMapping.create is enough to mint
    // full CRUD for every entity and self-assign it.
    await assertGrantsWithinActorScope(
      this.rbac,
      actorId,
      storeId,
      deduped,
      (g) => g.entity,
      'You cannot grant permissions you do not hold yourself',
    );

    const bumped = await rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        const claimed = await this.repo.casUpdateRowVersion(
          roleId,
          expectedRowVersion,
          tx,
        );
        if (!claimed) {
          // The pre-check above confirmed the role existed a moment ago —
          // re-fetch inside the tx to tell "deleted since" apart from "someone
          // else's edit already moved the version" (LookupService's pattern).
          const stillThere = await this.repo.findRoleInStore(roleId, storeId, tx);
          if (!stillThere) {
            throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
          }
          throw new ConflictError(
            ErrorCodes.ROLE_VERSION_CONFLICT,
            'This role was changed by someone else — reload and try again',
            { currentRowVersion: stillThere.rowVersion },
          );
        }

        await this.repo.revokeAllCrud(roleId, tx);
        await this.repo.insertCrud(
          deduped.map((g) => ({
            roleFk: roleId,
            entityCode: g.entity,
            action: g.action,
            grantedBy: actorId,
          })),
          tx,
        );
        // Bump every member's version so their cache/JWT re-resolve (H-6, §16).
        const bumped = await this.rbac.bumpPermissionsVersionForRole(
          roleId,
          storeId,
          tx,
        );
        await this.audit.logInTransaction(
          {
            event: 'ROLE_PERMISSION_CHANGED',
            activityType: 'ROLE_PERMISSION_CHANGED',
            prefix: 'Role',
            suffix: `permissions updated (${bumped.length} members)`,
            userId: actorId,
            storeFk: storeId,
            isSuccess: true,
            entityType: 'Role',
            entityId: roleId,
          },
          tx,
        );
        return bumped;
      }),
      () =>
        new ConflictError(
          ErrorCodes.ROLE_VERSION_CONFLICT,
          'This role was changed by someone else — reload and try again',
        ),
      'role_permissions_role_entity_action_uq',
    );

    await this.rbac.invalidateRoleMembersCache(roleId, storeId);
    // Every affected member's cached, client-signed permission snapshot is
    // now stale too — same gap as RoleAssignmentService.assignRole/revokeRole.
    await Promise.all(bumped.map((userId) => this.snapshot.invalidate(userId)));
  }

  /** Delete a custom role (§21). Blocked for system roles or roles with members. */
  async deleteRole(
    storeId: string,
    actorId: string,
    roleId: string,
  ): Promise<void> {
    const role = await this.repo.findRoleInStore(roleId, storeId);
    if (!role)
      throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (!role.isEditable)
      throw new ForbiddenError(
        ErrorCodes.ROLE_NOT_EDITABLE,
        'This role cannot be edited',
      );
    if ((await this.repo.countActiveMembers(roleId)) > 0) {
      throw new ConflictError(
        ErrorCodes.ROLE_HAS_ACTIVE_ASSIGNMENTS,
        'This role still has active assignments',
      );
    }
    // Zero active members doesn't mean zero dependents — a still-pending
    // invitation targeting this role would otherwise fail late, at
    // accept-time, with a confusing ROLE_NOT_FOUND instead of being blocked
    // up front here.
    if ((await this.invitations.countActivePendingForRole(roleId)) > 0) {
      throw new ConflictError(
        ErrorCodes.ROLE_HAS_PENDING_INVITATIONS,
        'This role still has a pending invitation — cancel it first',
      );
    }
    await this.uow.execute(async (tx) => {
      // Both pre-checks above are TOCTOU-able by themselves — a concurrent
      // assignRole or invitation-create can land between the check and this
      // transaction committing. Lock the role row first (same shape as
      // StoreService.createStore's lockAccount), then recheck both counts
      // inside the transaction before actually soft-deleting it.
      await this.repo.lockRole(roleId, tx);
      if ((await this.repo.countActiveMembers(roleId, tx)) > 0) {
        throw new ConflictError(
          ErrorCodes.ROLE_HAS_ACTIVE_ASSIGNMENTS,
          'This role still has active assignments',
        );
      }
      if ((await this.invitations.countActivePendingForRole(roleId, tx)) > 0) {
        throw new ConflictError(
          ErrorCodes.ROLE_HAS_PENDING_INVITATIONS,
          'This role still has a pending invitation — cancel it first',
        );
      }
      await this.repo.softDeleteRole(roleId, storeId, tx);
      await this.audit.logInTransaction(
        {
          event: 'ROLE_PERMISSION_CHANGED',
          activityType: 'ROLE_PERMISSION_CHANGED',
          prefix: 'Role',
          suffix: `"${role.name}" deleted`,
          userId: actorId,
          storeFk: storeId,
          isSuccess: true,
          entityType: 'Role',
          entityId: roleId,
        },
        tx,
      );
    });
  }

}
