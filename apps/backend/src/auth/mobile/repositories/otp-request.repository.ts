import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { otpRequests } from '#db/schema.js';

export type OtpPurpose = 'login' | 'signup' | 'step_up';
export type OtpRequest = typeof otpRequests.$inferSelect;

@Injectable()
export class OtpRequestRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async insert(data: {
    phone:       string;
    purpose:     OtpPurpose;
    maxAttempts: number;
    expiresAt:   Date;
  }, tx?: DbExecutor): Promise<OtpRequest> {
    const [row] = await (tx ?? this.db).insert(otpRequests).values(data).returning();
    return row!;
  }

  async findActiveRequest(id: string, phone: string): Promise<OtpRequest | null> {
    const [row] = await this.db
      .select()
      .from(otpRequests)
      .where(and(
        eq(otpRequests.id, id),
        eq(otpRequests.phone, phone),
        isNull(otpRequests.consumedAt),
        gt(otpRequests.expiresAt, new Date()),
      ));
    return row ?? null;
  }

  async findById(id: string): Promise<OtpRequest | null> {
    const [row] = await this.db
      .select()
      .from(otpRequests)
      .where(eq(otpRequests.id, id));
    return row ?? null;
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.db
      .update(otpRequests)
      .set({ attempts: sql`${otpRequests.attempts} + 1` })
      .where(eq(otpRequests.id, id));
  }

  async markConsumed(id: string): Promise<void> {
    await this.db
      .update(otpRequests)
      .set({ consumedAt: new Date() })
      .where(eq(otpRequests.id, id));
  }
}
