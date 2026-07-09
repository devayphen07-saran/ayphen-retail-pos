import { Inject, Injectable } from '@nestjs/common';
import { lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { loginAttempts, rateLimitFallbackCounters } from '#db/schema.js';

@Injectable()
export class RateLimitRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /**
   * Atomic fixed-window increment for the Redis-outage fallback path — the
   * Postgres analog of the Redis path's INCR+EXPIRE Lua script
   * (rate-limit.service.ts's INCR_WITH_TTL_LUA). A plain "SELECT COUNT then
   * let the caller decide" is a check-then-act race: two concurrent requests
   * during the SAME outage can both read a stale under-limit count before
   * either's attempt is durably recorded. `INSERT ... ON CONFLICT DO UPDATE`
   * is a single atomic statement — Postgres serializes concurrent upserts to
   * the same (key, windowStart) row, so the returned count is always exact.
   */
  async incrementFallbackWindow(key: string, windowStart: Date): Promise<number> {
    const [row] = await this.db
      .insert(rateLimitFallbackCounters)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitFallbackCounters.key, rateLimitFallbackCounters.windowStart],
        set: { count: sql`${rateLimitFallbackCounters.count} + 1` },
      })
      .returning({ count: rateLimitFallbackCounters.count });
    return row?.count ?? 1;
  }

  /** Retention cleanup: drop login attempts older than `cutoff`. Returns the
   *  number of rows removed. Idempotent date-bounded delete (safe to overlap). */
  async deleteAttemptsOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(loginAttempts)
      .where(lt(loginAttempts.createdAt, cutoff))
      .returning({ id: loginAttempts.id });
    return deleted.length;
  }

  /** Retention cleanup for the Redis-outage fallback counters (tiny in practice). */
  async deleteFallbackCountersOlderThan(cutoff: Date): Promise<void> {
    await this.db
      .delete(rateLimitFallbackCounters)
      .where(lt(rateLimitFallbackCounters.windowStart, cutoff));
  }

  async insert(entry: {
    ip:      string;
    userId?: string;
    email?:  string;
    phone?:  string;
    purpose: string;
    success: boolean;
  }): Promise<void> {
    await this.db.insert(loginAttempts).values({
      ip:      entry.ip,
      userId:  entry.userId,
      email:   entry.email,
      phone:   entry.phone,
      purpose: entry.purpose,
      success: entry.success,
    });
  }
}
