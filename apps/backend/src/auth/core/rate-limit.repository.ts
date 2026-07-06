import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { loginAttempts } from '#db/schema.js';

@Injectable()
export class RateLimitRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async countIpAttempts(ip: string): Promise<number> {
    const [row] = await this.db
      .select({ cnt: count() })
      .from(loginAttempts)
      .where(and(
        eq(loginAttempts.ip, ip),
        gt(loginAttempts.createdAt, sql`NOW() - INTERVAL '1 minute'`),
      ));
    return row?.cnt ?? 0;
  }

  async countPhoneOtpAttempts(phone: string): Promise<number> {
    const [row] = await this.db
      .select({ cnt: count() })
      .from(loginAttempts)
      .where(and(
        eq(loginAttempts.phone, phone),
        inArray(loginAttempts.purpose, ['login', 'signup', 'step_up']),
        gt(loginAttempts.createdAt, sql`NOW() - INTERVAL '5 minutes'`),
      ));
    return row?.cnt ?? 0;
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
