import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import Redis from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { revokedTokens } from '#db/schema.js';
import { REDIS } from '#common/redis/redis.provider.js';

const jtiKey = (jti: string) => `jti:${jti}`;
const negKey = (jti: string) => `jti:neg:${jti}`;
const NEG_CACHE_TTL_SECONDS = 30;

@Injectable()
export class BlacklistCacheService {
  private readonly logger = new Logger(BlacklistCacheService.name);
  private readonly lru = new LRUCache<string, boolean>({ max: 10_000 });

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async addToBlacklist(jti: string, exp: Date): Promise<void> {
    const ttl = this.secondsUntil(exp);

    // Durable record first. Redis is only an acceleration layer.
    await this.db
      .insert(revokedTokens)
      .values({ jti, expiresAt: exp })
      .onConflictDoNothing();

    // Drop any negative-cache entry so this now-revoked jti isn't masked by a
    // stale "not revoked" marker within its short TTL.
    try { await this.redis.del(negKey(jti)); } catch { /* best-effort */ }

    // Expired tokens are already invalid by JWT verification. Do not write
    // them to Redis because SETEX rejects ttl <= 0.
    if (ttl <= 0) return;

    this.lru.set(jti, true, { ttl: ttl * 1000 });

    try {
      await this.redis.setex(jtiKey(jti), ttl, '1');
    } catch (err) {
      this.logger.warn(`Failed to cache blacklisted JTI in Redis: ${this.errorMessage(err)}`);
    }
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    if (this.lru.has(jti)) return true;

    const redisTtl = await this.getRedisTtlSeconds(jti);
    if (redisTtl > 0) {
      this.lru.set(jti, true, { ttl: redisTtl * 1000 });
      return true;
    }

    // Negative cache: a recent DB miss means "not revoked" — skip the DB hit on
    // the hot path (the common valid-token case). addToBlacklist() clears this.
    try {
      if (await this.redis.get(negKey(jti))) return false;
    } catch { /* fall through to DB */ }

    const [row] = await this.db
      .select()
      .from(revokedTokens)
      .where(eq(revokedTokens.jti, jti));

    if (!row) {
      try { await this.redis.setex(negKey(jti), NEG_CACHE_TTL_SECONDS, '0'); } catch { /* best-effort */ }
      return false;
    }

    const ttl = this.secondsUntil(row.expiresAt);

    // Historical expired revocation rows should not blacklist future checks.
    // JWT expiration itself is responsible for rejecting expired tokens.
    if (ttl <= 0) return false;

    this.lru.set(jti, true, { ttl: ttl * 1000 });

    try {
      await this.redis.setex(jtiKey(jti), ttl, '1');
    } catch (err) {
      this.logger.warn(`Failed to warm blacklisted JTI Redis cache: ${this.errorMessage(err)}`);
    }

    return true;
  }

  private async getRedisTtlSeconds(jti: string): Promise<number> {
    try {
      const key = jtiKey(jti);
      const cached = await this.redis.get(key);
      if (cached === null) return 0;

      const ttl = await this.redis.ttl(key);

      // ttl === -2: key no longer exists
      // ttl === -1: key exists but has no expiry; do not trust it forever
      if (ttl <= 0) return 0;

      return ttl;
    } catch (err) {
      this.logger.warn(`Failed to read blacklisted JTI from Redis: ${this.errorMessage(err)}`);
      return 0;
    }
  }

  private secondsUntil(date: Date): number {
    return Math.floor((date.getTime() - Date.now()) / 1000);
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}