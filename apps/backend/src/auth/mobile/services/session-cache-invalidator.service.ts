import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z, type ZodType } from 'zod';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { deviceSessions } from '#db/schema.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { readTypedCache } from '#common/redis/typed-cache.js';
import { AppConfigService } from '#config/app-config.service.js';

export type DeviceSession = typeof deviceSessions.$inferSelect;

const sessionKey = (id: string) => `session:${id}`;
const tombstoneKey = (id: string) => `session:${id}:tombstone`;

/** Mirrors the `deviceSessions` table (db/schema.ts) column-for-column, so a
 *  cached row is validated against the same shape it was written from —
 *  z.coerce.date() rehydrates the ISO strings JSON.stringify produced. */
const DeviceSessionSchema: ZodType<DeviceSession> = z.object({
  id: z.string(),
  userFk: z.string(),
  deviceFk: z.string(),
  expiresAt: z.coerce.date(),
  lastUsedAt: z.coerce.date(),
  lastStepUpAt: z.coerce.date().nullable(),
  lastStepUpMethod: z.enum(['otp', 'password', 'biometric']).nullable(),
  stepUpLockedUntil: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
  revokedReason: z.string().nullable(),
  currentJti: z.string().nullable(),
  currentJtiExp: z.coerce.date().nullable(),
  ipAtCreation: z.string().nullable(),
  geoAtCreation: z.string().nullable(),
  deviceName: z.string().nullable(),
  os: z.string().nullable(),
  appVersion: z.string().nullable(),
  platform: z.string().nullable(),
  lastAppVersion: z.string().nullable(),
  pushToken: z.string().nullable(),
  createdAt: z.coerce.date(),
});

/**
 * A fill racing behind a concurrent revoke is the failure mode a bare
 * DEL-then-SETEX can't prevent: a request whose DB read landed BEFORE a
 * revoke commits can still call its own cache-fill AFTER that revoke's DEL,
 * resurrecting the pre-revocation row for a full cache TTL — during which
 * the revoked session reads as valid straight from Redis. `invalidate` fences
 * that window with a tombstone; `fillIfNotTombstoned` is a single atomic
 * check-then-SETEX, so a fill whose check runs after the tombstone is set
 * sees it and skips writing the stale row. Tombstone TTL matches the cache
 * TTL — once it expires, the row it would have protected has already
 * expired too, so there is nothing left to resurrect.
 */
const FILL_IF_NOT_TOMBSTONED_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SETEX', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/**
 * Single owner of the `session:{id}` Redis cache — reads, conditional fills,
 * and invalidation all live here so the tombstone consistency invariant
 * (see `FILL_IF_NOT_TOMBSTONED_LUA` above) can't drift between a reader and
 * a writer maintained in separate files.
 */
@Injectable()
export class SessionCacheInvalidatorService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly config: AppConfigService,
  ) {}

  /** Cache-only read, schema-validated. A miss or corrupt/mismatched entry
   *  returns null — the caller falls back to the DB, never treats this as
   *  "no session". */
  async read(deviceSessionId: string): Promise<DeviceSession | null> {
    return readTypedCache(this.redis, sessionKey(deviceSessionId), DeviceSessionSchema);
  }

  /**
   * Populate the cache from a freshly-read DB row, unless a concurrent
   * revoke's tombstone shows the row may already be stale (see the race
   * described above `FILL_IF_NOT_TOMBSTONED_LUA`). Best-effort: a Redis
   * failure here must not fail the caller's request.
   */
  async fillIfNotTombstoned(deviceSessionId: string, row: DeviceSession): Promise<void> {
    try {
      await this.redis.eval(
        FILL_IF_NOT_TOMBSTONED_LUA,
        2,
        sessionKey(deviceSessionId),
        tombstoneKey(deviceSessionId),
        this.config.sessionCacheTtlSeconds,
        JSON.stringify(row),
      );
    } catch {
      /* best-effort cache fill — a Redis write failure must not fail the request */
    }
  }

  async invalidate(deviceSessionId: string): Promise<void> {
    const ttl = this.config.sessionCacheTtlSeconds;
    await Promise.all([
      this.redis.del(sessionKey(deviceSessionId)),
      this.redis.setex(tombstoneKey(deviceSessionId), ttl, '1'),
    ]);
  }

  /** Batched counterpart to `invalidate` — one round trip for every session
   *  instead of N sequential ones (logout-all / bulk device revocation). */
  async invalidateMany(deviceSessionIds: string[]): Promise<void> {
    if (deviceSessionIds.length === 0) return;
    const ttl = this.config.sessionCacheTtlSeconds;
    const pipeline = this.redis.pipeline();
    pipeline.del(...deviceSessionIds.map(sessionKey));
    for (const id of deviceSessionIds) {
      pipeline.setex(tombstoneKey(id), ttl, '1');
    }
    await pipeline.exec();
  }

  async invalidateAllForUser(userFk: string): Promise<void> {
    const sessions = await this.db
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.userFk, userFk));
    if (!sessions.length) return;
    await this.invalidateMany(sessions.map((s) => s.id));
  }
}