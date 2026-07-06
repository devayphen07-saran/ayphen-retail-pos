import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { MOBILE_REDIS } from '#auth/mobile/services/redis.provider.js';
import type { DbExecutor } from '#db/db.module.js';
import { RbacRepository, type ActiveRole } from './rbac.repository.js';
import type { EffectivePermissions } from './effective-permissions.js';
import {
  emptyPermissions,
  serializePermissions,
  deserializePermissions,
  checkCrud as crudCheck,
  checkSpecial as specialCheck,
} from './effective-permissions.js';
import {
  DEFAULT_ROLE_CRUD,
  STORE_OWNER_CRUD,
  STORE_OWNER_SPECIAL,
  CRUD_ACTIONS,
  isEntityCode,
  type CrudAction,
} from './permission-matrix.constants.js';

// ─── Redis cache keys + TTLs ──────────────────────────────────────────────────

const permKey = (userId: string, storeId: string): string =>
  `perm:${userId}:${storeId}`;

const userStoresKey = (userId: string): string =>
  `user_stores:${userId}`;

const TTL_STANDARD_SECONDS = 300; // 5m
const TTL_CRITICAL_SECONDS = 30; // 30s
const TTL_USER_STORES_SECONDS = 300; // 5m

@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name);

  constructor(
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
    private readonly repo: RbacRepository,
  ) {}

  // ─── Permission resolution + cache ─────────────────────────────────────────

  /**
   * Resolve effective permissions for (userId, storeId), using Redis cache.
   *
   * Critical operations (delete + financial/destructive specials) must never
   * run against a snapshot older than the 30s critical window (rbac.md §7, §19).
   * The permission set is store-scoped and identical regardless of the calling
   * action, so we keep a single cache key rather than one-per-criticality (that
   * would double DB load). Instead, a critical request rejects any entry whose
   * remaining TTL exceeds the critical window — i.e. one written by a standard
   * (5m) request — and refetches, re-pinning the key to the 30s TTL. A standard
   * request accepts any live entry.
   *
   * Corrupt cache entries are deleted and treated as misses (BR-RBAC-018).
   */
  async getCachedPermissions(
    userId: string,
    storeId: string,
    isCritical: boolean,
  ): Promise<EffectivePermissions> {
    const key = permKey(userId, storeId);

    const cached = await this.redis.get(key);
    if (cached) {
      // For a critical read, a long remaining TTL means the entry was cached by
      // a standard request and may be up to 5m stale — too old for a critical op.
      let acceptCached = true;
      if (isCritical) {
        const remainingTtl = await this.redis.ttl(key);
        acceptCached = remainingTtl >= 0 && remainingTtl <= TTL_CRITICAL_SECONDS;
      }

      if (acceptCached) {
        try {
          return deserializePermissions(cached);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'unknown cache error';
          this.logger.warn(
            `Corrupt permissions cache for ${key}: ${message.slice(0, 160)}. Refetching from DB.`,
          );
          await this.redis.del(key);
        }
      }
    }

    const permissions = await this.resolveFromDb(userId, storeId);
    const ttl = isCritical ? TTL_CRITICAL_SECONDS : TTL_STANDARD_SECONDS;

    await this.redis.setex(key, ttl, serializePermissions(permissions));
    return permissions;
  }

  /**
   * Build EffectivePermissions from DB by OR-union across all active roles.
   */
  private async resolveFromDb(
    userId: string,
    storeId: string,
  ): Promise<EffectivePermissions> {
    const activeRoles = await this.repo.findActiveRolesForUser(userId, storeId);
    if (activeRoles.length === 0) {
      return emptyPermissions();
    }

    // Store isolation (BR-RBAC-002): only roles scoped to THIS store contribute
    // to the store's CRUD/special matrix. System-wide roles (roleStoreFk null,
    // e.g. USER/SUPER_ADMIN) must never inject store grants — their authority is
    // handled elsewhere (SuperAdminGuard). Without this filter, a system-wide
    // role carrying any rolePermissions would bleed across every store.
    const roleIds = activeRoles
      .filter((role) => role.roleStoreFk === storeId)
      .map((role) => role.roleId);
    if (roleIds.length === 0) {
      return emptyPermissions();
    }

    const [crudRows, specialRows] = await Promise.all([
      this.repo.fetchCrudPermissions(roleIds),
      this.repo.fetchSpecialPermissions(roleIds),
    ]);

    const crud: EffectivePermissions['crud'] = new Map();
    for (const row of crudRows) {
      // Drop rows whose entity_code is no longer in the matrix (decommissioned)
      // instead of asserting — fail-closed, and `entity` is genuinely EntityCode.
      if (!isEntityCode(row.entityCode)) continue;
      const entity = row.entityCode;
      const current = crud.get(entity) ?? {
        view: false,
        create: false,
        edit: false,
        delete: false,
      };

      current[row.action] = true;
      crud.set(entity, current);
    }

    const special: EffectivePermissions['special'] = new Map();
    for (const row of specialRows) {
      if (!isEntityCode(row.entityCode)) continue;
      const entity = row.entityCode;
      const current = special.get(entity) ?? new Set<string>();
      current.add(row.actionCode);
      special.set(entity, current);
    }

    return { crud, special };
  }

  /**
   * CRUD check. An unknown entity code (e.g. a typo in a route decorator) is
   * fail-closed: not a real entity → no grant → false.
   */
  checkCrud(
    permissions: EffectivePermissions,
    entity: string,
    action: CrudAction,
  ): boolean {
    if (!isEntityCode(entity)) return false;
    return crudCheck(permissions, entity, action);
  }

  /** Special-action check. Unknown entity code is fail-closed (see checkCrud). */
  checkSpecial(
    permissions: EffectivePermissions,
    entity: string,
    actionCode: string,
  ): boolean {
    if (!isEntityCode(entity)) return false;
    return specialCheck(permissions, entity, actionCode);
  }

  // ─── Accessible-store cache ────────────────────────────────────────────────

  async userStoreIds(userId: string): Promise<string[]> {
    const key = userStoresKey(userId);

    const cached = await this.redis.get(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as unknown;
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
          return parsed;
        }
        await this.redis.del(key);
      } catch {
        await this.redis.del(key);
      }
    }

    const ids = await this.repo.findAccessibleStoreIds(userId);
    await this.redis.setex(
      key,
      TTL_USER_STORES_SECONDS,
      JSON.stringify(ids),
    );
    return ids;
  }

  // ─── Point-in-time authorization ───────────────────────────────────────────

  async wasCrudAuthorizedAt(params: {
    userId: string;
    storeId: string;
    entity: string;
    action: CrudAction;
    asOf: Date;
  }): Promise<boolean> {
    return this.repo.wasCrudAuthorizedAt(params);
  }

  // ─── Cache invalidation ────────────────────────────────────────────────────

  async invalidateUserStoreCache(
    userId: string,
    storeId: string,
  ): Promise<void> {
    await Promise.all([
      this.redis.del(permKey(userId, storeId)),
      this.redis.del(userStoresKey(userId)),
    ]);
  }

  async invalidateRoleMembersCache(
    roleId: string,
    storeId: string | null,
  ): Promise<void> {
    const memberIds = await this.repo.findActiveMemberIds(roleId, storeId);
    if (memberIds.length === 0) return;

    const keys: string[] = [];
    for (const userId of memberIds) {
      if (storeId) {
        keys.push(permKey(userId, storeId));
      }
      keys.push(userStoresKey(userId));
    }

    if (keys.length > 0) {
      await this.redis.del(...keys);
    }

    this.logger.debug(
      `Invalidated RBAC cache for ${memberIds.length} members of role ${roleId} (store ${storeId ?? 'system'}).`,
    );
  }

  // ─── Lifecycle helpers ─────────────────────────────────────────────────────

  /**
   * Seed default CRUD grants for a new custom role.
   * Must be called inside the caller's transaction.
   */
  async seedDefaultPermissions(
    roleId: string,
    grantedBy: string | null,
    tx: DbExecutor,
  ): Promise<void> {
    const grants: Array<{
      roleFk: string;
      entityCode: string;
      action: CrudAction;
      grantedBy: string | null;
    }> = [];

    for (const [entityCode, matrix] of Object.entries(DEFAULT_ROLE_CRUD)) {
      // Defense-in-depth: DEFAULT_ROLE_CRUD is validated at startup, but never
      // insert a grant for a code that isn't a real entity.
      if (!isEntityCode(entityCode) || !matrix) continue;
      for (const action of CRUD_ACTIONS) {
        if (matrix[action]) {
          grants.push({
            roleFk: roleId,
            entityCode,
            action,
            grantedBy,
          });
        }
      }
    }

    await this.repo.insertCrudGrants(grants, tx);
  }

  /**
   * Seed the full STORE_OWNER grant matrix (STORE_OWNER_CRUD + STORE_OWNER_SPECIAL,
   * §6/§7) for a store's immutable STORE_OWNER role. Called by the store-create
   * flow inside its transaction — distinct from seedDefaultPermissions, which
   * seeds the minimal custom-role defaults.
   */
  async seedStoreOwnerPermissions(
    roleId: string,
    grantedBy: string | null,
    tx: DbExecutor,
  ): Promise<void> {
    const crudGrants: Array<{
      roleFk: string;
      entityCode: string;
      action: CrudAction;
      grantedBy: string | null;
    }> = [];
    for (const [entityCode, matrix] of Object.entries(STORE_OWNER_CRUD)) {
      if (!isEntityCode(entityCode) || !matrix) continue;
      for (const action of CRUD_ACTIONS) {
        if (matrix[action]) {
          crudGrants.push({ roleFk: roleId, entityCode, action, grantedBy });
        }
      }
    }
    await this.repo.insertCrudGrants(crudGrants, tx);

    const specialGrants: Array<{
      roleFk: string;
      entityCode: string;
      actionCode: string;
      grantedBy: string | null;
    }> = [];
    for (const [entityCode, actions] of Object.entries(STORE_OWNER_SPECIAL)) {
      if (!isEntityCode(entityCode) || !actions) continue;
      for (const actionCode of actions) {
        specialGrants.push({ roleFk: roleId, entityCode, actionCode, grantedBy });
      }
    }
    await this.repo.insertSpecialGrants(specialGrants, tx);
  }

  async bumpPermissionsVersionForRole(
    roleId: string,
    storeId: string | null,
    tx?: DbExecutor,
  ): Promise<string[]> {
    const memberIds = await this.repo.findActiveMemberIds(roleId, storeId, tx);
    await this.repo.bumpPermissionsVersion(memberIds, tx);
    return memberIds;
  }

  /** Bump one user's permissions version (e.g. location assignment change, H-6). */
  async bumpPermissionsVersionForUser(userId: string, tx?: DbExecutor): Promise<void> {
    await this.repo.bumpPermissionsVersion([userId], tx);
  }

  // ─── Convenience passthroughs ──────────────────────────────────────────────

  async findActiveRolesForUser(
    userId: string,
    storeId: string,
  ): Promise<ActiveRole[]> {
    return this.repo.findActiveRolesForUser(userId, storeId);
  }
}