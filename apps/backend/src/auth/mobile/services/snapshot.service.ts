import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import {
  users,
  roles,
  rolePermissions,
  userRoleMappings,
  locations,
  userLocationMappings,
  stores,
} from '#db/schema.js';
import { CryptoService } from '../../core/crypto.service.js';
import { AuthConstantsService } from '../../core/auth-constants.service.js';
import { MOBILE_REDIS } from './redis.provider.js';

const snapshotKey = (userId: string) => `snapshot:${userId}`;

/** A location the user may open within a store (adoption §8.2, rbac.md §26.8). */
export interface LocationSnapshotEntry {
  id:         string;
  name:       string;
  is_primary: boolean;  // Head Office
  is_default: boolean;
  is_locked:  boolean;
}

/** Per-store location access, so an offline device can pick a startup location. */
export interface StoreLocationsEntry {
  store_id:            string;
  name:                string;
  default_location_id: string | null;
  locations:           LocationSnapshotEntry[];
}

export interface PermissionSnapshot {
  userId:             string;
  permissionsVersion: number;
  generatedAt:        string;
  globalPermissions:  string[];
  storeLocations:     StoreLocationsEntry[];
}

export interface SnapshotResult {
  snapshot:  PermissionSnapshot;
  signature: string;
}

@Injectable()
export class SnapshotService {
  constructor(
    @Inject(MOBILE_REDIS) private readonly redis:     Redis,
    @Inject(DRIZZLE)      private readonly db:        PostgresJsDatabase<typeof schema>,
    private readonly crypto:    CryptoService,
    private readonly constants: AuthConstantsService,
  ) {}

  async getOrBuild(userId: string, clientVersion?: number): Promise<SnapshotResult | null> {
    const cached = await this.redis.get(snapshotKey(userId));
    if (cached) {
      const parsed = JSON.parse(cached) as SnapshotResult;
      if (clientVersion !== undefined && parsed.snapshot.permissionsVersion === clientVersion) {
        return null; // client is up to date — no payload needed
      }
      return parsed;
    }

    return this.build(userId);
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(snapshotKey(userId));
  }

  private async build(userId: string): Promise<SnapshotResult> {
    const [user] = await this.db
      .select({ guuid: users.guuid, permissionsVersion: users.permissionsVersion })
      .from(users)
      .where(eq(users.id, userId));

    // Fetch active CRUD grants via the user's roles.
    // NOTE (Phase 5): this still emits the legacy flat `entity:action` string form.
    // The full per-store StorePermissionEntry rebuild (rbac.md §14) replaces this.
    const userRoleRows = await this.db
      .select({
        entityCode: rolePermissions.entityCode,
        action:     rolePermissions.action,
      })
      .from(rolePermissions)
      .innerJoin(roles, eq(rolePermissions.roleFk, roles.id))
      .innerJoin(userRoleMappings, eq(userRoleMappings.roleFk, roles.id))
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          isNull(userRoleMappings.revokedAt),
          isNull(rolePermissions.revokedAt),
        ),
      );

    const snapshot: PermissionSnapshot = {
      // Wire-facing id must be the public guuid, matching every other
      // user-facing response field (AuthMapper always emits user.guuid as
      // `id`) — never the internal PK, which `userId` is here.
      userId: user?.guuid ?? userId,
      permissionsVersion: user?.permissionsVersion ?? 1,
      generatedAt:        new Date().toISOString(),
      globalPermissions:  userRoleRows.map(r => `${r.entityCode}:${r.action}`),
      storeLocations:     await this.buildLocationsBlock(userId),
    };

    const canonical  = this.crypto.canonicalJson(snapshot);
    const signature  = this.crypto.signSnapshot(canonical);
    const result: SnapshotResult = { snapshot, signature };

    await this.redis.setex(
      snapshotKey(userId),
      this.constants.SNAPSHOT_CACHE_TTL_SECONDS,
      JSON.stringify(result),
    );

    return result;
  }

  /**
   * Per-store accessible locations for the offline client (adoption §8.2,
   * rbac.md §26.8). Owners see all locations in their stores; other users see
   * only assigned ones. Each store's default is surfaced so the device knows
   * which location to open on cold start without a network call.
   */
  private async buildLocationsBlock(userId: string): Promise<StoreLocationsEntry[]> {
    // Stores the user has any active role in, and which of those they own.
    const roleRows = await this.db
      .select({ storeFk: userRoleMappings.storeFk, code: roles.code })
      .from(userRoleMappings)
      .innerJoin(roles, eq(userRoleMappings.roleFk, roles.id))
      .where(and(eq(userRoleMappings.userFk, userId), isNull(userRoleMappings.revokedAt)));

    const ownedStores = new Set<string>();
    const storeIds = new Set<string>();
    for (const r of roleRows) {
      if (!r.storeFk) continue; // system-wide roles carry no store
      storeIds.add(r.storeFk);
      if (r.code === 'STORE_OWNER') ownedStores.add(r.storeFk);
    }
    if (storeIds.size === 0) return [];

    const storeRows = await this.db
      .select({ id: stores.id, name: stores.name })
      .from(stores)
      .where(inArray(stores.id, [...storeIds]));
    const storeNames = new Map(storeRows.map((s) => [s.id, s.name]));

    // All active locations across those stores.
    const allLocations = await this.db
      .select({
        id:        locations.id,
        storeFk:   locations.storeFk,
        name:      locations.name,
        isPrimary: locations.isPrimary,
        isDefault: locations.isDefault,
        locked:    locations.locked,
      })
      .from(locations)
      .where(and(eq(locations.isActive, true)));

    // Location ids this user is explicitly assigned to (for the non-owner path).
    const assignedRows = await this.db
      .select({ locationFk: userLocationMappings.locationFk })
      .from(userLocationMappings)
      .where(and(eq(userLocationMappings.userFk, userId), isNull(userLocationMappings.revokedAt)));
    const assigned = new Set(assignedRows.map((r) => r.locationFk));

    const byStore = new Map<string, StoreLocationsEntry>();
    for (const storeId of storeIds) {
      byStore.set(storeId, {
        store_id: storeId,
        name: storeNames.get(storeId) ?? '',
        default_location_id: null,
        locations: [],
      });
    }

    for (const loc of allLocations) {
      const entry = byStore.get(loc.storeFk);
      if (!entry) continue; // location in a store the user has no role in
      const visible = ownedStores.has(loc.storeFk) || assigned.has(loc.id);
      if (loc.isDefault) entry.default_location_id = loc.id; // default is always advertised
      if (!visible) continue;
      entry.locations.push({
        id:         loc.id,
        name:       loc.name,
        is_primary: loc.isPrimary,
        is_default: loc.isDefault,
        is_locked:  loc.locked,
      });
    }

    return [...byStore.values()];
  }
}
