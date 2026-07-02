import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../../../db/db.module.js';
import * as schema from '../../../db/schema.js';
import { deviceSessions } from '../../../db/schema.js';
import { MOBILE_REDIS } from './redis.provider.js';

const sessionKey = (id: string) => `session:${id}`;

@Injectable()
export class SessionCacheInvalidatorService {
  constructor(
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async invalidate(deviceSessionId: string): Promise<void> {
    await this.redis.del(sessionKey(deviceSessionId));
  }

  async invalidateAllForUser(userFk: string): Promise<void> {
    const sessions = await this.db
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.userFk, userFk));
    if (!sessions.length) return;
    await this.redis.del(...sessions.map((s) => sessionKey(s.id)));
  }
}
