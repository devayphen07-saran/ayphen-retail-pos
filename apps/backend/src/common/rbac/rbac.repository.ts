import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { union } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import {
  accounts,
  rolePermissions,
  roleSpecialPermissions,
  roles,
  stores,
  userRoleMappings,
} from '#db/schema.js';

import type { CrudAction } from './permission-matrix.constants.js';

type DbClient = PostgresJsDatabase<typeof schema> | DbExecutor;

export interface ActiveRole {
  roleId: string;
  code: string;
  /** The role's own scope: a store id for store-scoped roles, null for system-wide. */
  roleStoreFk: string | null;
}

export interface CrudGrantRow {
  entityCode: string;
  action: CrudAction;
}

export interface SpecialGrantRow {
  entityCode: string;
  actionCode: string;
}

export interface InsertCrudGrantInput {
  roleFk: string;
  entityCode: string;
  action: CrudAction;
  grantedBy: string | null;   // null = system-seeded (granted_by is nullable)
}

export interface InsertSpecialGrantInput {
  roleFk: string;
  entityCode: string;
  actionCode: string;
  grantedBy: string | null;
}

/**
 * Central RBAC read/write repository.
 *
 * Owns:
 * - active role resolution
 * - CRUD/special grant reads
 * - accessible store lookup
 * - point-in-time authorization checks for offline sync
 * - permissions_version bumps
 * - default grant inserts for new custom roles
 */
