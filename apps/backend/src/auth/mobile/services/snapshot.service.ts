import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z, type ZodType } from 'zod';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import {
  users,
  roles,
  rolePermissions,
  userRoleMappings,
  stores,
} from '#db/schema.js';
import { CryptoService } from '../../core/crypto.service.js';
import { AppConfigService } from '#config/app-config.service.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { readTypedCache } from '#common/redis/typed-cache.js';
import type {
  PermissionSnapshot,
  SnapshotResult,
  StoreEntry,
} from '#common/types/permission-snapshot.js';

const snapshotKey = (userId: string) => `snapshot:${userId}`;

const StoreEntrySchema: ZodType<StoreEntry> = z.object({
  store_id: z.string(),
  name: z.string(),
  permissions: z.array(z.string()),
});

const PermissionSnapshotSchema: ZodType<PermissionSnapshot> = z.object({
  userId: z.string(),
  permissionsVersion: z.number(),
  generatedAt: z.string(),
  stores: z.array(StoreEntrySchema),
});

const SnapshotResultSchema: ZodType<SnapshotResult> = z.object({
  snapshot: PermissionSnapshotSchema,
  signature: z.string(),
});

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly crypto: CryptoService,
    private readonly config: AppConfigService,
  ) {}

  // Without a clientVersion the result is always built (never the "up to date"
  // null case); with one, null signals the client is already current.
  getOrBuild(userId: string): Promise<SnapshotResult>;
  getOrBuild(
    userId: string,
    clientVersion: number | undefined,
  ): Promise<SnapshotResult | null>;
  async getOrBuild(
    userId: string,
    clientVersion?: number,
  ): Promise<SnapshotResult | null> {
    // Degrade to a fresh build on a Redis ERROR (or a corrupt/mismatched
    // cached payload — readTypedCache validates against SnapshotResultSchema
    // and returns null rather than trusting a blind cast): the snapshot is
    // fully rebuildable from Postgres, so both must fall through to build(),
    // not 500 the sync/auth path. A cache miss falls through the same way.
    try {
      const parsed = await readTypedCache(
        this.redis,
        snapshotKey(userId),
        SnapshotResultSchema,
      );
      if (parsed) {
        // Don't just trust the cached snapshot's own self-reported version —
        // compare it against the live DB truth. Without this, a cache entry
        // that should have been invalidated (a missed call site, a future
        // permission-mutating path) can never self-correct: every request
        // whose clientVersion still matches the stale cached version would
        // report "up to date" forever, until the cache entry's own TTL
        // (SNAPSHOT_CACHE_TTL_SECONDS, up to 7 days) happens to lapse. This
        // is a single indexed PK read — cheap insurance on every cache hit.
        const liveVersion = await this.getLivePermissionsVersion(userId);
        if (
          liveVersion !== null &&
          liveVersion !== parsed.snapshot.permissionsVersion
        ) {
          return this.build(userId);
        }
        if (
          clientVersion !== undefined &&
          parsed.snapshot.permissionsVersion === clientVersion
        ) {
          return null; // client is up to date — no payload needed
        }
        return parsed;
      }
    } catch (err) {
      this.logger.warn(
        `Snapshot cache read failed for ${userId}; rebuilding from DB: ${
          err instanceof Error ? err.message : 'unknown Redis error'
        }`,
      );
    }

    return this.build(userId);
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(snapshotKey(userId));
  }

  /** Live `users.permissionsVersion` — the DB truth `getOrBuild` validates a
   *  cache hit against. Returns null (rather than throwing) if the user row
   *  is somehow gone, so a stale-but-present cache entry is trusted as a last
   *  resort instead of failing the request outright. */
  private async getLivePermissionsVersion(userId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ permissionsVersion: users.permissionsVersion })
      .from(users)
      .where(eq(users.id, userId));
    return row?.permissionsVersion ?? null;
  }

  /**
   * Invalidate the cached snapshot and best-effort rebuild it for embedding in a
   * response after a permission-changing action (store create, invite accept).
   * `invalidate()` runs before the rebuild so `getOrBuild` can't return the stale
   * pre-change snapshot. A rebuild failure yields nulls — the action already
   * committed, so the client just falls back to a bootstrap round trip.
   */
  async invalidateAndRebuild(
    userId: string,
  ): Promise<{ snapshot: PermissionSnapshot | null; snapshotSignature: string | null }> {
    await this.invalidate(userId);
    try {
      const built = await this.getOrBuild(userId);
      return { snapshot: built?.snapshot ?? null, snapshotSignature: built?.signature ?? null };
    } catch {
      return { snapshot: null, snapshotSignature: null };
    }
  }

  private async build(userId: string): Promise<SnapshotResult> {
    const [user] = await this.db
      .select({
        guuid: users.guuid,
        permissionsVersion: users.permissionsVersion,
      })
      .from(users)
      .where(eq(users.id, userId));

    const snapshot: PermissionSnapshot = {
      // Wire-facing id must be the public guuid, matching every other
      // user-facing response field (AuthMapper always emits user.guuid as
      // `id`) — never the internal PK, which `userId` is here.
      userId: user?.guuid ?? userId,
      permissionsVersion: user?.permissionsVersion ?? 1,
      generatedAt: new Date().toISOString(),
      stores: await this.buildStoreAccessBlock(userId),
    };

    const canonical = this.crypto.canonicalJson(snapshot);
    const signature = this.crypto.signSnapshot(canonical);
    const result: SnapshotResult = { snapshot, signature };

    try {
      await this.redis.setex(
        snapshotKey(userId),
        this.config.snapshotCacheTtlSeconds,
        JSON.stringify(result),
      );
    } catch {
      /* best-effort cache fill — a Redis write failure must not fail the request */
    }

    return result;
  }

  /**
   * This user's own CRUD grants, scoped per store (adoption §8.2,
   * rbac.md §26.8/§14).
   */
  private async buildStoreAccessBlock(
    userId: string,
  ): Promise<StoreEntry[]> {
    // Stores the user has any active role in.
    const roleRows = await this.db
      .select({ storeFk: userRoleMappings.storeFk, code: roles.code })
      .from(userRoleMappings)
      .innerJoin(roles, eq(userRoleMappings.roleFk, roles.id))
      .where(
        and(
          eq(userRoleMappings.userFk, userId),
          isNull(userRoleMappings.revokedAt),
        ),
      );

    const storeIds = new Set<string>();
    for (const r of roleRows) {
      if (!r.storeFk) continue; // system-wide roles carry no store
      storeIds.add(r.storeFk);
    }
    if (storeIds.size === 0) return [];

    const storeRows = await this.db
      .select({ id: stores.id, name: stores.name })
      .from(stores)
      .where(inArray(stores.id, [...storeIds]));
    const storeNames = new Map(storeRows.map((s) => [s.id, s.name]));

    // This user's active CRUD grants, PER STORE — grouped by roles.storeFk
    // (same scoping join rbac.service.ts's authoritative resolution uses),
    // not flattened across stores. A user with different roles in different
    // stores must never see Store A's grants while Store B is active.
    const permissionRows = await this.db
      .select({
        storeFk: roles.storeFk,
        entityCode: rolePermissions.entityCode,
        action: rolePermissions.action,
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

    const permissionsByStore = new Map<string, Set<string>>();
    for (const p of permissionRows) {
      if (!p.storeFk) continue; // system-wide role grant — no store to attach it to
      const set = permissionsByStore.get(p.storeFk) ?? new Set<string>();
      set.add(`${p.entityCode}:${p.action}`);
      permissionsByStore.set(p.storeFk, set);
    }

    const byStore = new Map<string, StoreEntry>();
    for (const storeId of storeIds) {
      byStore.set(storeId, {
        store_id: storeId,
        name: storeNames.get(storeId) ?? '',
        permissions: [...(permissionsByStore.get(storeId) ?? [])],
      });
    }

    return [...byStore.values()];
  }
}
