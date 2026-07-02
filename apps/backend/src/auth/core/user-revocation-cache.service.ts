import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type Redis from 'ioredis';
import { DRIZZLE } from '../../db/db.module.js';
import * as schema from '../../db/schema.js';
import { users } from '../../db/schema.js';
import { CORE_REDIS } from './core.tokens.js';

const TTL_SECONDS = 5;
const KEY = (userId: string) => `user_deleted:${userId}`;

@Injectable()
export class UserRevocationCacheService {
  constructor(
    @Inject(DRIZZLE)     private readonly db:    PostgresJsDatabase<typeof schema>,
    @Inject(CORE_REDIS)  private readonly redis:  Redis,
  ) {}

  async isDeleted(userId: string): Promise<boolean> {
    try {
      const cached = await this.redis.get(KEY(userId));
      if (cached !== null) return cached === '1';

      const [row] = await this.db
        .select({ deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, userId));

      const deleted = !row || row.deletedAt !== null;
      await this.redis.setex(KEY(userId), TTL_SECONDS, deleted ? '1' : '0');
      return deleted;
    } catch {
      // On any failure, deny access (conservative default per §12.5)
      return true;
    }
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(KEY(userId));
  }
}