@Injectable()
export class RbacRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private getClient(tx?: DbExecutor): DbClient {
    return tx ?? this.db;
  }

  /**
   * Active roles a user currently holds relevant to a store. Returns BOTH the
   * store-scoped roles for that store AND the user's system-wide roles
   * (store_fk IS NULL), each tagged with `roleStoreFk` so callers can tell them
   * apart.
   *
   * ARCHITECTURE RULE: system-wide roles (USER, SUPER_ADMIN) do NOT contribute
   * to a store's EffectivePermissions matrix — SUPER_ADMIN authority is enforced
   * by SuperAdminGuard on /admin routes, and USER carries no store grants. Only
   * store-scoped roles feed the store CRUD/special union (see
   * RbacService.resolveFromDb). System-wide roles are still returned here for
   * callers that need role membership (e.g. detecting SUPER_ADMIN by code).
   *
   * Excludes: revoked mappings, expired mappings, soft-deleted roles.
   */
  async findActiveRolesForUser(
    userId: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<ActiveRole[]> {
    const client = this.getClient(tx);
    const now = new Date();

    const rows = await client
      .select({
        roleId: roles.id,
        code: roles.code,
        roleStoreFk: roles.storeFk,
      })
      .from(userRoleMappings)
      .innerJoin(roles, eq(userRoleMappings.roleFk, roles.id))
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          or(eq(userRoleMappings.storeFk, storeId), isNull(userRoleMappings.storeFk)),
          isNull(userRoleMappings.revokedAt),
          or(isNull(userRoleMappings.expiresAt), gt(userRoleMappings.expiresAt, now)),
          isNull(roles.deletedAt),
        ),
      );

    return rows;
  }

  /**
   * Active CRUD grants across the supplied role IDs.
   */
  async findCrudPermissions(
    roleIds: string[],
    tx?: DbExecutor,
  ): Promise<CrudGrantRow[]> {
    if (roleIds.length === 0) return [];

    const client = this.getClient(tx);

    const rows = await client
      .select({
        entityCode: rolePermissions.entityCode,
        action: rolePermissions.action,
      })
      .from(rolePermissions)
      .where(
        and(
          inArray(rolePermissions.roleFk, roleIds),
          isNull(rolePermissions.revokedAt),
        ),
      );

    // No cast needed: the select projects exactly { entityCode, action } and
    // `rolePermissions.action` is a Drizzle enum column typed as CrudAction, so
    // `rows` already satisfies CrudGrantRow[] — with full type-checking restored.
    return rows;
  }

  /**
   * Active special-action grants across the supplied role IDs.
   */
  async findSpecialPermissions(
    roleIds: string[],
    tx?: DbExecutor,
  ): Promise<SpecialGrantRow[]> {
    if (roleIds.length === 0) return [];

    const client = this.getClient(tx);

    return client
      .select({
        entityCode: roleSpecialPermissions.entityCode,
        actionCode: roleSpecialPermissions.actionCode,
      })
      .from(roleSpecialPermissions)
      .where(
        and(
          inArray(roleSpecialPermissions.roleFk, roleIds),
          isNull(roleSpecialPermissions.revokedAt),
        ),
      );
  }

  /**
   * All store IDs a user may act in. A store is accessible iff the user holds an
   * active (non-revoked, unexpired) store-scoped role in it, OR the user owns the
   * store's account. Account membership alone is deliberately NOT sufficient
   * (P0-2): a plain account member with no role in a sibling store must not clear
   * the tenant boundary. Account owners always retain access to their own stores
   * (the ownerUserFk OR is defensive — they normally also hold STORE_OWNER on every
   * store they create, but this survives a revoked owner mapping).
   */
  /**
   * Every store id this user can reach: owns the account, or holds a live
   * (non-revoked, non-expired) role assignment in the store. Written as a
   * UNION of two independently-indexed queries (idx_accounts_owner,
   * idx_user_role_mappings_user_store) rather than one query with an OR
   * across two outer-joined tables — the OR form can't be served by any
   * single index and forces a scan proportional to total platform store
   * count on every cache-miss, for every active user.
   */
  async findAccessibleStoreIds(
    userId: string,
    tx?: DbExecutor,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const now = new Date();

    const owned = client
      .select({ id: stores.id })
      .from(stores)
      .innerJoin(accounts, eq(accounts.id, stores.accountFk))
      .where(and(isNull(stores.deletedAt), eq(accounts.ownerUserFk, userId)));

    const assigned = client
      .select({ id: stores.id })
      .from(userRoleMappings)
      .innerJoin(stores, eq(stores.id, userRoleMappings.storeFk))
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          isNull(userRoleMappings.revokedAt),
          or(
            isNull(userRoleMappings.expiresAt),
            gt(userRoleMappings.expiresAt, now),
          ),
          isNull(stores.deletedAt),
        ),
      );

    const rows = await union(owned, assigned);
    return rows.map((row) => row.id);
  }

  /**
   * Resolve a store by id, constrained to an accessible-id set. Returns null for
   * both non-existent and inaccessible stores — the caller renders one error for
   * both (timing-oracle protection, rbac.md §19). `raw` may be a store id (uuid).
   */
  async resolveAccessibleStore(
    raw: string,
    accessibleIds: string[],
    tx?: DbExecutor,
  ): Promise<{ id: string; accountFk: string; locked: boolean } | null> {
    if (accessibleIds.length === 0) return null;
    if (!accessibleIds.includes(raw)) return null; // not accessible → indistinguishable from missing

    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: stores.id, accountFk: stores.accountFk, locked: stores.locked })
      .from(stores)
      .where(and(eq(stores.id, raw), isNull(stores.deletedAt)));

    return row ?? null;
  }

  /**
   * Active user IDs currently assigned to a role.
   * Used for cache invalidation and permissions_version bumping.
   */
  async findActiveMemberIds(
    roleId: string,
    storeId: string | null,
    tx?: DbExecutor,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const now = new Date();

    const rows = await client
      .select({ userFk: userRoleMappings.userFk })
      .from(userRoleMappings)
      .where(
        and(
          eq(userRoleMappings.roleFk, roleId),
          storeId === null
            ? isNull(userRoleMappings.storeFk)
            : eq(userRoleMappings.storeFk, storeId),
          isNull(userRoleMappings.revokedAt),
          or(isNull(userRoleMappings.expiresAt), gt(userRoleMappings.expiresAt, now)),
        ),
      );

    return rows.map((row) => row.userFk);
  }

  /**
   * True if the user holds the system-wide SUPER_ADMIN role (store_fk NULL,
   * mapping active). Used by SuperAdminGuard (rbac.md §8, §10F).
   */
  async isSuperAdmin(userId: string, tx?: DbExecutor): Promise<boolean> {
    const client = this.getClient(tx);
    const now = new Date();
    const [row] = await client
      .select({ ok: sql<number>`1` })
      .from(userRoleMappings)
      .innerJoin(roles, eq(userRoleMappings.roleFk, roles.id))
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          eq(roles.code, 'SUPER_ADMIN'),
          isNull(roles.storeFk),
          isNull(roles.deletedAt),
          isNull(userRoleMappings.revokedAt),
          or(isNull(userRoleMappings.expiresAt), gt(userRoleMappings.expiresAt, now)),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Point-in-time CRUD authorization check for offline mutation replay.
   *
   * Returns true only if:
   * - the user had an active role assignment at `asOf`
   * - that role is scoped to THIS store (roles.storeFk === storeId) — same
   *   invariant RbacService.resolveFromDb enforces for live checks: a
   *   system-wide role (USER, SUPER_ADMIN) must never authorize a store CRUD
   *   action, here or there. Without this filter, a system-wide role's
   *   mapping (userRoleMappings.storeFk IS NULL) would satisfy the OR below
   *   for ANY storeId, and if that role ever carried a rolePermissions grant,
   *   offline replay could authorize a mutation in a store the grant was
   *   never meant to reach.
   * - the role grant existed at `asOf`
   * - neither assignment nor grant had been revoked by `asOf`
   */
  async wasCrudAuthorizedAt(params: {
    userId: string;
    storeId: string;
    entity: string;
    action: CrudAction;
    asOf: Date;
    tx?: DbExecutor;
  }): Promise<boolean> {
    const { userId, storeId, entity, action, asOf, tx } = params;
    const client = this.getClient(tx);

    const [row] = await client
      .select({ ok: sql<number>`1` })
      .from(userRoleMappings)
      .innerJoin(roles, eq(userRoleMappings.roleFk, roles.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleFk, roles.id))
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          eq(userRoleMappings.storeFk, storeId),
          eq(roles.storeFk, storeId),
          isNull(roles.deletedAt),

          // assignment active at asOf
          lte(userRoleMappings.assignedAt, asOf),
          or(isNull(userRoleMappings.revokedAt), gt(userRoleMappings.revokedAt, asOf)),
          or(isNull(userRoleMappings.expiresAt), gt(userRoleMappings.expiresAt, asOf)),

          // grant active at asOf
          eq(rolePermissions.entityCode, entity),
          eq(rolePermissions.action, action),
          lte(rolePermissions.grantedAt, asOf),
          or(isNull(rolePermissions.revokedAt), gt(rolePermissions.revokedAt, asOf)),
        ),
      )
      .limit(1);

    return Boolean(row);
  }

  /**
   * Bump permissions_version for a set of users.
   */
  async bumpPermissionsVersion(
    userIds: string[],
    tx?: DbExecutor,
  ): Promise<void> {
    if (userIds.length === 0) return;

    const client = this.getClient(tx);

    await client
      .update(schema.users)
      .set({
        permissionsVersion: sql`${schema.users.permissionsVersion} + 1`,
      })
      .where(inArray(schema.users.id, userIds));
  }

  /**
   * Insert default CRUD grants for a newly created custom role.
   */
  async insertCrudGrants(
    grants: InsertCrudGrantInput[],
    tx?: DbExecutor,
  ): Promise<void> {
    if (grants.length === 0) return;

    const client = this.getClient(tx);
    await client.insert(rolePermissions).values(grants);
  }

  /** Insert special-action grants for a role (e.g. STORE_OWNER seeding). */
  async insertSpecialGrants(
    grants: InsertSpecialGrantInput[],
    tx?: DbExecutor,
  ): Promise<void> {
    if (grants.length === 0) return;

    const client = this.getClient(tx);
    await client.insert(roleSpecialPermissions).values(grants);
  }
}