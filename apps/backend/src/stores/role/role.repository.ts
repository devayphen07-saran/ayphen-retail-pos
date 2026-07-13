import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import {
  roles,
  rolePermissions,
  userRoleMappings,
  accountUsers,
  stores,
} from '#db/schema.js';
import type { CrudAction } from '#common/rbac/permission-matrix.constants.js';

export interface RoleRow {
  id:          string;
  code:        string;
  name:        string;
  description: string | null;
  isEditable:  boolean;
  storeFk:     string | null;
  rowVersion:  number;
}

export interface RoleGrant {
  entityCode: string;
  action:     CrudAction;
}

/** The single place a role name becomes its `code` — the service's reserved-
 *  code check and this repository's insert must always derive it identically. */
export function deriveRoleCode(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

@Injectable()
export class RoleRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** Custom (non-deleted) roles in a store. Defensive cap, not real
   *  pagination — roles per store are structurally small (owner-authored),
   *  but an unbounded query is still a "bound everything" violation. */
  async listStoreRoles(storeId: string, tx?: DbExecutor): Promise<RoleRow[]> {
    return this.client(tx)
      .select({
        id: roles.id,
        code: roles.code,
        name: roles.name,
        description: roles.description,
        isEditable: roles.isEditable,
        storeFk: roles.storeFk,
        rowVersion: roles.rowVersion,
      })
      .from(roles)
      .where(and(eq(roles.storeFk, storeId), isNull(roles.deletedAt)))
      .limit(500);
  }

  async findRoleInStore(
    roleId: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<RoleRow | null> {
    const [row] = await this.client(tx)
      .select({
        id: roles.id,
        code: roles.code,
        name: roles.name,
        description: roles.description,
        isEditable: roles.isEditable,
        storeFk: roles.storeFk,
        rowVersion: roles.rowVersion,
      })
      .from(roles)
      .where(
        and(eq(roles.id, roleId), eq(roles.storeFk, storeId), isNull(roles.deletedAt)),
      );
    return row ?? null;
  }

  /** True if a non-deleted role with this name exists in the store. */
  async nameTaken(storeId: string, name: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(eq(roles.storeFk, storeId), eq(roles.name, name), isNull(roles.deletedAt)),
      );
    return !!row;
  }

  async createCustomRole(
    storeId: string,
    name: string,
    description: string | null,
    tx?: DbExecutor,
  ): Promise<{ id: string }> {
    const [row] = await this.client(tx)
      .insert(roles)
      .values({
        storeFk: storeId,
        code: deriveRoleCode(name),
        name,
        description,
        isEditable: true,
      })
      .returning({ id: roles.id });
    return requireRow(row);
  }

  async softDeleteRole(roleId: string, storeId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(roles)
      .set({ deletedAt: new Date() })
      .where(and(eq(roles.id, roleId), eq(roles.storeFk, storeId)));
    // Soft-delete its grants too.
    await this.client(tx)
      .update(rolePermissions)
      .set({ revokedAt: new Date() })
      .where(and(eq(rolePermissions.roleFk, roleId), isNull(rolePermissions.revokedAt)));
  }

  /**
   * Row-lock a role for the duration of the transaction (SELECT ... FOR
   * UPDATE), modeled on InvitationRepository.lockStore/StoreRepository.lockAccount.
   * Serializes a delete's member/invite-count recheck against a concurrent
   * assign/invite targeting the same role, so the recheck inside the
   * transaction is actually trustworthy (not just another unlocked read).
   */
  async lockRole(roleId: string, tx: DbExecutor): Promise<void> {
    await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleId))
      .for('update');
  }

  /** Count active members of a role (any store scope). */
  async countActiveMembers(roleId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(userRoleMappings)
      .where(
        and(eq(userRoleMappings.roleFk, roleId), isNull(userRoleMappings.revokedAt)),
      );
    return row?.n ?? 0;
  }

  /** Active CRUD grants for a role — the current state of its permission matrix. */
  async listGrants(roleId: string, tx?: DbExecutor): Promise<RoleGrant[]> {
    return this.client(tx)
      .select({ entityCode: rolePermissions.entityCode, action: rolePermissions.action })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.roleFk, roleId), isNull(rolePermissions.revokedAt)));
  }

  // ── CRUD grant editing ────────────────────────────────────────────────────

  /**
   * Optimistic-lock claim on a role's permission matrix — bump `row_version`
   * atomically in the same UPDATE that checks it, so two concurrent full-
   * matrix edits can't silently clobber each other. Returns null on a version
   * mismatch (or a concurrent delete); the caller re-fetches to tell the two
   * apart, mirroring LookupService.updateValue's pattern.
   */
  async casUpdateRowVersion(
    roleId: string,
    expectedRowVersion: number,
    tx?: DbExecutor,
  ): Promise<{ rowVersion: number } | null> {
    const [row] = await this.client(tx)
      .update(roles)
      .set({ rowVersion: sql`${roles.rowVersion} + 1` })
      .where(and(eq(roles.id, roleId), eq(roles.rowVersion, expectedRowVersion)))
      .returning({ rowVersion: roles.rowVersion });
    return row ?? null;
  }

  /** Revoke all active CRUD grants for a role (before re-applying a new set). */
  async revokeAllCrud(roleId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(rolePermissions)
      .set({ revokedAt: new Date() })
      .where(and(eq(rolePermissions.roleFk, roleId), isNull(rolePermissions.revokedAt)));
  }

  async insertCrud(
    grants: { roleFk: string; entityCode: string; action: CrudAction; grantedBy: string | null }[],
    tx?: DbExecutor,
  ): Promise<void> {
    if (grants.length === 0) return;
    await this.client(tx).insert(rolePermissions).values(grants);
  }

  // ── Assignment ────────────────────────────────────────────────────────────

  async assignmentExists(
    userId: string,
    roleId: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: userRoleMappings.id })
      .from(userRoleMappings)
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          eq(userRoleMappings.roleFk, roleId),
          eq(userRoleMappings.storeFk, storeId),
          isNull(userRoleMappings.revokedAt),
        ),
      );
    return !!row;
  }

  async insertAssignment(
    data: typeof userRoleMappings.$inferInsert,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx).insert(userRoleMappings).values(data);
  }

  /**
   * Same insert as `insertAssignment`, but a no-op on conflict — for callers
   * whose own CAS already guarantees this only runs once (e.g. invitation
   * accept, gated by `markAccepted`'s status='pending' check), so a losing
   * race here just means "already assigned," not an error.
   */
  async insertAssignmentIfAbsent(
    data: typeof userRoleMappings.$inferInsert,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx).insert(userRoleMappings).values(data).onConflictDoNothing();
  }

  async revokeAssignment(
    userId: string,
    roleId: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const rows = await this.client(tx)
      .update(userRoleMappings)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          eq(userRoleMappings.roleFk, roleId),
          eq(userRoleMappings.storeFk, storeId),
          isNull(userRoleMappings.revokedAt),
        ),
      )
      .returning({ id: userRoleMappings.id });
    return rows.length > 0;
  }

  /** True if the target user is a member of the store's account. */
  async isAccountMember(
    userId: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: accountUsers.id })
      .from(accountUsers)
      .innerJoin(stores, eq(stores.accountFk, accountUsers.accountFk))
      .where(and(eq(stores.id, storeId), eq(accountUsers.userFk, userId)));
    return !!row;
  }
}
