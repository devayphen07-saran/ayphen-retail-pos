import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z, type ZodType } from 'zod';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { devices, users } from '#db/schema.js';
import { AppConfigService } from '#config/app-config.service.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { readTypedCache } from '#common/redis/typed-cache.js';

const deviceKey = (id: string) => `device-status:${id}`;
const userKey = (id: string) => `user-status:${id}`;

/** Just the fields MobileJwtGuard reads off `devices` — not the whole row. */
export interface CachedDevice {
  id: string;
  isBlocked: boolean;
  platform: string | null;
}

const CachedDeviceSchema: ZodType<CachedDevice> = z.object({
  id: z.string(),
  isBlocked: z.boolean(),
  platform: z.string().nullable(),
});

/** Just the fields MobileJwtGuard reads off `users` — not the whole row. */
export interface CachedUser {
  id: string;
  guuid: string;
  deletedAt: string | null;
  isBlocked: boolean;
  status: string;
  accountLockedUntil: string | null;
  phoneVerified: boolean;
  permissionsVersion: number;
}

const CachedUserSchema: ZodType<CachedUser> = z.object({
  id: z.string(),
  guuid: z.string(),
  deletedAt: z.string().nullable(),
  isBlocked: z.boolean(),
  status: z.string(),
  accountLockedUntil: z.string().nullable(),
  phoneVerified: z.boolean(),
  permissionsVersion: z.number(),
});

/**
 * MobileJwtGuard's device/user block-status cache (Redis, TTL-bounded — same
 * TTL and staleness contract as the session cache it sits next to). Every
 * authenticated request was hitting Postgres twice just to check
 * isBlocked/deletedAt/status; those columns change rarely, so a short TTL
 * cache removes 2 DB round trips from the hottest path in the app.
 *
 * Invalidation on block/unblock is a best-effort accelerant, not the
 * correctness guarantee — the TTL bound is (mirrors SessionCacheInvalidatorService's
 * own contract). A blocked *device*'s sessions are additionally revoked in the
 * SAME transaction as the block (DeviceAccessService.blockDevice), so that
 * path is caught immediately by the session-revocation check regardless of
 * this cache's staleness.
 */
@Injectable()
export class PrincipalCacheService {
  private readonly logger = new Logger(PrincipalCacheService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly config: AppConfigService,
  ) {}

  async getDevice(deviceId: string): Promise<CachedDevice | null> {
    const cached = await this.readCache(deviceKey(deviceId), CachedDeviceSchema);
    if (cached) return cached;

    const [row] = await this.db
      .select({ id: devices.id, isBlocked: devices.isBlocked, platform: devices.platform })
      .from(devices)
      .where(eq(devices.id, deviceId));
    if (row) await this.writeCache(deviceKey(deviceId), row);
    return row ?? null;
  }

  async getUser(userId: string): Promise<CachedUser | null> {
    const cached = await this.readCache(userKey(userId), CachedUserSchema);
    if (cached) return cached;

    const [row] = await this.db
      .select({
        id: users.id,
        guuid: users.guuid,
        deletedAt: users.deletedAt,
        isBlocked: users.isBlocked,
        status: users.status,
        accountLockedUntil: users.accountLockedUntil,
        phoneVerified: users.phoneVerified,
        permissionsVersion: users.permissionsVersion,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) return null;
    const projected: CachedUser = {
      ...row,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      accountLockedUntil: row.accountLockedUntil ? row.accountLockedUntil.toISOString() : null,
    };
    await this.writeCache(userKey(userId), projected);
    return projected;
  }

  async invalidateDevice(deviceId: string): Promise<void> {
    try { await this.redis.del(deviceKey(deviceId)); } catch { /* best-effort */ }
  }

  async invalidateUser(userId: string): Promise<void> {
    try { await this.redis.del(userKey(userId)); } catch { /* best-effort */ }
  }

  private async readCache<T>(key: string, schema: ZodType<T>): Promise<T | null> {
    try {
      return await readTypedCache(this.redis, key, schema);
    } catch (err) {
      this.logger.warn(
        `Cache read failed for ${key}; falling back to DB: ${
          err instanceof Error ? err.message : 'unknown Redis error'
        }`,
      );
      return null;
    }
  }

  private async writeCache(key: string, value: unknown): Promise<void> {
    try {
      await this.redis.setex(key, this.config.sessionCacheTtlSeconds, JSON.stringify(value));
    } catch {
      /* best-effort cache fill — a Redis write failure must not fail the request */
    }
  }
}