import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import Redis from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../../../db/db.module.js';
import * as schema from '../../../db/schema.js';
import { revokedTokens } from '../../../db/schema.js';
import { MOBILE_REDIS } from './redis.provider.js';

const jtiKey = (jti: string) => `jti:${jti}`;

@Injectable()
export class BlacklistCacheService {
  private readonly lru = new LRUCache<string, boolean>({ max: 10_000 });

  constructor(
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE)      private readonly db:    PostgresJsDatabase<typeof schema>,
  ) {}

  async addToBlacklist(jti: string, exp: Date): Promise<void> {
    const ttl = Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1000));
    this.lru.set(jti, true, { ttl: ttl * 1000 });
    await this.redis.setex(jtiKey(jti), ttl, '1');
    await this.db
      .insert(revokedTokens)
      .values({ jti, expiresAt: exp })
      .onConflictDoNothing();
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    if (this.lru.has(jti)) return true;

    const cached = await this.redis.get(jtiKey(jti));
    if (cached !== null) {
      this.lru.set(jti, true);
      return true;
    }

    const [row] = await this.db
      .select()
      .from(revokedTokens)
      .where(eq(revokedTokens.jti, jti));

    if (row) {
      const ttl = Math.max(0, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000));
      await this.redis.setex(jtiKey(jti), ttl, '1');
      this.lru.set(jti, true, { ttl: ttl * 1000 });
      return true;
    }
    return false;
  }
}
